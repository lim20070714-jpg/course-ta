"""材料总结：从入库文本生成「整体总结 + 知识点列表（带页码）」，供资料分区展示与跳转。

理工科优化：优先提取定义、定理、关键公式、方法与结论；允许模型依据语义与主题
推断补全提取错误，但要求知识点标注来源页码。
"""

import asyncio
import json
import re
from typing import Any

from sqlmodel import Session, select

from app import db
from app.config import settings
from app.core import llm
from app.core.pages import group_pages, merge_page_chunks
from app.models import Chunk, Material, Summary

_BATCH_BUDGET = 5000
_MAX_BATCHES = 12  # 超大材料按均匀采样限制批次数，控制成本
_MAX_POINTS = 32
_STAGE_CONCURRENCY = 3
_MAX_TOKENS = 4096
_TIMEOUT_S = 300.0

_STEM_RULES = (
    "这是理工科（电子、电路、物理、数学）课程材料。优先提取：定义、定理/定律、"
    "关键公式、典型方法与步骤、重要结论、易错点。数学公式用 LaTeX 且只用 $...$ 定界"
    "（如 $v_{GS} > V_{TH}$）。可以依据前后语义与主题合理推断、修正识别错误或补全"
    "被截断的片段，但不得编造与该页主题无关的内容。"
)

_POINT_FORMAT = (
    "【知识点】\n"
    "标题: 戴维南定理\n"
    "页码: 12\n"
    "说明:\n"
    "（1~4 句话讲清定义/结论/适用条件/怎么用，含关键公式）\n"
    "【/知识点】"
)

SINGLE_SYSTEM = (
    "你是理工科课程学习助手，请把输入的课件文本整理为一份学习笔记，包含整体总结与知识点。\n"
    + _STEM_RULES
    + "\n输出两部分，先总结后知识点，格式如下：\n\n"
    "【总结】\n"
    "（200~400 字：这份材料讲了什么、知识主线、最重要的方法与结论）\n"
    "【/总结】\n\n"
    + _POINT_FORMAT
    + "\n（多个知识点依次重复）\n\n"
    "要求：\n"
    "1. 页码必须来自输入中的【第X页】标记，取该知识点主要所在页；\n"
    "2. 标题简洁（不超过 14 字），如「戴维南定理」「MOSFET 饱和区条件」；\n"
    "3. 跳过封面、目录、致谢、作业布置等无知识含量的内容；\n"
    "4. 知识点数量按实际内容定，不强行拆分或合并；\n"
    "5. 除上述格式内容外，不要输出任何其它文字。"
)

BATCH_SYSTEM = (
    "你是理工科课程学习助手，正在分批阅读一份较长的材料，请从本批文本中提取知识点。\n"
    + _STEM_RULES
    + "\n对每个知识点按以下格式输出（多个依次重复）：\n\n"
    + _POINT_FORMAT
    + "\n\n要求：标题简洁（不超过 14 字）；页码来自输入的【第X页】标记；"
    "跳过目录、致谢、作业布置等无知识含量的内容；只输出格式内容，不要任何其它文字。"
)

MERGE_SYSTEM = (
    "你是理工科课程学习助手。下面是从同一份材料不同批次提取出的知识点清单（含页码），"
    "请合并重复或高度相似的知识点，并输出整体总结与最终知识点列表：\n\n"
    "【总结】\n"
    "（200~400 字：这份材料讲了什么、知识主线、最重要的方法与结论）\n"
    "【/总结】\n\n"
    + _POINT_FORMAT
    + "\n\n要求：\n"
    "1. 合并同主题条目（如分散在多页的同一方法），页码保留多个并用逗号分隔；\n"
    "2. 按材料的讲授顺序排列，知识点总数不超过 32 个；\n"
    "3. "
    + _STEM_RULES
    + "\n4. 只输出上述格式内容，不要任何其它文字。"
)

_JOBS: dict[int, dict[str, Any]] = {}


