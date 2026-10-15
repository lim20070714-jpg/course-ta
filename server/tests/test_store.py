from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.core.store import search_chunks, to_blob
from app.models import Chunk


def _memory_session() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_search_orders_by_similarity_and_filters_course() -> None:
    with _memory_session() as session:
        session.add_all(
            [
                Chunk(
                    course_id=1,
                    material_id=1,
                    page=1,
                    seq=0,
                    text="apple",
                    embedding=to_blob([1.0, 0.0, 0.0]),
                ),
                Chunk(
                    course_id=1,
                    material_id=1,
                    page=2,
                    seq=1,
                    text="banana",
                    embedding=to_blob([0.0, 1.0, 0.0]),
                ),
                Chunk(
                    course_id=1,
                    material_id=1,
                    page=3,
                    seq=2,
                    text="cherry",
                    embedding=to_blob([0.5, 0.5, 0.0]),
                ),
                Chunk(
                    course_id=2,
                    material_id=2,
                    page=1,
                    seq=0,
                    text="other",
                    embedding=to_blob([1.0, 0.0, 0.0]),
                ),
            ]
        )
        session.commit()
        hits = search_chunks(session, 1, [1.0, 0.1, 0.0], top_k=2)
        assert [chunk.text for chunk, _ in hits] == ["apple", "cherry"]


def test_search_empty_course() -> None:
    with _memory_session() as session:
        assert search_chunks(session, 99, [1.0, 0.0, 0.0], top_k=3) == []
