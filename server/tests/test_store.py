from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.core.store import keyword_search_chunks, query_terms, search_chunks, to_blob
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


def test_keyword_search_prefers_rare_terms_over_common_ones() -> None:
    with _memory_session() as session:
        session.add_all(
            [
                Chunk(course_id=1, material_id=1, page=1, seq=0, text="电路分析的基本方法"),
                Chunk(course_id=1, material_id=1, page=2, seq=1, text="电路中的节点电压法"),
                Chunk(course_id=1, material_id=1, page=3, seq=2, text="电路与器件概述"),
                Chunk(course_id=2, material_id=2, page=1, seq=0, text="节点电压法在另一门课"),
            ]
        )
        session.commit()
        hits = keyword_search_chunks(session, 1, "节点电压法", top_k=2)
        assert [chunk.page for chunk, _ in hits] == [2]
        assert hits[0][1] > 0


def test_keyword_search_needs_no_embeddings() -> None:
    with _memory_session() as session:
        session.add(Chunk(course_id=1, material_id=1, page=1, seq=0, text="MOSFET 的饱和区"))
        session.commit()
        assert [c.page for c, _ in keyword_search_chunks(session, 1, "mosfet", top_k=3)] == [1]
        assert keyword_search_chunks(session, 1, "无关内容", top_k=3) == []


def test_query_terms_splits_latin_words_and_chinese_bigrams() -> None:
    assert query_terms("MOSFET 饱和区") == ["mosfet", "饱和", "和区"]
    assert query_terms("电") == ["电"]
    assert query_terms("") == []
