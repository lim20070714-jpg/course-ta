import asyncio
import json

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

from app import db as db_module
from app.core import graph as graph_core
from app.main import app
from app.models import Concept, ConceptEdge, Course, CourseGraph, Material, Problem, Summary


def test_parse_candidates_basic() -> None:
    text = (
        "【概念】基尔霍夫定律｜电流与电压的约束关系｜KCL,KVL\n"
        "- 【概念】戴维南定理 | 含源单口网络的等效 | 等效电路\n"
        "无关文字\n"
    )
    items = graph_core.parse_candidates(text)
    assert items[0]["name"] == "基尔霍夫定律"
    assert items[0]["keywords"] == ["KCL", "KVL"]
    assert items[1]["name"] == "戴维南定理"
    assert items[1]["desc"] == "含源单口网络的等效"


def test_parse_candidates_skips_incomplete() -> None:
    assert graph_core.parse_candidates("【概念】只有名字\n【概念】｜只有解释") == []


def test_parse_graph_text_full() -> None:
    text = (
        "【总览】\n课程从电路定律走向网络定理。\n【/总览】\n"
        "【模块】基础定律\n"
        "【概念】基尔霍夫定律｜电流电压约束｜节点,回路\n"
        "【模块】网络定理\n"
        "【概念】戴维南定理｜等效为电压源串电阻（线性条件）｜等效电路\n"
        "【关系】\n"
        "前置：基尔霍夫定律 -> 戴维南定理\n"
        "相关: 戴维南定理 -- 诺顿定理\n"
    )
    parsed = graph_core.parse_graph_text(text)
    assert parsed["overview"] == "课程从电路定律走向网络定理。"
    assert [m["name"] for m in parsed["modules"]] == ["基础定律", "网络定理"]
    assert parsed["modules"][0]["concepts"][0]["name"] == "基尔霍夫定律"
    assert parsed["modules"][1]["concepts"][0]["desc"] == "等效为电压源串电阻（线性条件）"
    edges = parsed["edges"]
    assert edges[0] == {"source": "基尔霍夫定律", "target": "戴维南定理", "relation": "prerequisite"}
    assert edges[1]["relation"] == "related"
    assert edges[1]["target"] == "诺顿定理"


def test_parse_graph_text_concept_without_module() -> None:
    parsed = graph_core.parse_graph_text("【概念】孤立概念｜解释｜关键词")
    assert parsed["modules"][0]["name"] == "其他"


def test_material_blocks_caps_points_and_detail() -> None:
    key_points = [{"title": f"点{i}", "detail": "详" * 200, "pages": [i]} for i in range(20)]
    blocks = graph_core.material_blocks([(1, "课件.pdf", key_points)])
    assert len(blocks) == 1
    filename, body = blocks[0]
    assert filename == "课件.pdf"
    lines = body.splitlines()
    assert len(lines) == 12
    assert len(lines[0]) <= 90


def test_batch_blocks_respects_budget() -> None:
    blocks = [("a.pdf", "x" * 400), ("b.pdf", "y" * 400), ("c.pdf", "z" * 400)]
    batches = graph_core.batch_blocks(blocks, budget=900)
    assert len(batches) == 2
    assert "《a.pdf》" in batches[0][0]
    assert "《c.pdf》" in batches[1][0]


def test_anchor_concept_matches_title_and_keywords() -> None:
    index = [
        {"material_id": 1, "filename": "a.pdf", "title": "戴维南定理与诺顿定理", "page": 3},
        {"material_id": 2, "filename": "b.pdf", "title": "基尔霍夫电流定律", "page": 8},
    ]
    hit = graph_core.anchor_concept({"name": "戴维南定理", "keywords": []}, index)
    assert hit == (1, 3)
    by_keyword = graph_core.anchor_concept({"name": "陌生名", "keywords": ["基尔霍夫"]}, index)
    assert by_keyword == (2, 8)
    assert graph_core.anchor_concept({"name": "无关概念", "keywords": ["xx"]}, index) == (None, 0)


def _client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    return TestClient(app)


def test_graph_api_reads_nodes_edges_and_problems(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch) as client:
        with Session(db_module.engine) as session:
            course = Course(name="电电")
            session.add(course)
            session.commit()
            session.refresh(course)
            material = Material(
                course_id=course.id or 0, filename="课件1.pdf", stored_path="x", status="ready"
            )
            session.add(material)
            session.commit()
            session.refresh(material)
            first = Concept(
                course_id=course.id or 0,
                name="基尔霍夫定律",
                description="约束关系",
                module="基础定律",
                order=0,
                material_id=material.id,
                page=3,
            )
            second = Concept(
                course_id=course.id or 0, name="戴维南定理", description="等效", module="网络定理",
                order=1,
            )
            session.add(first)
            session.add(second)
            session.commit()
            session.refresh(first)
            session.refresh(second)
            first_id = first.id or 0
            second_id = second.id or 0
            session.add(
                ConceptEdge(
                    course_id=course.id or 0,
                    source_id=first_id,
                    target_id=second_id,
                    relation="prerequisite",
                )
            )
            session.add(
                Problem(
                    course_id=course.id or 0,
                    material_id=material.id,
                    page=3,
                    number="一、1",
                    stem="求 $v$",
                    knowledge=json.dumps(["基尔霍夫", "戴维南定理"], ensure_ascii=False),
                )
            )
            session.commit()
            course_id = course.id or 0

        resp = client.get(f"/api/courses/{course_id}/graph")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "pending"
        assert [n["name"] for n in data["nodes"]] == ["基尔霍夫定律", "戴维南定理"]
        assert data["nodes"][0]["material"] == "课件1.pdf"
        assert data["nodes"][0]["problems"][0]["number"] == "一、1"
        assert data["nodes"][0]["problems"][0]["material"] == "课件1.pdf"
        assert data["nodes"][1]["problems"][0]["number"] == "一、1"
        assert len(data["nodes"][0]["problems"]) == 1
        assert data["edges"] == [
            {"source": first_id, "target": second_id, "relation": "prerequisite", "note": ""}
        ]

        assert client.get("/api/courses/999/graph").status_code == 404


