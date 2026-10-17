"""做题足迹：整门课的作答记录、判定计数与筛选分页。"""

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.config import settings
from app.main import app
from app.models import Attempt, Course, Material, Problem

T0 = datetime(2026, 10, 15, 9, 0, tzinfo=UTC)


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    _seed(eng)
    return eng


@pytest.fixture()
def client(engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    yield TestClient(app)


def _seed(engine) -> None:
    """课程 1：题 1 做错→做对，题 2 半对，题 3 从未作答；课程 2 另有一条记录。"""
    with Session(engine) as session:
        session.add(Course(id=1, name="电路", created_at=T0))
        session.add(Course(id=2, name="复变", created_at=T0))
        for mid, filename in [(1, "期末卷.pdf"), (2, "习题集.pdf")]:
            session.add(
                Material(
                    id=mid,
                    course_id=1,
                    filename=filename,
                    stored_path=f"data/materials/1/{filename}",
                    kind="exam",
                    status="ready",
                )
            )
        for pid, mid, page, number in [(1, 1, 2, "一、1"), (2, 1, 3, "一、2"), (3, 2, 1, "二、1")]:
            session.add(
                Problem(
                    id=pid,
                    course_id=1,
                    material_id=mid,
                    page=page,
                    number=number,
                    stem=f"求 $R_{{{pid}}}$ 两端电压，写出步骤。",
                    answer="参考答案",
                    knowledge='["叠加定理"]' if pid == 1 else "[]",
                )
            )
        session.add(
            Problem(id=99, course_id=2, page=1, number="别的课的题", stem="留数定理")
        )
        session.add_all(
            [
                Attempt(
                    id=1,
                    problem_id=1,
                    answer_text="第一次",
                    verdict="wrong",
                    feedback="步骤 2 符号错",
                    created_at=T0,
                ),
                Attempt(
                    id=2,
                    problem_id=1,
                    answer_text="第二次",
                    verdict="correct",
                    feedback="完整",
                    created_at=datetime(2026, 10, 16, 8, tzinfo=UTC),
                ),
                Attempt(
                    id=3,
                    problem_id=2,
                    answer_text="半对",
                    verdict="partial",
                    feedback="漏了单位",
                    created_at=datetime(2026, 10, 16, 9, tzinfo=UTC),
                ),
                Attempt(
                    id=4,
                    problem_id=99,
                    answer_text="复变的作答",
                    verdict="wrong",
                    created_at=datetime(2026, 10, 16, 10, tzinfo=UTC),
                ),
            ]
        )
        session.commit()


def test_history_is_newest_first_and_excludes_other_courses(client) -> None:
    body = client.get("/api/courses/1/attempts").json()
    assert [i["attempt_id"] for i in body["items"]] == [3, 2, 1]
    top = body["items"][0]
    assert top["attempt_id"] == 3
    assert top["problem_id"] == 2
    assert top["material"] == "期末卷.pdf"
    assert top["number"] == "一、2"
    assert top["excerpt"] == "求 R_2 两端电压，写出步骤。"
    assert top["verdict"] == "partial"
    assert top["feedback"] == "漏了单位"
    assert top["created_at"].startswith("2026-10-16T09:00:00")
    assert body["items"][-1]["knowledge"] == ["叠加定理"]


def test_counts_cover_whole_course(client) -> None:
    assert client.get("/api/courses/1/attempts").json()["counts"] == {
        "total": 3,
        "correct": 1,
        "partial": 1,
        "wrong": 1,
        "unknown": 0,
        "problems_touched": 2,  # 题 1 做过两次只算一次
        "problems_ever_wrong": 2,  # 题 1 后来做对了，仍然算「错过」
    }


def test_verdict_filter_keeps_full_counts(client) -> None:
    body = client.get("/api/courses/1/attempts", params={"verdict": "wrong"}).json()
    assert body["filtered"] == 1
    assert [i["attempt_id"] for i in body["items"]] == [1]
    assert body["counts"]["total"] == 3  # 计数不受筛选影响


@pytest.mark.parametrize(("offset", "expected"), [(0, [3, 2]), (2, [1])])
def test_pagination(client, offset: int, expected: list[int]) -> None:
    body = client.get("/api/courses/1/attempts", params={"offset": offset, "limit": 2}).json()
    assert [i["attempt_id"] for i in body["items"]] == expected


def test_detached_problem_still_shows_a_source_placeholder(client, engine) -> None:
    """资料被删后题目只断开来源，足迹里要标出来而不是整条记录消失。"""
    with Session(engine) as session:
        problem = session.get(Problem, 2)
        assert problem is not None
        problem.material_id = None
        session.add(problem)
        session.commit()
    item = client.get("/api/courses/1/attempts").json()["items"][0]
    assert item["problem_id"] == 2 and item["material"] == "已断开的来源"


@pytest.mark.parametrize("verdict", ["nope", "unanswered"])
def test_unknown_verdict_filter_is_rejected(client, verdict: str) -> None:
    assert client.get("/api/courses/1/attempts", params={"verdict": verdict}).status_code == 422


def test_filter_matching_nothing_returns_empty_items(client) -> None:
    body = client.get("/api/courses/1/attempts", params={"verdict": "unknown"}).json()
    assert body["items"] == []
    assert body["filtered"] == 0
    assert body["counts"]["total"] == 3
