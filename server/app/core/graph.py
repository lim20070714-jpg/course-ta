"""知识图谱：从材料总结中抽取课程概念与关系，形成学科脉络。

两级流程：
1) 按材料把知识点清单分批归纳为候选概念（LLM，并发 3）；
2) 合并候选概念为脉络：总览 + 模块分组 + 概念解释 + 前置/相关关系（LLM）。

锚定：用概念名与关键词回匹配知识点的来源材料与页码，供前端跳转原文。
"""

import asyncio
import json
import re
from typing import Any

from sqlmodel import Session, delete, select

from app import db
from app.config import settings
from app.core import llm
from app.models import Concept, ConceptEdge, CourseGraph, Material, Summary

_BATCH_SYSTEM = """你是课程知识架构专家。下面给出某课程若干讲次的知识点清单。
请把这些内容归纳为核心概念（合并同义概念，保留最常用的名称）：
【概念】概念名｜一句话解释（≤50 字，公式用 $...$）｜关键词1,关键词2,关键词3
每个讲次输出 2~8 个概念，只输出概念行，不要输出其他任何文字。"""

_MERGE_SYSTEM = """你是课程知识架构专家。给你一份课程的候选概念清单，请整理成该课程的知识脉络：
1. 总览：用 5~8 句话概述课程主线与各模块之间的递进关系（公式用 $...$）。
2. 模块：把概念归入 4~8 个按学习顺序排列的模块，模块名体现知识递进。
3. 概念：合并同义概念，总数控制在 20~50 个，每个概念 1~2 句解释（≤60 字）。
4. 关系：标出概念间「前置」（前者是后者的基础）与「相关」关系，尽量形成清晰的先后链路。

输出格式（严格遵守，不要输出其他内容）：
【总览】
……总览文字……
【/总览】
【模块】模块名
【概念】概念名｜解释｜关键词1,关键词2
【概念】……
【模块】下一个模块名
……
【关系】
前置: 概念A -> 概念B
相关: 概念C -- 概念D"""

_BATCH_CHAR_BUDGET = 6000
_CONCURRENCY = 3
_MAX_TOKENS_BATCH = 2048
_MAX_TOKENS_MERGE = 6000
_TIMEOUT_S = 300.0
_MAX_CANDIDATES = 200
_MAX_CONCEPTS = 64


async def _complete(system: str, user: str, max_tokens: int) -> str:
    last: Exception | None = None
    for attempt in (1, 2):  # 瞬时故障（超时/网络）重试一次
        try:
            return await llm.complete(
                [{"role": "system", "content": system}, {"role": "user", "content": user}],
                max_tokens=max_tokens,
                timeout_s=_TIMEOUT_S,
                model=settings.problem_model,
            )
        except Exception as exc:  # noqa: BLE001  重试由外层逻辑处理
            last = exc
            if attempt == 1:
                await asyncio.sleep(2)
    raise last or RuntimeError("LLM 调用失败")


def material_blocks(rows: list[tuple[int, str, list[dict[str, Any]]]]) -> list[tuple[str, str]]:
    """把每个材料的知识点压缩为一行行清单文本（材料，块内容）。"""
    blocks: list[tuple[str, str]] = []
    for _material_id, filename, key_points in rows:
        lines: list[str] = []
        for kp in key_points[:12]:
            title = str(kp.get("title", "")).strip()
            detail = re.sub(r"\s+", " ", str(kp.get("detail", ""))).strip()[:80]
            if title:
                lines.append(f"- {title}：{detail}")
        if lines:
            blocks.append((filename, "\n".join(lines)))
    return blocks


def batch_blocks(blocks: list[tuple[str, str]], budget: int = _BATCH_CHAR_BUDGET) -> list[list[str]]:
    """贪心分批：每批不超过预算字符数，保持材料顺序。"""
    batches: list[list[str]] = []
    current: list[str] = []
    size = 0
    for filename, body in blocks:
        piece = f"《{filename}》\n{body}"
        if current and size + len(piece) > budget:
            batches.append(current)
            current, size = [], 0
        current.append(piece)
        size += len(piece)
    if current:
        batches.append(current)
    return batches


