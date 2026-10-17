"""课程与资料改名：资料名会连带磁盘原件一起改名，后台忙碌时先拒绝。"""

from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.config import settings
from app.core import problems as problems_core
from app.main import app
from app.models import Chunk, Course, Material


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
        session.add(Course(id=1, name="电路", description="电路原理", created_at=datetime.now(UTC)))
        session.add(Course(id=2, name="复变", created_at=datetime.now(UTC)))
        session.commit()
    yield TestClient(app)


def _seed_materials(engine, tmp_path: Path, *, status: str = "ready") -> Path:
    """两份资料：id=1 期末卷.pdf（改名目标）、id=2 实验指导.pdf（用来撞名）。"""
    stored = tmp_path / "materials" / "1" / "期末卷.pdf"
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_bytes(b"%PDF-original")
    other = tmp_path / "materials" / "1" / "实验指导.pdf"
    other.write_bytes(b"%PDF-other")
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
            )
        )
        session.add(
            Material(
                id=2,
                course_id=1,
                filename="实验指导.pdf",
                stored_path=str(other),
                kind="handout",
                status="ready",
                chunk_count=1,
            )
        )
        session.commit()
    return stored


def test_rename_course_updates_name_and_description(client, engine) -> None:
    resp = client.patch(
        "/api/courses/1", json={"name": "  电路原理（期末）  ", "description": ""}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["name"] == "电路原理（期末）"
    assert resp.json()["description"] == ""
    courses = {c["id"]: c for c in client.get("/api/courses").json()}
    assert courses[1]["name"] == "电路原理（期末）"
    assert courses[2]["name"] == "复变"  # 另一门课不受影响


@pytest.mark.parametrize("name", ["", "   ", "电" * 61])
def test_rename_course_rejects_bad_names(client, name: str) -> None:
    assert client.patch("/api/courses/1", json={"name": name}).status_code == 400


def test_rename_course_needs_a_field_or_exists(client) -> None:
    assert client.patch("/api/courses/1", json={}).status_code == 400
    assert client.patch("/api/courses/424242", json={"name": "不存在"}).status_code == 404


def test_rename_material_moves_the_original_file(client, engine, tmp_path: Path) -> None:
    stored = _seed_materials(engine, tmp_path)
    resp = client.patch("/api/materials/1", json={"filename": "2024 期末卷.pdf"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["filename"] == "2024 期末卷.pdf"
    renamed = stored.parent / "2024 期末卷.pdf"
    assert renamed.exists() and renamed.read_bytes() == b"%PDF-original"
    assert not stored.exists()
    with Session(engine) as session:
        material = session.get(Material, 1)
        assert material is not None
        assert material.stored_path == str(renamed)  # 库里记录的原件路径跟着改名
    listing = client.get("/api/courses/1/materials").json()
    assert {m["filename"] for m in listing} == {"2024 期末卷.pdf", "实验指导.pdf"}


def test_rename_material_strips_directory_components(client, engine, tmp_path: Path) -> None:
    stored = _seed_materials(engine, tmp_path)
    resp = client.patch("/api/materials/1", json={"filename": "../../etc/passwd.pdf"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["filename"] == "passwd.pdf"  # 目录成分被剥掉，文件仍在课程目录里
    assert (stored.parent / "passwd.pdf").read_bytes() == b"%PDF-original"


@pytest.mark.parametrize(
    "filename",
    [
        "",
        "   ",
        "a<b.pdf",  # Windows 非法字符
        "lecture",  # 没有类型后缀
        "notes.doc",  # 不支持的后缀
        "长" * 121 + ".pdf",
    ],
)
def test_rename_material_rejects_bad_names(client, engine, tmp_path: Path, filename: str) -> None:
    _seed_materials(engine, tmp_path)
    assert client.patch("/api/materials/1", json={"filename": filename}).status_code == 400


@pytest.mark.parametrize(
    "filename",
    [
        "A1-05 换名-验证.pdf",  # 连字符是最常见的课件命名，不能被当成非法字符
        "notes_final.pptx",
        "Circuit 定理 (2024).md",
    ],
)
def test_rename_material_allows_ordinary_punctuation(
    client, engine, tmp_path: Path, filename: str
) -> None:
    _seed_materials(engine, tmp_path)
    resp = client.patch("/api/materials/1", json={"filename": filename})
    assert resp.status_code == 200, resp.text
    assert resp.json()["filename"] == filename


def test_rename_material_response_keeps_page_count(
    client, engine, tmp_path: Path
) -> None:
    """改名返回的那一行要和列表同口径：页数来自 Chunk，不是 Material 表里的 0。"""
    _seed_materials(engine, tmp_path)
    with Session(engine) as session:
        for seq, page in ((0, 1), (1, 7)):
            session.add(
                Chunk(course_id=1, material_id=1, page=page, seq=seq, text=f"第 {page} 页")
            )
        session.commit()
    renamed = client.patch("/api/materials/1", json={"filename": "期中卷.pdf"}).json()
    listed = next(m for m in client.get("/api/courses/1/materials").json() if m["id"] == 1)
    assert renamed["page_count"] == listed["page_count"] == 7


def test_rename_material_rejects_duplicate_name(client, engine, tmp_path: Path) -> None:
    stored = _seed_materials(engine, tmp_path)
    resp = client.patch("/api/materials/1", json={"filename": "实验指导.pdf"})
    assert resp.status_code == 409
    assert "同名" in resp.json()["detail"]
    with Session(engine) as session:
        material = session.get(Material, 1)
        assert material is not None
        assert material.filename == "期末卷.pdf"
    assert stored.exists()


@pytest.mark.parametrize("status", ["pending", "ingesting"])
def test_rename_blocked_while_ingesting(client, engine, tmp_path: Path, status: str) -> None:
    stored = _seed_materials(engine, tmp_path, status=status)
    resp = client.patch("/api/materials/1", json={"filename": "改个名.pdf"})
    assert resp.status_code == 409
    assert "后台处理" in resp.json()["detail"]
    assert stored.exists() and not (stored.parent / "改个名.pdf").exists()


def test_rename_blocked_while_problem_extraction_running(
    client, engine, tmp_path: Path
) -> None:
    _seed_materials(engine, tmp_path)
    problems_core._JOBS[1] = {"status": "running", "error": ""}
    try:
        assert client.patch("/api/materials/1", json={"filename": "改个名.pdf"}).status_code == 409
    finally:
        problems_core._JOBS.pop(1, None)


def test_renaming_to_the_same_name_is_allowed_while_busy(
    client, engine, tmp_path: Path
) -> None:
    _seed_materials(engine, tmp_path, status="ingesting")
    resp = client.patch("/api/materials/1", json={"filename": " 期末卷.pdf "})
    assert resp.status_code == 200, resp.text  # 只是去首尾空格，磁盘不动，无需等后台


def test_rename_material_survives_missing_original(client, engine, tmp_path: Path) -> None:
    _seed_materials(engine, tmp_path)
    with Session(engine) as session:
        material = session.get(Material, 1)
        assert material is not None
        material.stored_path = str(tmp_path / "materials" / "1" / "已经被手动删掉了.pdf")
        session.add(material)
        session.commit()
    resp = client.patch("/api/materials/1", json={"filename": "改名.pdf"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["filename"] == "改名.pdf"


def test_kind_patch_still_works(client, engine, tmp_path: Path) -> None:
    stored = _seed_materials(engine, tmp_path)
    resp = client.patch("/api/materials/1", json={"kind": "slides"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["kind"] == "slides" and resp.json()["filename"] == "期末卷.pdf"
    assert stored.read_bytes() == b"%PDF-original"


@pytest.mark.parametrize("payload", [{}, {"kind": "not-a-kind"}])
def test_material_patch_validates_payload(client, engine, tmp_path: Path, payload: dict) -> None:
    _seed_materials(engine, tmp_path)
    assert client.patch("/api/materials/1", json=payload).status_code == 400
    assert client.patch("/api/materials/424242", json={"kind": "slides"}).status_code == 404
