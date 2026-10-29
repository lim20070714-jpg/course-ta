import asyncio

from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.core import llm, rag
from app.core.store import search_text
from app.models import Chunk, Material


def _memory_session() -> Session:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return Session(engine)


def test_search_text_filters_course_and_matches_substring() -> None:
    with _memory_session() as session:
        session.add_all(
            [
                Chunk(course_id=1, material_id=1, page=3, seq=0, text="KVL 闭合回路电压总和为零"),
                Chunk(course_id=1, material_id=1, page=5, seq=1, text="Thevenin 等效电路"),
                Chunk(course_id=2, material_id=2, page=1, seq=0, text="KVL 出现在别的课程"),
            ]
        )
        session.commit()
        hits = search_text(session, 1, "KVL", 10)
        assert [(c.course_id, c.page) for c in hits] == [(1, 3)]


def test_search_text_is_case_insensitive_for_ascii() -> None:
    with _memory_session() as session:
        session.add(Chunk(course_id=1, material_id=1, page=1, seq=0, text="MOSFET 饱和区"))
        session.commit()
        assert len(search_text(session, 1, "mosfet", 10)) == 1


def test_search_text_orders_and_limits() -> None:
    with _memory_session() as session:
        session.add_all(
            [
                Chunk(course_id=1, material_id=2, page=1, seq=0, text="电阻电阻"),
                Chunk(course_id=1, material_id=1, page=9, seq=0, text="电阻是什么"),
                Chunk(course_id=1, material_id=1, page=2, seq=1, text="关于电阻"),
            ]
        )
        session.commit()
        hits = search_text(session, 1, "电阻", 2)
        assert [(c.material_id, c.page) for c in hits] == [(1, 2), (1, 9)]


def test_search_text_no_match() -> None:
    with _memory_session() as session:
        session.add(Chunk(course_id=1, material_id=1, page=1, seq=0, text="电容电感"))
        session.commit()
        assert search_text(session, 1, "三极管", 10) == []


def test_retrieve_falls_back_to_keywords_when_embeddings_are_down(monkeypatch) -> None:
    async def boom(texts: list[str]) -> list[list[float]]:
        raise llm.LLMNotConfigured("余额不足")

    monkeypatch.setattr(llm, "embed", boom)
    with _memory_session() as session:
        session.add_all(
            [
                Material(course_id=1, filename="讲义.pdf", stored_path="x", kind="pdf"),
                Chunk(course_id=1, material_id=1, page=4, seq=0, text="节点电压法的步骤"),
                Chunk(course_id=1, material_id=1, page=7, seq=1, text="无关的热学内容"),
            ]
        )
        session.commit()
        hits = asyncio.run(rag.retrieve(session, 1, "节点电压法", top_k=3))
    assert [h["page"] for h in hits] == [4]
    assert hits[0]["retrieval"] == "keyword"
    assert hits[0]["material"] == "讲义.pdf"


def test_retrieval_mode_keyword_never_calls_embeddings(monkeypatch) -> None:
    called: list[int] = []

    async def spy(texts: list[str]) -> list[list[float]]:
        called.append(1)
        return [[0.0]]

    monkeypatch.setattr(llm, "embed", spy)
    monkeypatch.setattr(rag.settings, "retrieval_mode", "keyword")
    with _memory_session() as session:
        session.add(
            Chunk(course_id=1, material_id=1, page=2, seq=0, text="叠加定理的适用条件")
        )
        session.commit()
        hits = asyncio.run(rag.retrieve(session, 1, "叠加定理", top_k=2))
    assert [h["retrieval"] for h in hits] == ["keyword"]
    assert called == [], "keyword 模式不应调用向量模型"


def test_retrieval_mode_vector_propagates_failure(monkeypatch) -> None:
    async def boom(texts: list[str]) -> list[list[float]]:
        raise llm.LLMNotConfigured("没配向量模型")

    monkeypatch.setattr(llm, "embed", boom)
    monkeypatch.setattr(rag.settings, "retrieval_mode", "vector")
    with _memory_session() as session:
        try:
            asyncio.run(rag.retrieve(session, 1, "任意", top_k=2))
        except llm.LLMNotConfigured:
            pass
        else:
            raise AssertionError("vector 模式下不允许静默降级")