def parse_candidates(text: str) -> list[dict[str, Any]]:
    """解析一级归纳输出：【概念】概念名｜解释｜关键词1,关键词2。"""
    concepts: list[dict[str, Any]] = []
    for raw in text.splitlines():
        line = raw.strip().lstrip("*-•# ").strip()
        if not line.startswith("【概念】"):
            continue
        fields = [f.strip() for f in re.split(r"[｜|]", line[len("【概念】") :])]
        if len(fields) < 2 or not fields[0]:
            continue
        keywords = []
        if len(fields) > 2:
            keywords = [k.strip() for k in re.split(r"[,，]", fields[2]) if k.strip()]
        concepts.append(
            {"name": fields[0][:40], "desc": fields[1][:120], "keywords": keywords[:6]}
        )
    return concepts


def _strip_note(text: str) -> str:
    return re.sub(r"[（(].*$", "", text).strip()


def parse_graph_text(text: str) -> dict[str, Any]:
    """解析二级合并输出：总览 + 模块/概念 + 前置/相关关系。"""
    overview = ""
    match = re.search(r"【总览】([\s\S]*?)(?:【/总览】|【模块】|$)", text)
    if match:
        overview = match.group(1).strip()
    modules: list[dict[str, Any]] = []
    edges: list[dict[str, str]] = []
    current: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = raw.strip().lstrip("*-•# ").strip()
        if not line:
            continue
        line = line.replace("：", ":")
        if line.startswith("【模块】"):
            current = {"name": line[len("【模块】") :].strip() or "其他", "concepts": []}
            modules.append(current)
            continue
        if line.startswith("【概念】"):
            fields = [f.strip() for f in re.split(r"[｜|]", line[len("【概念】") :])]
            if len(fields) < 2 or not fields[0]:
                continue
            if current is None:
                current = {"name": "其他", "concepts": []}
                modules.append(current)
            keywords = []
            if len(fields) > 2:
                keywords = [k.strip() for k in re.split(r"[,，]", fields[2]) if k.strip()]
            current["concepts"].append(
                {"name": fields[0][:40], "desc": fields[1][:120], "keywords": keywords[:6]}
            )
            continue
        if line.startswith("【关系】"):
            continue
        edge_match = re.match(r"^(前置|相关)\s*:\s*(.+?)\s*(?:->|→|-->|--|—>)\s*(.+)$", line)
        if edge_match:
            edges.append(
                {
                    "source": _strip_note(edge_match.group(2))[:40],
                    "target": _strip_note(edge_match.group(3))[:40],
                    "relation": "prerequisite" if edge_match.group(1) == "前置" else "related",
                }
            )
    return {
        "overview": overview,
        "modules": [m for m in modules if m["concepts"]],
        "edges": edges,
    }


def build_index(
    rows: list[tuple[int, str, list[dict[str, Any]]]],
) -> list[dict[str, Any]]:
    """知识点 → 来源索引，用于把概念锚定到材料页。"""
    index: list[dict[str, Any]] = []
    for material_id, filename, key_points in rows:
        for kp in key_points:
            title = str(kp.get("title", "")).strip()
            pages = kp.get("pages") or []
            if title:
                index.append(
                    {
                        "material_id": material_id,
                        "filename": filename,
                        "title": title,
                        "page": pages[0] if pages else 0,
                    }
                )
    return index


def anchor_concept(concept: dict[str, Any], index: list[dict[str, Any]]) -> tuple[int | None, int]:
    """用概念名与关键词匹配知识点标题，返回 (材料 id, 页码)。"""
    for key in [concept.get("name", ""), *concept.get("keywords", [])]:
        key = str(key).strip()
        if len(key) < 2:
            continue
        for row in index:
            if key in row["title"]:
                return row["material_id"], row["page"]
    return None, 0