def job_status(material_id: int) -> dict[str, Any]:
    job = _JOBS.get(material_id)
    if job is None:
        return {"status": "idle", "error": ""}
    return dict(job)


def material_pages(session: Session, material_id: int) -> list[tuple[int, str]]:
    """从入库分块合并出页面文本（已含 v2 解析与 LLM 修复的成果）。"""
    rows = session.exec(
        select(Chunk).where(Chunk.material_id == material_id).order_by(Chunk.seq)
    ).all()
    return sorted(merge_page_chunks(list(rows)).items())


def _batch_prompt(batch: list[tuple[int, str]]) -> str:
    body = "\n\n".join(f"【第{p}页】\n{t}" for p, t in batch)
    return f"请整理以下材料文本：\n\n{body}"


def _normalize_label(line: str) -> str:
    return line.replace("**", "").replace("：", ":").strip()


_BULLET_PREFIX = re.compile(r"^(?:[-*•#>]+\s*|\d+[.、)）．]\s*)+")
_TITLE_RE = re.compile(r"^标题\s*:")
_PAGES_RE = re.compile(r"^页码\s*:")
_DETAIL_RE = re.compile(r"^说明\s*:")


def parse_summary_text(text: str) -> dict[str, Any]:
    """解析「【总结】/【知识点】」标记格式。

    知识点以「标题:」行锚定逐个成块：模型（尤其合并阶段）常漏写后续条目的
    【知识点】分隔标记，此时若只按标记切块会把多条并成一条。
    """
    overview = ""
    m = re.search(r"【总结】([\s\S]*?)(?:【/总结】|【知识点】|$)", text)
    if m:
        overview = m.group(1).strip()

    points: list[dict[str, Any]] = []
    cur: dict[str, Any] | None = None
    in_detail = False

    def flush() -> None:
        nonlocal cur, in_detail
        if cur is not None:
            title = cur["title"].strip()
            detail = "\n".join(cur["detail"]).strip()
            if title and detail:
                pages = [int(n) for n in re.findall(r"\d+", cur["pages"])][:4]
                points.append({"title": title[:40], "detail": detail, "pages": pages})
        cur = None
        in_detail = False

    for raw_line in text.splitlines():
        line = _BULLET_PREFIX.sub("", _normalize_label(raw_line))
        if _TITLE_RE.match(line):
            flush()
            cur = {
                "title": line.split(":", 1)[1].strip(),
                "pages": "",
                "detail": [],
            }
            continue
        if cur is None or line.startswith("【"):
            continue
        if not in_detail and _PAGES_RE.match(line):
            cur["pages"] = line.split(":", 1)[1]
            continue
        if not in_detail and _DETAIL_RE.match(line):
            in_detail = True
            rest = line.split(":", 1)[1].strip()
            if rest:
                cur["detail"].append(rest)
            continue
        if in_detail:
            cur["detail"].append(raw_line.rstrip())
    flush()
    return {"overview": overview, "key_points": points[:_MAX_POINTS]}


def _sample_batches(batches: list[list[tuple[int, str]]]) -> list[list[tuple[int, str]]]:
    """批次数超上限时均匀采样，首尾保留。"""
    if len(batches) <= _MAX_BATCHES:
        return batches
    step = (len(batches) - 1) / (_MAX_BATCHES - 1)
    return [batches[round(i * step)] for i in range(_MAX_BATCHES)]


def _merge_prompt(points: list[dict[str, Any]]) -> str:
    lines: list[str] = []
    for p in points:
        pages = ", ".join(str(x) for x in p["pages"]) or "?"
        detail = p["detail"].strip()
        if len(detail) > 220:
            detail = detail[:220] + "…"
        lines.append(f"标题: {p['title']}\n页码: {pages}\n说明:\n{detail}")
    return "知识点清单：\n\n" + "\n\n".join(lines)


