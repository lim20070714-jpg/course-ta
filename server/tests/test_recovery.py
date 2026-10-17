"""重启后复位被打断的后台任务：状态不再永远转圈，改名 / 继续作答重新可操作。

engine fixture 必须把 db.engine 换掉：recovery 读的是模块级引擎，漏了补丁就会动真实库。
"""

from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.api.courses import is_busy
from app.config import settings
from app.core.recovery import reset_interrupted_jobs
from app.main import app
from app.models import Course, CourseGraph, Material, MockExam, Problem, Summary


@pytest.fixture()
def engine(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(db_module, "engine", eng)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    with Session(eng) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.add(Problem(id=7, course_id=1, number="1", stem="求 $v_o$"))
        session.commit()
    return eng


@pytest.fixture()
def client(engine) -> TestClient:
    return TestClient(app)


def _seed_running(engine) -> None:
    """四种「正在跑」各一行，外加两行已完成的对照。"""
    with Session(engine) as session:
        session.add(
            Material(
                id=1,
                course_id=1,
                filename="讲义.pdf",
                stored_path="materials/1/讲义.pdf",
                status="ingesting",
            )
        )
        session.add(
            Material(
                id=2,
                course_id=1,
                filename="已完成.pdf",
                stored_path="materials/1/已完成.pdf",
                status="ready",
                chunk_count=9,
            )
        )
        session.add(Summary(material_id=1, status="generating"))
        session.add(Summary(material_id=2, status="ready", overview="总结"))
        session.add(CourseGraph(course_id=1, status="generating"))
        session.add(
            MockExam(
                id=1,
                course_id=1,
                title="期中模拟",
                problem_ids="[7]",
                status="grading",
                submitted_at=datetime.now(UTC),
            )
        )
        session.add(MockExam(id=2, course_id=1, problem_ids="[7]", status="done", score=80.0))
        session.commit()


def test_四类在跑的状态各自复位(engine):
    _seed_running(engine)
    assert reset_interrupted_jobs() == {"material": 1, "summary": 1, "graph": 1, "exam": 1}

    with Session(engine) as session:
        material = session.get(Material, 1)
        assert material.status == "failed"
        assert "服务重启打断" in material.error
        assert session.get(Summary, 1).status == "failed"
        assert session.get(CourseGraph, 1).status == "failed"
        exam = session.get(MockExam, 1)
        assert exam.status == "running"
        assert "可以重新交卷" in exam.error


def test_已完成的行不动(engine):
    _seed_running(engine)
    reset_interrupted_jobs()
    with Session(engine) as session:
        ready = session.get(Material, 2)
        assert ready.status == "ready"
        assert ready.chunk_count == 9
        assert session.get(Summary, 2).overview == "总结"
        done = session.get(MockExam, 2)
        assert done.status == "done"
        assert done.score == 80.0


def test_复位后改名不再被忙碌守卫挡住(engine, client: TestClient):
    """真正卡住资料的是这个 409：状态停在 ingesting 就永远改不了名、删不掉。"""
    _seed_running(engine)
    with Session(engine) as session:
        assert is_busy(session.get(Material, 1)) is True

    reset_interrupted_jobs()
    with Session(engine) as session:
        assert is_busy(session.get(Material, 1)) is False

    r = client.patch("/api/materials/1", json={"filename": "lecture-1.pdf"})
    assert r.status_code == 200, r.text
    assert r.json()["filename"] == "lecture-1.pdf"


def test_被打断的模考还能继续写作答(engine, client: TestClient):
    """grading 退回 running 的实际意义：作答没丢，既改得动也重新交得了。"""
    _seed_running(engine)
    reset_interrupted_jobs()
    r = client.put("/api/mock-exams/1/answers/7", json={"answer_text": "重写一遍"})
    assert r.status_code == 200, r.text
    assert r.json()["items"][0]["answer_text"] == "重写一遍"


def test_应用启动本身就会复位(engine, client):
    """复位挂在 lifespan 上：不点任何按钮，重启本身就足以解开卡住的状态。"""
    _seed_running(engine)
    with TestClient(app):
        pass
    with Session(engine) as session:
        assert session.get(Material, 1).status == "failed"
        assert session.get(MockExam, 1).status == "running"


def test_空库复位无副作用(engine):
    assert reset_interrupted_jobs() == {"material": 0, "summary": 0, "graph": 0, "exam": 0}
