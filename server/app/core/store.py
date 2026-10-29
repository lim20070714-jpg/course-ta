import math
import re

import numpy as np
from sqlmodel import Session, select

from app.models import Chunk


def to_blob(vec: list[float]) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


def search_text(session: Session, course_id: int, query: str, limit: int) -> list[Chunk]:
    """课程内全文子串检索（大小写不敏感），按材料与页码顺序返回。"""
    stmt = (
        select(Chunk)
        .where(Chunk.course_id == course_id, Chunk.text.ilike(f"%{query}%"))
        .order_by(Chunk.material_id, Chunk.page, Chunk.seq)
        .limit(limit)
    )
    return list(session.exec(stmt).all())


def query_terms(query: str, limit: int = 32) -> list[str]:
    """把查询切成检索词：拉丁词按词切，中文按相邻两字切，中文无需分词器。"""
    lowered = query.lower()
    words = re.findall(r"[a-z0-9]{2,}", lowered)
    grams = [
        run[i : i + 2]
        for run in re.findall(r"[\u4e00-\u9fff]+", lowered)
        for i in range(max(1, len(run) - 1))
    ]
    return list(dict.fromkeys(words + grams))[:limit]


def keyword_search_chunks(
    session: Session, course_id: int, query: str, top_k: int
) -> list[tuple[Chunk, float]]:
    """课程内词频检索，向量模型不可用时的降级路径。

    打分是 BM25 的简化版：稀有词权重更高（idf），同一词重复出现的收益递减，
    因此「电路」这类高频词不会把结果带偏。
    """
    terms = query_terms(query)
    rows = [(r, r.text.lower()) for r in session.exec(
        select(Chunk).where(Chunk.course_id == course_id)
    ).all()]
    if not terms or not rows:
        return []
    total = len(rows)
    df = {t: sum(1 for _, text in rows if t in text) for t in terms}
    scored: list[tuple[Chunk, float]] = []
    for row, text in rows:
        score = 0.0
        for term in terms:
            if not df[term] or term not in text:
                continue
            tf = text.count(term)
            score += math.log(1 + total / df[term]) * tf / (tf + 1.5)
        if score > 0:
            scored.append((row, score))
    scored.sort(key=lambda pair: (-pair[1], pair[0].material_id, pair[0].page, pair[0].seq))
    return scored[:top_k]


def search_chunks(
    session: Session, course_id: int, query_vec: list[float], top_k: int
) -> list[tuple[Chunk, float]]:
    """课程内余弦相似度检索。v0.1 规模（数万块以内）暴力检索足够快，后续可平滑迁移到 pgvector。"""
    rows = [
        r
        for r in session.exec(select(Chunk).where(Chunk.course_id == course_id)).all()
        if r.embedding
    ]
    if not rows:
        return []
    matrix = np.vstack([from_blob(r.embedding) for r in rows])
    query = np.asarray(query_vec, dtype=np.float32)
    matrix = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-12)
    query = query / (np.linalg.norm(query) + 1e-12)
    scores = matrix @ query
    order = np.argsort(-scores)[:top_k]
    return [(rows[i], float(scores[i])) for i in order]