async def _parse_call(system: str, user: str) -> dict[str, Any] | None:
    try:
        out = await llm.complete(
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            max_tokens=_MAX_TOKENS,
            timeout_s=_TIMEOUT_S,
            model=settings.problem_model,
        )
    except Exception:  # noqa: BLE001 单批失败不致命，丢弃该批结果
        return None
    parsed = parse_summary_text(out)
    return parsed if parsed["key_points"] or parsed["overview"] else None


async def _generate(pages: list[tuple[int, str]]) -> dict[str, Any]:
    batches = _sample_batches(group_pages(pages, _BATCH_BUDGET))
    if not batches:
        raise ValueError("没有可用于总结的文本")
    if len(batches) == 1:
        parsed = await _parse_call(SINGLE_SYSTEM, _batch_prompt(batches[0]))
        if parsed is None:
            raise RuntimeError("总结生成失败（模型调用失败或输出无法解析）")
        return parsed
    sem = asyncio.Semaphore(_STAGE_CONCURRENCY)

    async def work(batch: list[tuple[int, str]]) -> dict[str, Any] | None:
        async with sem:
            return await _parse_call(BATCH_SYSTEM, _batch_prompt(batch))

    stage = [p for p in await asyncio.gather(*(work(b) for b in batches)) if p]
    points = [kp for p in stage for kp in p["key_points"]]
    overviews = [p["overview"] for p in stage if p["overview"]]
    if not points:
        raise RuntimeError("总结生成失败（模型调用失败或输出无法解析）")
    user = _merge_prompt(points)
    if overviews:
        user += "\n\n各批次的初步总结（供参考）：\n" + "\n".join(f"- {o[:300]}" for o in overviews)
    merged = await _parse_call(MERGE_SYSTEM, user)
    if merged is None or not merged["key_points"]:
        # 合并失败时退回分批结果
        return {"overview": "\n\n".join(overviews)[:2000], "key_points": points[:_MAX_POINTS]}
    return merged


async def generate_summary(material_id: int) -> None:
    """后台任务：生成/更新材料的总结与知识点（可重复执行，覆盖旧结果）。"""
    _JOBS[material_id] = {"status": "generating", "error": ""}
    try:
        with Session(db.engine) as session:
            material = session.get(Material, material_id)
            if material is None:
                raise ValueError("材料不存在")
            pages = material_pages(session, material_id)
            row = session.get(Summary, material_id) or Summary(material_id=material_id)
            row.status = "generating"
            row.error = ""
            session.add(row)
            session.commit()
        if not pages:
            raise ValueError("材料还没有可用的入库文本，请先完成解析")
        result = await _generate(pages)
        with Session(db.engine) as session:
            row = session.get(Summary, material_id) or Summary(material_id=material_id)
            row.overview = result["overview"]
            row.key_points = json.dumps(result["key_points"], ensure_ascii=False)
            row.status = "ready"
            row.error = ""
            session.add(row)
            session.commit()
        _JOBS[material_id] = {"status": "done", "error": ""}
    except Exception as exc:  # noqa: BLE001 总结失败不影响材料本身
        message = (str(exc) or type(exc).__name__)[:300]
        with Session(db.engine) as session:
            row = session.get(Summary, material_id) or Summary(material_id=material_id)
            row.status = "failed"
            row.error = message
            session.add(row)
            session.commit()
        _JOBS[material_id] = {"status": "failed", "error": message}


def load_summary(session: Session, material_id: int) -> dict[str, Any]:
    """读取总结（合并进程内任务状态，供 API 展示）。"""
    row = session.get(Summary, material_id)
    job = job_status(material_id)
    if row is None:
        return {
            "material_id": material_id,
            "status": "pending" if job["status"] == "idle" else job["status"],
            "overview": "",
            "key_points": [],
            "error": job["error"],
        }
    try:
        points = json.loads(row.key_points)
    except json.JSONDecodeError:
        points = []
    status = row.status
    if job["status"] == "generating":
        status = "generating"
    return {
        "material_id": material_id,
        "status": status,
        "overview": row.overview,
        "key_points": points,
        "error": row.error or job["error"],
    }
