import numpy as np
from sqlmodel import Session, select

from app.models import Chunk


def to_blob(vec: list[float]) -> bytes:
    return np.asarray(vec, dtype=np.float32).tobytes()


def from_blob(blob: bytes) -> np.ndarray:
    return np.frombuffer(blob, dtype=np.float32)


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
