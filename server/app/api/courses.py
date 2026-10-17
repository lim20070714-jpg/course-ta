import shutil
import time
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, Form, HTTPException, UploadFile
from sqlalchemy import func
from sqlmodel import Session, delete, select

from app import db
from app.config import settings
from app.core import media
from app.core import problems as problems_core
from app.core import summary as summary_core
from app.core.ingest import ingest_material
from app.core.kinds import VALID_KINDS, detect_kind
from app.models import Chunk, Concept, Course, Material, Problem, Summary
from app.schemas import (
    CourseCreate,
    CourseRead,
    CourseUpdate,
    MaterialDeleteResult,
    MaterialRead,
    MaterialUpdate,
)

router = APIRouter(tags=["courses"])

SUPPORTED_SUFFIXES = {".pdf", ".pptx", ".docx", ".txt", ".md"} | media.IMAGE_SUFFIXES
_FORMAT_HINT = "PDF / PPTX / DOCX / TXT / MD / 图片（PNG / JPG / WEBP / GIF / BMP / TIFF）"
MAX_COURSE_NAME = 60
MAX_MATERIAL_NAME = 120
# Windows 不允许出现在文件名里的字符；'/' 与 '\\' 会被 Path().name 当成分隔符吃掉。
# 注意别写成 '<>:"|?*\x00-\x1f'：普通字符串里 \x00-\x1f 是三个字符（含连字符 '-'），会把正常文件名误判为非法。
CONTROL_CHARS = {chr(code) for code in range(0x20)}
ILLEGAL_NAME_CHARS = set('<>:"|?*') | CONTROL_CHARS


def normalize_material_name(raw: str) -> str:
    """把用户给的资料名收成可安全落盘的文件名（剥掉目录成分、校验后缀与长度）。"""
    name = Path(raw.strip()).name
    if not name or name in {".", ".."}:
        raise HTTPException(400, "资料名不能为空")
    if len(name) > MAX_MATERIAL_NAME:
        raise HTTPException(400, f"资料名最长 {MAX_MATERIAL_NAME} 个字符")
    if any(ch in name for ch in ILLEGAL_NAME_CHARS):
        raise HTTPException(400, '资料名不能包含 < > : " | ? * 等字符')
    if Path(name).suffix.lower() not in SUPPORTED_SUFFIXES:
        raise HTTPException(400, f"资料名要保留原来的类型后缀（{_FORMAT_HINT}）")
    return name


def normalize_course_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(400, "课程名不能为空")
    if len(name) > MAX_COURSE_NAME:
        raise HTTPException(400, f"课程名最长 {MAX_COURSE_NAME} 个字")
    return name


def is_busy(material: Material) -> bool:
    """后台是否还在动这份资料的原件或派生数据（入库 / 总结 / 拆题）。"""
    material_id = material.id or 0
    return (
        material.status in ("pending", "ingesting")
        or summary_core.job_status(material_id)["status"] == "generating"
        or problems_core.job_status(material_id)["status"] == "running"
    )


def rename_on_disk(material: Material, new_name: str) -> None:
    """把磁盘原件一起改名；原件已被外部删掉时只改显示名，不把改名失败当成接口失败。"""
    old = Path(material.stored_path)
    if not old.exists():
        return
    target = old.with_name(new_name)
    if target.exists():  # 目录里躺着不属于任何 Material 的同名文件
        raise HTTPException(409, f"资料目录里已存在同名文件：{new_name}")
    old.replace(target)
    material.stored_path = str(target)


def material_read(material: Material, text_pages: int = 0) -> MaterialRead:
    """把 Material 转成对外模型，附上总页数与可查看原页图的页码。

    `text_pages` 为该材料的最大页码（来自 Chunk），用于图文混排时得到正确总页数。
    """
    image_pages = media.image_page_numbers(material.pages)
    return MaterialRead(
        id=material.id,
        course_id=material.course_id,
        filename=material.filename,
        kind=material.kind,
        status=material.status,
        error=material.error,
        chunk_count=material.chunk_count,
        page_count=max(text_pages, max(image_pages, default=0)),
        image_pages=image_pages,
    )


@router.post("/courses", response_model=CourseRead)
def create_course(payload: CourseCreate) -> Course:
    name = normalize_course_name(payload.name)
    with Session(db.engine) as session:
        course = Course(name=name, description=payload.description)
        session.add(course)
        session.commit()
        session.refresh(course)
        return course


@router.get("/courses", response_model=list[CourseRead])
def list_courses() -> list[Course]:
    with Session(db.engine) as session:
        return list(session.exec(select(Course).order_by(Course.id)).all())


@router.patch("/courses/{course_id}", response_model=CourseRead)
def update_course(course_id: int, payload: CourseUpdate) -> Course:
    """改课程名或简介。课程名会出现在顶栏、模考试卷与导出物里，改名不做级联重写。"""
    if payload.name is None and payload.description is None:
        raise HTTPException(400, "没有要修改的字段（name 或 description）")
    with Session(db.engine) as session:
        course = session.get(Course, course_id)
        if course is None:
            raise HTTPException(404, "课程不存在")
        if payload.name is not None:
            course.name = normalize_course_name(payload.name)
        if payload.description is not None:
            course.description = payload.description.strip()
        session.add(course)
        session.commit()
        session.refresh(course)
        return course


