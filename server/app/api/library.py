from pathlib import Path

from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import FileResponse, Response
from sqlalchemy import func
from sqlmodel import Session, select

from app import db
from app.core import media
from app.core import summary as summary_core
from app.core.pages import merge_page_chunks, snippet_around
from app.core.store import search_text
from app.models import Chunk, Material
from app.schemas import MaterialPagesRead, PageOut, SearchHit, SearchRead, SummaryRead

router = APIRouter(tags=["library"])


@router.get("/materials/{material_id}/pages", response_model=MaterialPagesRead)
def material_pages(
    material_id: int,
    offset: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
) -> MaterialPagesRead:
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        max_page = session.exec(
            select(func.max(Chunk.page)).where(Chunk.material_id == material_id)
        ).one()
        page_count = max_page or 0
        lo = offset + 1
        hi = min(offset + limit, page_count)
        rows = (
            session.exec(
                select(Chunk)
                .where(
                    Chunk.material_id == material_id,
                    Chunk.page >= lo,
                    Chunk.page <= hi,
                )
                .order_by(Chunk.seq)
            ).all()
            if hi >= lo
            else []
        )
        merged = merge_page_chunks(list(rows))
        pages = [PageOut(page=p, text=merged.get(p, "")) for p in range(lo, hi + 1)]
        return MaterialPagesRead(
            material_id=material_id,
            filename=material.filename,
            page_count=page_count,
            offset=offset,
            limit=limit,
            pages=pages,
        )


@router.get("/materials/{material_id}/page-image")
def material_page_image(
    material_id: int,
    page: int = Query(1, ge=1),
    zoom: float = Query(2.0, ge=0.5, le=4.0),
) -> Response:
    """材料某一页的原页图。

    - 图片材料 / 文档内嵌图片：直接返回该图片文件；
    - PDF：按页渲染为 PNG（用于查看电路图等一图胜千言的内容）。
    """
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        path, filename = material.stored_path, material.filename
        image = media.image_map(material.pages).get(page)
    if image is not None:
        if not Path(image).exists():
            raise HTTPException(404, "该页图片文件已丢失，请重新上传材料")
        return FileResponse(
            image,
            media_type=media.media_type_for(image),
            headers={"Cache-Control": "public, max-age=3600"},
        )
    if Path(path).suffix.lower() != ".pdf":
        raise HTTPException(400, f"{filename} 不是 PDF，且该页没有图片")
    try:
        content = media.render_page_png(path, page, zoom)
    except ValueError as exc:
        raise HTTPException(404, str(exc)) from exc
    return Response(
        content=content,
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.get("/materials/{material_id}/summary", response_model=SummaryRead)
def material_summary(material_id: int) -> SummaryRead:
    """材料的学习笔记：整体总结 + 知识点列表（含页码，供跳转原页）。"""
    with Session(db.engine) as session:
        if session.get(Material, material_id) is None:
            raise HTTPException(404, "材料不存在")
        data = summary_core.load_summary(session, material_id)
        return SummaryRead(**data)


@router.post("/materials/{material_id}/summary", status_code=202)
def regenerate_summary(material_id: int, background: BackgroundTasks) -> dict[str, str]:
    """重新生成总结（内容更新或失败后手动重试）。"""
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
    if summary_core.job_status(material_id)["status"] == "generating":
        return {"status": "generating"}
    background.add_task(summary_core.generate_summary, material_id)
    return {"status": "accepted"}


@router.get("/courses/{course_id}/search", response_model=SearchRead)
def search_course(
    course_id: int,
    q: str = Query(min_length=1, max_length=200),
    limit: int = Query(30, ge=1, le=100),
) -> SearchRead:
    query = q.strip()
    if not query:
        raise HTTPException(400, "搜索词不能为空")
    with Session(db.engine) as session:
        rows = search_text(session, course_id, query, limit)
        names = {
            m.id: m.filename
            for m in session.exec(select(Material).where(Material.course_id == course_id)).all()
        }
        hits = [
            SearchHit(
                material_id=c.material_id,
                material=names.get(c.material_id, "未知材料"),
                page=c.page,
                snippet=snippet_around(c.text, query),
            )
            for c in rows
        ]
        return SearchRead(query=query, hits=hits)