def _norm_name(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _set_status(course_id: int, status: str, *, error: str = "", overview: str | None = None) -> None:
    with Session(db.engine) as session:
        record = session.get(CourseGraph, course_id) or CourseGraph(course_id=course_id)
        record.status = status
        record.error = error
        if overview is not None:
            record.overview = overview
        session.add(record)
        session.commit()


def _load_inputs(course_id: int) -> list[tuple[int, str, list[dict[str, Any]]]]:
    with Session(db.engine) as session:
        materials = session.exec(
            select(Material).where(Material.course_id == course_id, Material.status == "ready")
        ).all()
        summaries = {
            s.material_id: s
            for s in session.exec(
                select(Summary).where(Summary.material_id.in_([m.id for m in materials]))
            ).all()
        }
    rows: list[tuple[int, str, list[dict[str, Any]]]] = []
    for material in materials:
        summary = summaries.get(material.id)
        if summary is None or summary.status != "ready":
            continue
        try:
            key_points = json.loads(summary.key_points)
        except json.JSONDecodeError:
            continue
        if isinstance(key_points, list) and key_points:
            rows.append((material.id, material.filename, key_points))
    return rows


async def generate_graph(course_id: int) -> None:
    """后台任务：生成课程知识图谱（可重复执行，替换旧数据）。"""
    _set_status(course_id, "generating")
    try:
        rows = _load_inputs(course_id)
        blocks = material_blocks(rows)
        if not blocks:
            raise ValueError("该课程还没有可用的材料总结，请先在课程资料中生成知识点总结")

        batches = batch_blocks(blocks)
        sem = asyncio.Semaphore(_CONCURRENCY)

        async def work(lines: list[str]) -> list[dict[str, Any]]:
            async with sem:
                text = await _complete(_BATCH_SYSTEM, "\n\n".join(lines), _MAX_TOKENS_BATCH)
            return parse_candidates(text)

        results = await asyncio.gather(*(work(b) for b in batches), return_exceptions=True)
        candidates: list[dict[str, Any]] = []
        seen: set[str] = set()
        errors = [str(r) for r in results if isinstance(r, BaseException)]
        for result in results:
            if isinstance(result, BaseException):
                continue
            for concept in result:
                key = _norm_name(concept["name"])
                if key and key not in seen:
                    seen.add(key)
                    candidates.append(concept)
        if not candidates:
            raise ValueError("未能归纳出候选概念" + (f"；{'；'.join(errors[:2])}" if errors else ""))

        listing = "\n".join(
            f"- {c['name']}：{c['desc']}（{'、'.join(c['keywords'])}）"
            for c in candidates[:_MAX_CANDIDATES]
        )
        merged = await _complete(_MERGE_SYSTEM, listing, _MAX_TOKENS_MERGE)
        parsed = parse_graph_text(merged)
        if not parsed["modules"]:
            raise ValueError(f"合并结果解析失败：{merged[:150]!r}")

        index = build_index(rows)
        with Session(db.engine) as session:
            session.exec(delete(ConceptEdge).where(ConceptEdge.course_id == course_id))
            session.exec(delete(Concept).where(Concept.course_id == course_id))
            name_to_id: dict[str, int] = {}
            order = 0
            for module in parsed["modules"]:
                for concept in module["concepts"]:
                    if order >= _MAX_CONCEPTS:
                        break
                    key = _norm_name(concept["name"])
                    if not key or key in name_to_id:
                        continue
                    material_id, page = anchor_concept(concept, index)
                    row = Concept(
                        course_id=course_id,
                        name=concept["name"],
                        description=concept["desc"],
                        module=module["name"],
                        order=order,
                        material_id=material_id,
                        page=page,
                    )
                    session.add(row)
                    session.flush()
                    name_to_id[key] = row.id or 0
                    order += 1
            for edge in parsed["edges"]:
                source = name_to_id.get(_norm_name(edge["source"]))
                target = name_to_id.get(_norm_name(edge["target"]))
                if not source or not target or source == target:
                    continue
                session.add(
                    ConceptEdge(
                        course_id=course_id,
                        source_id=source,
                        target_id=target,
                        relation=edge["relation"],
                    )
                )
            session.commit()
        _set_status(course_id, "ready", overview=parsed["overview"])
    except Exception as exc:  # noqa: BLE001  把失败原因暴露给使用者
        _set_status(course_id, "failed", error=str(exc)[:300])