@router.get("/courses/{course_id}/materials", response_model=list[MaterialRead])
def list_materials(course_id: int) -> list[MaterialRead]:
    with Session(db.engine) as session:
        rows = session.exec(
            select(Material).where(Material.course_id == course_id).order_by(Material.id)
        ).all()
        max_pages = dict(
            session.exec(
                select(Chunk.material_id, func.max(Chunk.page))
                .where(Chunk.course_id == course_id)
                .group_by(Chunk.material_id)
            ).all()
        )
        return [material_read(m, max_pages.get(m.id, 0) or 0) for m in rows]


@router.post("/courses/{course_id}/materials", response_model=MaterialRead)
async def upload_material(
    course_id: int,
    file: UploadFile,
    background_tasks: BackgroundTasks,
    kind: str = Form("auto"),
) -> MaterialRead:
    filename = Path(file.filename or "untitled").name  # 防路径穿越
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(400, f"暂不支持 {suffix or '该'} 类型，请上传 {_FORMAT_HINT}")
    if kind != "auto" and kind not in VALID_KINDS:
        raise HTTPException(400, f"未知材料类型：{kind}")
    resolved_kind = detect_kind(filename) if kind == "auto" else kind
    with Session(db.engine) as session:
        if session.get(Course, course_id) is None:
            raise HTTPException(404, "课程不存在")
        target_dir = settings.data_dir / "materials" / str(course_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / filename
        if target.exists():
            target = target_dir / f"{Path(filename).stem}-{int(time.time())}{suffix}"
        target.write_bytes(await file.read())
        material = Material(
            course_id=course_id,
            filename=target.name,
            stored_path=str(target),
            kind=resolved_kind,
        )
        session.add(material)
        session.commit()
        session.refresh(material)
    background_tasks.add_task(ingest_material, material.id)
    if resolved_kind == "exam":  # 试题入库后自动切割题目（不做知识总结）
        background_tasks.add_task(problems_core.run_extraction, material.id)
    return material_read(material)


@router.patch("/materials/{material_id}", response_model=MaterialRead)
def update_material(material_id: int, payload: MaterialUpdate) -> MaterialRead:
    """改资料类型或资料名。

    资料名既是界面显示名，也是磁盘上原件的文件名，所以改名会把
    `data/materials/{course_id}/{filename}` 一起重命名并让 `stored_path` 跟着走——
    原件还被后台任务读着时先返回 409，避免改名与入库/拆题抢同一个文件。
    类型是人工选定的标签，改名不会按后缀重新判定它。
    """
    if payload.kind is None and payload.filename is None:
        raise HTTPException(400, "没有要修改的字段（kind 或 filename）")
    kind: str | None = None
    if payload.kind is not None:
        kind = payload.kind.strip()
        if kind not in VALID_KINDS:
            raise HTTPException(400, f"未知材料类型：{kind}")
    new_name: str | None = None
    if payload.filename is not None:
        new_name = normalize_material_name(payload.filename)

    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        if new_name is not None and new_name != material.filename:
            if is_busy(material):
                raise HTTPException(
                    409, "这份资料还在后台处理（入库 / 总结 / 拆题），等它完成后再改名。"
                )
            duplicated = session.exec(
                select(Material)
                .where(Material.course_id == material.course_id)
                .where(Material.filename == new_name)
                .where(Material.id != material_id)
            ).first()
            if duplicated is not None:
                raise HTTPException(409, f"这门课里已经有同名资料：{new_name}")
            rename_on_disk(material, new_name)
            material.filename = new_name
        if kind is not None:
            material.kind = kind
        session.add(material)
        session.commit()
        session.refresh(material)
        # 页数与列表口径一致：来自 Chunk 的最大页码，而不是 Material 表里的 0
        max_page = session.exec(
            select(func.max(Chunk.page)).where(Chunk.material_id == material_id)
        ).one()
        return material_read(material, max_page or 0)


@router.delete("/materials/{material_id}", response_model=MaterialDeleteResult)
def delete_material(material_id: int) -> MaterialDeleteResult:
    """删除一份资料：知识块、总结与磁盘上的原件/原页图一起清掉。

    从它抽出来的题目**保留**（只断开来源）：题目上挂着作答记录、错题本、复习卡与
    模考引用，连着删就是删掉学习历史；代价是这些题不再有「原题原页图」。
    图谱概念的出处同理置空，脉络本身不动。

    后台处理中不允许删：解析/拆题/总结任务会在删除之后把结果写回来，留下无主的孤儿数据。
    """
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        if is_busy(material):
            raise HTTPException(409, "这份资料还在后台处理（入库 / 总结 / 拆题），等它完成后再删除。")

        chunks_removed = session.exec(
            select(func.count(Chunk.id)).where(Chunk.material_id == material_id)
        ).one()
        problems_kept = session.exec(
            select(func.count(Problem.id)).where(Problem.material_id == material_id)
        ).one()
        stored_path = material.stored_path
        session.exec(delete(Chunk).where(Chunk.material_id == material_id))
        session.exec(delete(Summary).where(Summary.material_id == material_id))
        for problem in session.exec(
            select(Problem).where(Problem.material_id == material_id)
        ).all():
            problem.material_id = None
            session.add(problem)
        for concept in session.exec(
            select(Concept).where(Concept.material_id == material_id)
        ).all():
            concept.material_id = None
            session.add(concept)
        filename = material.filename
        session.delete(material)
        session.commit()

    Path(stored_path).unlink(missing_ok=True)
    shutil.rmtree(media.media_dir(settings.data_dir, material_id), ignore_errors=True)
    return MaterialDeleteResult(
        filename=filename,
        chunks_removed=int(chunks_removed),
        problems_kept=int(problems_kept),
    )
