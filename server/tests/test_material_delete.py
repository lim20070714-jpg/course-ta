"""删除已上传资料：知识块/总结/磁盘文件清理，题目与图谱概念只断开来源。"""

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.config import settings
from app.core import problems as problems_core
from app.main import app
from app.models import (
    Attempt,
    Chunk,
    Concept,
    Course,
    Material,
    Problem,
    ReviewCard,
    Summary,
)


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture()
def client(engine, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(db_module, "engine", engine)
    monkeypatch.setattr(settings, "data_dir", tmp_path)
    with Session(engine) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.commit()
    yield TestClient(app)


def _seed(engine, tmp_path: Path, *, status: str = "ready") -> Path:
    """一份有 2 块、1 条总结、2 道题、1 个概念的资料，原件与页图落在磁盘上。"""
    stored = tmp_path / "materials" / "1" / "期末卷.pdf"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"%PDF fake")
    image = tmp_path / "media" / "1" / "pages" / "page-1.png"
    image.parent.mkdir(parents=True, exist_ok=True)
    image.write_bytes(b"png")
    with Session(engine) as session:
        session.add(
            Material(
                id=1,
                course_id=1,
                filename="期末卷.pdf",
                stored_path=str(stored),
                kind="exam",
                status=status,
                chunk_count=2,
                pages='[{"page": 1, "path": "media/1/pages/page-1.png"}]',
            )
        )
        for i, text in enumerate(["叠加定理的内容", "戴维南等效电路"]):
            session.add(Chunk(course_id=1, material_id=1, page=i + 1, seq=0, text=text))
        session.add(
            Summary(
                material_id=1,
                overview="整卷覆盖线性电路分析方法",
                key_points='[{"title": "叠加定理", "detail": "", "pages": [1]}]',
                status="ready",
            )
        )
        for i in (1, 2):
            session.add(
                Problem(
                    id=i,
                    course_id=1,
                    material_id=1,
                    page=i,
                    number=f"第{i}题",
                    stem=f"题干 {i}",
                    answer=f"答案 {i}",
                )
            )
        session.add(
            Attempt(id=1, problem_id=1, answer_text="我的作答", verdict="wrong", feedback="步骤 2 出错")
        )
        session.add(ReviewCard(id=1, problem_id=1, course_id=1))
        session.add(Concept(id=1, course_id=1, name="叠加定理", material_id=1, page=1))
        session.commit()
    return stored


def test_delete_removes_material_chunks_summary_and_files(client, engine, tmp_path: Path) -> None:
    stored = _seed(engine, tmp_path)
    resp = client.delete("/api/materials/1")
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "status": "deleted",
        "filename": "期末卷.pdf",
        "chunks_removed": 2,
        "problems_kept": 2,
    }
    with Session(engine) as session:
        assert session.get(Material, 1) is None
        assert session.exec(select(Chunk).where(Chunk.material_id == 1)).all() == []
        assert session.get(Summary, 1) is None
        assert session.exec(select(Concept).where(Concept.material_id == 1)).all() == []
        assert not stored.exists()
        assert not (tmp_path / "media" / "1").exists()


def test_delete_keeps_problems_and_their_study_history(client, engine, tmp_path: Path) -> None:
    _seed(engine, tmp_path)
    assert client.delete("/api/materials/1").status_code == 200
    with Session(engine) as session:
        problems = session.exec(select(Problem).order_by(Problem.id)).all()
        assert [p.material_id for p in problems] == [None, None]
        assert [p.stem for p in problems] == ["题干 1", "题干 2"]
        attempt = session.get(Attempt, 1)
        assert attempt is not None and attempt.verdict == "wrong"
        assert session.get(ReviewCard, 1) is not None
        concept = session.exec(select(Concept)).all()[0]
        assert concept.name == "叠加定理" and concept.material_id is None


def test_deleted_material_disappears_from_listing_and_search(client, engine, tmp_path: Path) -> None:
    _seed(engine, tmp_path)
    client.delete("/api/materials/1")
    assert client.get("/api/courses/1/materials").json() == []
    hits = client.get("/api/courses/1/search", params={"q": "叠加定理"}).json()
    assert hits["hits"] == []


def test_missing_material_returns_404(client) -> None:
    assert client.delete("/api/materials/424242").status_code == 404


@pytest.mark.parametrize("status", ["pending", "ingesting"])
def test_delete_blocked_while_ingesting(client, engine, tmp_path: Path, status: str) -> None:
    stored = _seed(engine, tmp_path, status=status)
    resp = client.delete("/api/materials/1")
    assert resp.status_code == 409
    assert "后台处理" in resp.json()["detail"]
    with Session(engine) as session:
        assert session.get(Material, 1) is not None
        assert len(session.exec(select(Chunk)).all()) == 2
    assert stored.exists()


def test_delete_blocked_while_problem_extraction_running(
    client, engine, tmp_path: Path
) -> None:
    _seed(engine, tmp_path)
    problems_core._JOBS[1] = {"status": "running", "error": ""}
    try:
        assert client.delete("/api/materials/1").status_code == 409
    finally:
        problems_core._JOBS.pop(1, None)
    with Session(engine) as session:
        assert session.get(Material, 1) is not None


def test_delete_survives_missing_files(client, engine, tmp_path: Path) -> None:
    _seed(engine, tmp_path)
    with Session(engine) as session:
        material = session.get(Material, 1)
        assert material is not None
        material.stored_path = str(tmp_path / "已经被手动删掉了.pdf")
        session.add(material)
        session.commit()
    assert client.delete("/api/materials/1").status_code == 200
