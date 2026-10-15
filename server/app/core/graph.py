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

_RELATE_SYSTEM = """你是课程知识架构专家。下面是一门课最终确定的概念清单（编号. 概念名｜所属模块｜解释）。
请只为这些概念建立关系网络，不再新增或合并概念。

要求：
1. 概念名必须原样照抄清单，不要改写、不要加括号注释。
2. 「前置」表示学习依赖：箭头 A -> B 意为先掌握 A 才能学 B；链条只沿学习进度向后指，尽量连相邻模块或同模块内的概念。
3. 「相关」表示并列、对照或常一起出现、彼此互不前置的概念。
4. 覆盖面优先：每个概念至少要出现在一条关系里，总量不少于 {min_edges} 条；宁准勿滥，但不要回避明确的关系。

输出格式（严格遵守，每条一行，不要输出其他内容）：
前置: 概念A -> 概念B
相关: 概念C -- 概念D"""

_BATCH_CHAR_BUDGET = 6000
_CONCURRENCY = 3
_MAX_TOKENS_BATCH = 2048
_MAX_TOKENS_MERGE = 6000
_MAX_TOKENS_RELATE = 6000
_TIMEOUT_S = 300.0
_MAX_CANDIDATES = 200
_MAX_CONCEPTS = 64
_MAX_EDGES = 300


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


_EDGE_RE = re.compile(r"^(前置|相关)\s*:\s*(.+?)\s*(?:->|→|-->|--|—>)\s*(.+)$")


def _edge_from_line(line: str) -> dict[str, str] | None:
    edge_match = _EDGE_RE.match(line.replace("：", ":"))
    if not edge_match:
        return None
    return {
        "source": _strip_note(edge_match.group(2))[:40],
        "target": _strip_note(edge_match.group(3))[:40],
        "relation": "prerequisite" if edge_match.group(1) == "前置" else "related",
    }


def parse_relations(text: str) -> list[dict[str, str]]:
    """解析「前置: A -> B」「相关: C -- D」关系行（用于专门的关系抽取轮次）。"""
    edges: list[dict[str, str]] = []
    for raw in text.splitlines():
        edge = _edge_from_line(raw.strip().lstrip("*-•# ").strip())
        if edge and edge["source"] and edge["target"]:
            edges.append(edge)
    return edges


def merge_edges(edges: list[dict[str, str]]) -> list[dict[str, str]]:
    """并集去重：同名（去空白）去重，自环丢弃，「相关」按无向去重，总量封顶。"""
    merged: dict[tuple[str, str, str], dict[str, str]] = {}
    for edge in edges:
        source, target = _norm_name(edge["source"]), _norm_name(edge["target"])
        if not source or not target or source == target:
            continue
        relation = edge["relation"]
        if relation == "related" and target < source:
            source, target = target, source
        merged.setdefault((source, target, relation), edge)
    return list(merged.values())[:_MAX_EDGES]


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
        edge = _edge_from_line(line)
        if edge:
            edges.append(edge)
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


def _concept_listing(modules: list[dict[str, Any]]) -> str:
    """把最终概念清单编号列出，供关系抽取轮次使用。"""
    lines: list[str] = []
    index = 0
    for module in modules:
        for concept in module["concepts"]:
            index += 1
            lines.append(f"{index}. {concept['name']}｜{module['name']}｜{concept['desc'][:50]}")
    return "\n".join(lines)


def resolve_concept(name: str, name_to_id: dict[str, int]) -> int | None:
    """概念名 → id：先精确匹配（去空白后），失败再用唯一包含匹配兜底 LLM 的写法差异。"""
    key = _norm_name(name)
    if not key:
        return None
    if key in name_to_id:
        return name_to_id[key]
    if len(key) < 2:
        return None
    hits = [cid for norm, cid in name_to_id.items() if key in norm or norm in key]
    return hits[0] if len(hits) == 1 else None


def order_modules(modules: list[dict[str, Any]], edges: list[dict[str, str]]) -> list[dict[str, Any]]:
    """按「前置」关系调整模块顺序：A 的概念是 B 概念的前置时，A 排到 B 前面。

    互相依赖（含环）的模块先合并为等价组整体移动，组内保持原顺序；
    并列时以 LLM 给出的原顺序为准，保证确定性与最小改动。
    """
    count = len(modules)
    module_of: dict[str, int] = {}
    for i, module in enumerate(modules):
        for concept in module["concepts"]:
            module_of.setdefault(_norm_name(concept["name"]), i)

    reach = [[False] * count for _ in range(count)]
    for i in range(count):
        reach[i][i] = True
    for edge in edges:
        if edge["relation"] != "prerequisite":
            continue
        source = module_of.get(_norm_name(edge["source"]))
        target = module_of.get(_norm_name(edge["target"]))
        if source is not None and target is not None:
            reach[source][target] = True
    for k in range(count):
        for i in range(count):
            if reach[i][k]:
                for j in range(count):
                    if reach[k][j]:
                        reach[i][j] = True

    # 强连通等价组：代表元 = 组内最小原索引
    group_of = [
        min(j for j in range(count) if reach[i][j] and reach[j][i]) for i in range(count)
    ]
    groups = sorted({group_of[i] for i in range(count)})
    group_deps: dict[int, set[int]] = {g: set() for g in groups}
    # 组级前置：存在 i→j 的直接前置边且不同组
    for edge in edges:
        if edge["relation"] != "prerequisite":
            continue
        source = module_of.get(_norm_name(edge["source"]))
        target = module_of.get(_norm_name(edge["target"]))
        if source is None or target is None:
            continue
        gs, gt = group_of[source], group_of[target]
        if gs != gt:
            group_deps[gt].add(gs)

    ordered_groups: list[int] = []
    pending = set(groups)
    while pending:
        ready = [g for g in sorted(pending) if not (group_deps[g] & pending)]
        pick = ready[0] if ready else min(pending)
        ordered_groups.append(pick)
        pending.discard(pick)

    ordered: list[int] = []
    for g in ordered_groups:
        ordered.extend(i for i in range(count) if group_of[i] == g)
    return [modules[i] for i in ordered]


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
        base_edges = parsed["edges"]
        parsed["modules"] = order_modules(parsed["modules"], base_edges)

        # 专门的关系抽取轮次：合并阶段的注意力在结构上，关系常偏少，这里基于最终概念清单补齐
        concept_count = sum(len(m["concepts"]) for m in parsed["modules"])
        relate_system = _RELATE_SYSTEM.replace("{min_edges}", str(max(30, concept_count)))
        try:
            relate_text = await _complete(
                relate_system, _concept_listing(parsed["modules"]), _MAX_TOKENS_RELATE
            )
            parsed["edges"] = merge_edges(base_edges + parse_relations(relate_text))
        except Exception:  # noqa: BLE001  关系增强失败时保留合并阶段的基础关系
            parsed["edges"] = merge_edges(base_edges)

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
                source = resolve_concept(edge["source"], name_to_id)
                target = resolve_concept(edge["target"], name_to_id)
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
