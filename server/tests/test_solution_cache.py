"""AI 详解落库：已有详解直接回放不调模型，新生成的写回 Problem，批改与模考复用。"""

import json
from collections.abc import AsyncIterator, Iterator
from datetime import UTC, datetime

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core import exams
from app.core import problems as core
from app.main import app
from app.models import Course, Material, Problem

CITATIONS = [{"material_id": 1, "material": "讲义.pdf", "page": 3, "snippet": "戴维南等效"}]
HITS = [
    {
        "material_id": 1,
        "material": "讲义.pdf",
        "page": 3,
        "snippet": "戴维南等效",
        "text": "戴维南定理：任意线性含源二端网络……",
    }
]


@pytest.fixture()
def engine():
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.add(Material(id=1, course_id=1, filename="讲义.pdf", stored_path="x", kind="slides"))
        session.add(Problem(id=1, course_id=1, material_id=1, page=2, number="1", stem="求 $U_{oc}$"))
        session.add(
            Problem(
                id=2,
                course_id=1,
                material_id=1,
                page=2,
                number="2",
                stem="求 $R_{eq}$",
                solution="已落库的详解",
                solution_citations=json.dumps(CITATIONS, ensure_ascii=False),
            )
        )
        session.add(
            Problem(id=3, course_id=1, material_id=1, page=3, number="3", stem="有答案", answer="材料答案")
        )
        session.commit()
    return eng


@pytest.fixture()
def client(engine, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(db_module, "engine", engine)
    yield TestClient(app)


def _stub_llm(monkeypatch: pytest.MonkeyPatch, pieces: list[str]) -> list[dict]:
    calls: list[dict] = []

    async def fake_stream(messages: list[dict], model: str | None = None) -> AsyncIterator[str]:
        calls.append({"messages": messages, "model": model})
        for piece in pieces:
            yield piece

    async def fake_retrieve(session, course_id, query, top_k=4):
        return HITS

    monkeypatch.setattr(core.llm, "chat_stream", fake_stream)
    monkeypatch.setattr(core, "retrieve", fake_retrieve)
    return calls


async def _collect(gen: AsyncIterator[tuple[str, object]]) -> list[tuple[str, object]]:
    return [event async for event in gen]


@pytest.mark.anyio()
async def test_cached_solution_replays_without_llm(engine, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_llm(monkeypatch, ["不该被调用"])
    with Session(engine) as session:
        events = await _collect(core.stream_solution(session, session.get(Problem, 2)))
    assert events[0] == ("meta", {"cached": True})
    assert events[1] == ("citations", CITATIONS)
    assert events[2] == ("delta", "已落库的详解")
    assert calls == []


@pytest.mark.anyio()
async def test_generated_solution_is_persisted(engine, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_llm(monkeypatch, ["第一步：", "开路电压 $U_{oc}=6$ V。"])
    with Session(engine) as session:
        events = await _collect(core.stream_solution(session, session.get(Problem, 1)))
    assert events[0] == ("meta", {"cached": False})
    assert events[1] == ("citations", CITATIONS)
    assert "".join(str(d) for k, d in events if k == "delta") == "第一步：开路电压 $U_{oc}=6$ V。"
    assert len(calls) == 1
    assert "戴维南定理" in calls[0]["messages"][1]["content"]
    with Session(engine) as session:
        row = session.get(Problem, 1)
        assert row.solution == "第一步：开路电压 $U_{oc}=6$ V。"
        assert json.loads(row.solution_citations) == CITATIONS


@pytest.mark.anyio()
async def test_regenerate_overwrites_cached(engine, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_llm(monkeypatch, ["重新生成的详解"])
    with Session(engine) as session:
        events = await _collect(
            core.stream_solution(session, session.get(Problem, 2), regenerate=True)
        )
    assert events[0] == ("meta", {"cached": False})
    assert len(calls) == 1
    with Session(engine) as session:
        assert session.get(Problem, 2).solution == "重新生成的详解"


@pytest.mark.anyio()
async def test_generate_solution_non_streaming(engine, monkeypatch: pytest.MonkeyPatch):
    async def fake_retrieve(session, course_id, query, top_k=4):
        return HITS

    async def fake_complete(messages, **kwargs):
        return "  批量生成的详解\n"

    monkeypatch.setattr(core, "retrieve", fake_retrieve)
    monkeypatch.setattr(core.llm, "complete", fake_complete)
    with Session(engine) as session:
        text = await core.generate_solution(session, session.get(Problem, 1))
    assert text == "批量生成的详解"
    with Session(engine) as session:
        row = session.get(Problem, 1)
        assert row.solution == "批量生成的详解"
        assert json.loads(row.solution_citations) == CITATIONS


def test_detail_exposes_solution(client: TestClient):
    body = client.get("/api/problems/2").json()
    assert body["solution"] == "已落库的详解"
    assert body["solution_citations"] == CITATIONS
    assert client.get("/api/problems/1").json()["solution"] == ""


def test_solution_endpoint_streams_cached(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_llm(monkeypatch, ["不该被调用"])
    with client.stream("POST", "/api/problems/2/solution") as resp:
        assert resp.status_code == 200
        lines = [line for line in resp.iter_lines() if line]
    events = [line.split(":", 1)[1].strip() for line in lines if line.startswith("event:")]
    assert events == ["meta", "citations", "delta", "done"]
    payloads = [line.split(":", 1)[1].strip() for line in lines if line.startswith("data:")]
    assert json.loads(payloads[0]) == {"cached": True}
    assert json.loads(payloads[2]) == {"text": "已落库的详解"}
    assert calls == []


def test_solution_endpoint_regenerate_flag(client: TestClient, monkeypatch: pytest.MonkeyPatch):
    calls = _stub_llm(monkeypatch, ["新详解"])
    with client.stream("POST", "/api/problems/2/solution?regenerate=true") as resp:
        lines = [line for line in resp.iter_lines() if line]
    payloads = [line.split(":", 1)[1].strip() for line in lines if line.startswith("data:")]
    assert json.loads(payloads[0]) == {"cached": False}
    assert len(calls) == 1
    assert client.get("/api/problems/2").json()["solution"] == "新详解"


def test_reference_for_grading_prefers_material_answer():
    assert "材料答案" in core.reference_for_grading(Problem(stem="x", answer="材料答案", solution="详解"))
    assert "详解" in core.reference_for_grading(Problem(stem="x", solution="详解"))
    assert "没有参考答案" in core.reference_for_grading(Problem(stem="x"))


def test_exam_pool_accepts_solution_only(engine):
    with Session(engine) as session:
        pool = exams.gradeable([session.get(Problem, i) for i in (1, 2, 3)])
    assert sorted(p.id for p in pool) == [2, 3]
