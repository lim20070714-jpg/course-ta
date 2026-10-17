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
    MaterialDeleteResult,
    MaterialKindUpdate,
    MaterialRead,
)

router = APIRouter(tags=["courses"])

SUPPORTED_SUFFIXES = {".pdf", ".pptx", ".docx", ".txt", ".md"} | media.IMAGE_SUFFIXES
_FORMAT_HINT = "PDF / PPTX / DOCX / TXT / MD / 图片（PNG / JPG / WEBP / GIF / BMP / TIFF）"


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
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "课程名不能为空")
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
def update_material_kind(material_id: int, payload: MaterialKindUpdate) -> Material:
    kind = payload.kind.strip()
    if kind not in VALID_KINDS:
        raise HTTPException(400, f"未知材料类型：{kind}")
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        material.kind = kind
        session.add(material)
        session.commit()
        session.refresh(material)
        return material


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
        busy = material.status in ("pending", "ingesting")
        busy = busy or summary_core.job_status(material_id)["status"] == "generating"
        busy = busy or problems_core.job_status(material_id)["status"] == "running"
        if busy:
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
