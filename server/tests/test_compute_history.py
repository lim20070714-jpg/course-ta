"""计算台历史：成功与失败都留痕，写满裁剪，可清空。"""

from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.api.compute import HISTORY_KEEP
from app.config import settings
from app.main import app
from app.models import ComputeRun


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


def _seed_runs(engine, count: int) -> None:
    with Session(engine) as session:
        base = datetime(2026, 10, 1, tzinfo=UTC)
        for i in range(count):
            session.add(
                ComputeRun(
                    expr=f"x^{i}",
                    op="simplify",
                    args="{}",
                    result_plain=str(i),
                    created_at=base + timedelta(minutes=i),
                )
            )
        session.commit()


def test_successful_evaluation_is_recorded(client) -> None:
    resp = client.post("/api/compute/evaluate", json={"expr": "x^2", "op": "diff", "var": "x"})
    assert resp.status_code == 200, resp.text
    body = client.get("/api/compute/history").json()
    assert body["total"] == 1 and body["kept"] == HISTORY_KEEP
    item = body["items"][0]
    assert item["expr"] == "x^2" and item["op"] == "diff"
    assert item["error"] == ""
    assert "2*x" in item["result_plain"].replace(" ", "") or "2⋅x" in item["result_plain"]
    # 回填所需的其余入参要原样还在
    assert item["args"]["var"] == "x"
    assert item["args"]["order"] == 1
    assert set(item["args"]) == {"var", "point", "lower", "upper", "order", "symbols"}


def test_failed_evaluation_is_recorded_with_the_error(client) -> None:
    resp = client.post("/api/compute/evaluate", json={"expr": "x", "op": "fly"})
    assert resp.status_code == 422
    item = client.get("/api/compute/history").json()["items"][0]
    assert item["error"] == "不支持的操作：fly"
    assert item["result_plain"] == ""


def test_history_is_newest_first_and_limited(client, engine) -> None:
    _seed_runs(engine, 5)
    client.post("/api/compute/evaluate", json={"expr": "x+1", "op": "simplify"})
    body = client.get("/api/compute/history", params={"limit": 2}).json()
    assert body["total"] == 6
    assert [i["expr"] for i in body["items"]] == ["x+1", "x^4"]  # 最新在前，limit 只截列表


def test_history_is_pruned_to_the_cap(client, engine) -> None:
    _seed_runs(engine, HISTORY_KEEP)
    client.post("/api/compute/evaluate", json={"expr": "x+1", "op": "simplify"})
    body = client.get("/api/compute/history", params={"limit": HISTORY_KEEP}).json()
    assert body["total"] == HISTORY_KEEP
    assert body["items"][0]["expr"] == "x+1"  # 裁的是最老的，不是刚写的
    with Session(engine) as session:
        assert session.exec(select(ComputeRun).where(ComputeRun.expr == "x^0")).all() == []


def test_clear_history(client, engine) -> None:
    _seed_runs(engine, 3)
    resp = client.delete("/api/compute/history")
    assert resp.status_code == 200
    assert resp.json() == {"status": "cleared", "removed": 3}
    assert client.get("/api/compute/history").json()["items"] == []


def test_broken_args_json_still_reads_as_empty(client, engine) -> None:
    _seed_runs(engine, 1)
    with Session(engine) as session:
        row = session.exec(select(ComputeRun)).all()[0]
        row.args = "{不是 JSON"
        session.add(row)
        session.commit()
    assert client.get("/api/compute/history").json()["items"][0]["args"] == {}


def test_history_does_not_record_a_rejected_request(client) -> None:
    """连表达式都没有的请求在 pydantic 层就被挡了，不该污染历史。"""
    assert client.post("/api/compute/evaluate", json={"op": "simplify"}).status_code == 422
    assert client.get("/api/compute/history").json()["total"] == 0
