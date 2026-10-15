from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import func
from sqlmodel import Session, select

from app import db
from app.core.pages import merge_page_chunks, snippet_around
from app.core.store import search_text
from app.models import Chunk, Material
from app.schemas import MaterialPagesRead, PageOut, SearchHit, SearchRead

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
