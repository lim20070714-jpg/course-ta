"""重新提取同一份材料：按「题号|题干」合并，已有详解与作答跟着原题走，只有消失的题才删。

此前是「先删掉该材料全部题目再插入」，重提取一次就把 AI 详解、作答记录、复习卡一起抹掉。
"""

import asyncio
import json
from datetime import UTC, datetime

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core import problems as core
from app.models import Course, Material, Problem

TWO_ITEMS = """【题目】
题号: 1
页码: 1
知识点: 电阻
题干:
求 $R_1$ 上的电压
【/题目】

【题目】
题号: 2
页码: 1
知识点: 电阻
题干:
求 $R_2$ 上的电压
【/题目】
"""

TWO_ITEMS_AGAIN = """【题目】
题号: 1
页码: 1
知识点: 电阻
题干:
求 $R_1$ 上的电压
【/题目】

【题目】
题号: 3
页码: 2
知识点: 电容
题干:
求 $C$ 上的储能
【/题目】
"""

CITATIONS = [{"material_id": 1, "material": "讲义.pdf", "page": 1, "snippet": "分压"}]


@pytest.fixture()
def engine(monkeypatch: pytest.MonkeyPatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as session:
        session.add(Course(id=1, name="电路", created_at=datetime.now(UTC)))
        session.add(Material(id=1, course_id=1, filename="卷.pdf", stored_path="x", kind="exam"))
        session.commit()
    monkeypatch.setattr(db_module, "engine", eng)
    return eng


def _stub(monkeypatch: pytest.MonkeyPatch) -> dict[str, str]:
    """让抽取读到固定页文本、模型回固定输出；返回可改写的输出容器。"""
    box = {"text": TWO_ITEMS}

    async def fake_complete(messages, **kwargs) -> str:
        return box["text"]

    monkeypatch.setattr(core, "extract_pages", lambda path: [(1, "第一页正文"), (2, "第二页正文")])
    monkeypatch.setattr(core.llm, "complete", fake_complete)
    return box


def _problems(engine) -> dict[str, Problem]:
    with Session(engine) as session:
        rows = session.exec(select(Problem).where(Problem.material_id == 1)).all()
        return {row.number: row for row in rows}


def test_reextract_keeps_solution_and_id(engine, monkeypatch: pytest.MonkeyPatch):
    box = _stub(monkeypatch)
    asyncio.run(core.run_extraction(1))
    first = _problems(engine)
    assert set(first) == {"1", "2"}

    with Session(engine) as session:
        row = session.get(Problem, first["1"].id)
        row.solution = "已生成的详解"
        row.solution_citations = json.dumps(CITATIONS, ensure_ascii=False)
        row.solution_model = "qwen2.5:7b"
        session.add(row)
        session.commit()

    box["text"] = TWO_ITEMS_AGAIN
    asyncio.run(core.run_extraction(1))
    again = _problems(engine)

    assert set(again) == {"1", "3"}, "题 2 在这次抽取里消失了，应当删掉"
    assert again["1"].id == first["1"].id, "题号与题干都没变，要沿用原来的行"
    assert again["1"].solution == "已生成的详解"
    assert again["1"].solution_model == "qwen2.5:7b"
    assert json.loads(again["1"].solution_citations) == CITATIONS
    assert again["1"].page == 1
    assert again["3"].id != first["2"].id, "新题是新行，不能复用被删题的 id"


def test_reextract_updates_stem_in_place(engine, monkeypatch: pytest.MonkeyPatch):
    box = _stub(monkeypatch)
    asyncio.run(core.run_extraction(1))
    first = _problems(engine)

    box["text"] = TWO_ITEMS.replace("求 $R_1$ 上的电压", "求 $R_1$ 上的电压与功率")
    asyncio.run(core.run_extraction(1))
    again = _problems(engine)

    assert again["1"].id == first["1"].id, "题干小改仍按题号合并，避免详解与作答丢失"
    assert "功率" in again["1"].stem
