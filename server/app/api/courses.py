import time
from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, UploadFile
from sqlmodel import Session, select

from app import db
from app.config import settings
from app.core.ingest import ingest_material
from app.models import Course, Material
from app.schemas import CourseCreate, CourseRead, MaterialRead

router = APIRouter(tags=["courses"])

SUPPORTED_SUFFIXES = {".pdf", ".pptx", ".txt", ".md"}


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
def list_materials(course_id: int) -> list[Material]:
    with Session(db.engine) as session:
        return list(
            session.exec(
                select(Material).where(Material.course_id == course_id).order_by(Material.id)
            ).all()
        )


@router.post("/courses/{course_id}/materials", response_model=MaterialRead)
async def upload_material(
    course_id: int, file: UploadFile, background_tasks: BackgroundTasks
) -> Material:
    filename = Path(file.filename or "untitled").name  # 防路径穿越
    suffix = Path(filename).suffix.lower()
    if suffix not in SUPPORTED_SUFFIXES:
        raise HTTPException(400, f"暂不支持 {suffix or '该'} 类型，请上传 PDF / PPTX / TXT / MD")
    with Session(db.engine) as session:
        if session.get(Course, course_id) is None:
            raise HTTPException(404, "课程不存在")
        target_dir = settings.data_dir / "materials" / str(course_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / filename
        if target.exists():
            target = target_dir / f"{Path(filename).stem}-{int(time.time())}{suffix}"
        target.write_bytes(await file.read())
        material = Material(course_id=course_id, filename=target.name, stored_path=str(target))
        session.add(material)
        session.commit()
        session.refresh(material)
    background_tasks.add_task(ingest_material, material.id)
    return material
