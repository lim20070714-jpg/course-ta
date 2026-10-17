"""实验台图纸：命名保存、整张覆盖、载入与删除。"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.api.labs import MAX_BUILD_CHARS
from app.config import settings
from app.main import app
from app.models import LabDrawing

BUILD = {
    "comps": [
        {"id": "c1", "kind": "resistor", "x": 2, "y": 3, "value": "4.7k"},
        {"id": "c2", "kind": "source", "x": 8, "y": 3, "wave": {"type": "square", "freq": 1e3}},
    ],
    "wires": [{"from": {"comp": "c1", "pin": "b"}, "to": {"comp": "c2", "pin": "a"}}],
}


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
    yield TestClient(app)


def _save(client, name: str = "RC 低通", lab_id: str = "__free", build: dict | None = None):
    return client.post(
        "/api/labs/drawings",
        json={"name": name, "lab_id": lab_id, "build": build or BUILD},
    )


def test_save_roundtrips_the_canvas_exactly(client) -> None:
    created = _save(client).json()
    assert created["name"] == "RC 低通" and created["lab_id"] == "__free"
    assert created["comp_count"] == 2 and created["wire_count"] == 1
    detail = client.get(f"/api/labs/drawings/{created['id']}").json()
    # 前端加字段（比如波形的嵌套对象）不需要动后端，原样还回
    assert detail["build"] == BUILD


def test_listing_is_newest_edit_first_and_filterable(client, engine) -> None:
    _save(client, name="老图纸")
    _save(client, name="新图纸", lab_id="rc")
    _save(client, name="很老的图纸")
    with Session(engine) as session:  # 把「老图纸」改成最近更新时间（另存一次）
        for row in session.exec(select(LabDrawing)).all():
            if row.name == "老图纸":
                row.updated_at = datetime(2099, 1, 1, tzinfo=UTC)
                session.add(row)
        session.commit()
    everything = client.get("/api/labs/drawings").json()
    assert [d["name"] for d in everything] == ["老图纸", "很老的图纸", "新图纸"]
    assert [d["name"] for d in client.get("/api/labs/drawings", params={"lab_id": "rc"}).json()] == [
        "新图纸"
    ]


def test_duplicate_name_within_one_lab_is_rejected(client) -> None:
    assert _save(client, name="同名").status_code == 200
    conflict = _save(client, name=" 同名 ")
    assert conflict.status_code == 409
    assert "同名图纸" in conflict.json()["detail"]
    assert _save(client, name="同名", lab_id="opamp").status_code == 200  # 换个实验可以重名


@pytest.mark.parametrize(
    ("payload", "reason"),
    [
        ({"name": "  ", "build": BUILD}, "空名字"),
        ({"name": "缺字段", "build": {"comps": []}}, "没有 wires"),
        ({"name": "类型错", "build": {"comps": [1], "wires": []}}, "元件不是对象"),
        ({"name": "类型错", "build": {"comps": {}, "wires": []}}, "comps 不是数组"),
        (
            {"name": "超大", "build": {"comps": [{"pad": "x" * 500}] * 500, "wires": []}},
            f"超过 {MAX_BUILD_CHARS} 字符",
        ),
    ],
)
def test_invalid_drawings_are_rejected(client, payload: dict, reason: str) -> None:
    resp = client.post("/api/labs/drawings", json=payload)
    assert resp.status_code == 422, reason
    assert resp.json()["detail"]


def test_update_overwrites_and_renames(client) -> None:
    created = _save(client, name="草稿").json()
    changed = {"comps": BUILD["comps"][:1], "wires": []}
    resp = client.put(
        f"/api/labs/drawings/{created['id']}",
        json={"name": "草稿（交卷版）", "lab_id": "rc", "build": changed},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["name"] == "草稿（交卷版）" and body["lab_id"] == "rc"
    assert body["comp_count"] == 1 and body["build"] == changed
    assert client.get(f"/api/labs/drawings/{created['id']}").json()["build"] == changed


def test_update_and_get_reject_a_missing_drawing(client) -> None:
    assert client.get("/api/labs/drawings/424242").status_code == 404
    resp = client.put("/api/labs/drawings/424242", json={"name": "不存在", "build": BUILD})
    assert resp.status_code == 404


def test_delete_removes_only_the_drawing(client) -> None:
    created = _save(client).json()
    resp = client.delete(f"/api/labs/drawings/{created['id']}")
    assert resp.json() == {"status": "deleted", "name": "RC 低通"}
    assert client.get("/api/labs/drawings").json() == []
    assert client.delete(f"/api/labs/drawings/{created['id']}").status_code == 404


def test_corrupt_stored_build_degrades_instead_of_500(client, engine) -> None:
    created = _save(client).json()
    with Session(engine) as session:
        row = session.get(LabDrawing, created["id"])
        assert row is not None
        row.build = "{这文件坏掉了"
        row.updated_at = datetime(2026, 10, 16, tzinfo=UTC) + timedelta(days=1)
        session.add(row)
        session.commit()
    listed = client.get("/api/labs/drawings").json()[0]
    assert listed["comp_count"] == 0 and listed["wire_count"] == 0
    detail = client.get(f"/api/labs/drawings/{created['id']}").json()
    assert detail["build"] == {"comps": [], "wires": []}