def test_graph_api_post_marks_failed_without_summaries(monkeypatch: pytest.MonkeyPatch) -> None:
    with _client(monkeypatch) as client:
        with Session(db_module.engine) as session:
            course = Course(name="空课程")
            session.add(course)
            session.commit()
            session.refresh(course)
            course_id = course.id or 0

        resp = client.post(f"/api/courses/{course_id}/graph")
        assert resp.status_code == 202
        assert resp.json() == {"status": "accepted"}

        data = client.get(f"/api/courses/{course_id}/graph").json()
        assert data["status"] == "failed"
        assert "材料总结" in data["error"]
        assert client.post("/api/courses/999/graph").status_code == 404


_BATCH_REPLY = (
    "【概念】基尔霍夫定律｜电流电压的约束关系｜节点,回路\n"
    "【概念】戴维南定理｜含源单口网络的等效｜等效电路\n"
    "【概念】基尔霍夫定律｜重复概念应被去重｜KCL\n"
)

_MERGE_REPLY = (
    "【总览】本课程从电路基本定律走向网络等效定理。\n"
    "【模块】基础定律\n"
    "【概念】基尔霍夫定律｜电流与电压的约束关系｜节点,回路\n"
    "【模块】网络定理\n"
    "【概念】戴维南定理｜单口网络等效为电压源串联电阻｜等效电路\n"
    "【关系】\n"
    "前置: 基尔霍夫定律 -> 戴维南定理\n"
    "相关: 戴维南定理 -- 不存在概念\n"
)


def test_generate_graph_end_to_end_with_fake_llm(monkeypatch: pytest.MonkeyPatch) -> None:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)

    with Session(engine) as session:
        course = Course(name="电电")
        session.add(course)
        session.commit()
        session.refresh(course)
        first = Material(
            course_id=course.id or 0, filename="第一章.pdf", stored_path="x", status="ready"
        )
        second = Material(
            course_id=course.id or 0, filename="第二章.pdf", stored_path="y", status="ready"
        )
        session.add(first)
        session.add(second)
        session.commit()
        session.refresh(first)
        session.refresh(second)
        first_id = first.id or 0
        second_id = second.id or 0
        session.add(
            Summary(
                material_id=first_id,
                status="ready",
                key_points=json.dumps(
                    [{"title": "基尔霍夫定律", "detail": "…", "pages": [3]}], ensure_ascii=False
                ),
            )
        )
        session.add(
            Summary(
                material_id=second_id,
                status="ready",
                key_points=json.dumps(
                    [{"title": "戴维南定理", "detail": "…", "pages": [7]}], ensure_ascii=False
                ),
            )
        )
        session.commit()
        course_id = course.id or 0

    async def fake_complete(messages, max_tokens=None, timeout_s=None, model=None) -> str:
        system = messages[0]["content"]
        return _BATCH_REPLY if system == graph_core._BATCH_SYSTEM else _MERGE_REPLY

    monkeypatch.setattr(graph_core.llm, "complete", fake_complete)

    asyncio.run(graph_core.generate_graph(course_id))

    with Session(engine) as session:
        record = session.get(CourseGraph, course_id)
        assert record is not None and record.status == "ready"
        assert "基本定律" in record.overview
        concepts = session.exec(
            select(Concept).where(Concept.course_id == course_id).order_by(Concept.order)
        ).all()
        assert [c.name for c in concepts] == ["基尔霍夫定律", "戴维南定理"]
        by_name = {c.name: c for c in concepts}
        assert by_name["基尔霍夫定律"].material_id == first_id
        assert by_name["基尔霍夫定律"].page == 3
        assert by_name["戴维南定理"].material_id == second_id
        assert by_name["戴维南定理"].page == 7
        assert by_name["基尔霍夫定律"].module == "基础定律"
        edges = session.exec(select(ConceptEdge).where(ConceptEdge.course_id == course_id)).all()
        assert len(edges) == 1
        assert edges[0].relation == "prerequisite"
        assert edges[0].source_id == by_name["基尔霍夫定律"].id
        assert edges[0].target_id == by_name["戴维南定理"].id
