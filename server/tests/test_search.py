from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

from app.core.store import search_text
from app.models import Chunk


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
