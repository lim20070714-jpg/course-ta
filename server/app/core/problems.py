"""题库：从材料中结构化抽取题目；作答批改（步骤级验证）与 AI 详解。"""

import asyncio
import json
import re
from collections.abc import AsyncIterator
from typing import Any

from sqlmodel import Session, delete

from app import db
from app.config import settings
from app.core import llm
from app.core.ingest import extract_pages
from app.core.pages import group_pages
from app.core.rag import retrieve
from app.models import Attempt, Material, Problem

_EXTRACT_CHAR_BUDGET = 4500
_EXTRACT_MAX_TOKENS = 4096

# 抽取任务状态（进程内；服务重启后任务态丢失，但题目数据仍在库中）
_JOBS: dict[int, dict[str, Any]] = {}


def job_status(material_id: int) -> dict[str, Any]:
    job = _JOBS.get(material_id)
    if job is None:
        return {"status": "idle", "error": ""}
    return dict(job)


TEACHER_RULES = (
    "公式必须用 LaTeX 书写且只用美元符号定界（行内 $...$，独立成行 $$...$$），"
    "禁止使用 \\( \\)、\\[ \\]；电路量用标准符号（如 $v_{GS}$、$V_{TH}$、$R_1$）；"
    "用 Markdown 组织内容并保持耐心、鼓励的语气。"
)

EXTRACT_SYSTEM = (
    "你是课程内容结构化助手，负责从大学课程材料（试卷、习题册、讲义）的文本中提取题目。"
    "输入文本带有【第X页】标记；数学符号可能是 Unicode 数学字符（如 𝑉、𝜇、Ω）。\n"
    "对每一道完整的题目，严格按以下格式输出，多个题目依次重复该格式：\n\n"
    "【题目】\n"
    "题号: 一、1\n"
    "页码: 1\n"
    "知识点: 戴维南定理, 电源等效\n"
    "题干:\n"
    "（此处写题干正文，可多行）\n"
    "【解答】\n"
    "（此处写解答正文，可多行；若材料没有解答则整行留空）\n"
    "【/题目】\n\n"
    "要求：\n"
    "1. 题干完整保留所有小题（1）2）…）与选项；所有数学符号转为 LaTeX 并用 $...$ 定界"
    "（如 $V_{DD}$、$\\mu_n C_{ox}$、$v_{GS}$、$\\Omega$）；即使题干提到「如下图」也照抄文字；\n"
    "2. 去掉页眉页脚、姓名学号栏、考试说明、分值标注等与题目无关的内容；\n"
    "3. 【解答】部分只在材料本身包含解答/答案/解析时填写，整理为 Markdown（公式同样 $...$）；\n"
    "4. 知识点为 1~4 个中文标签，使用课程通用术语"
    "（如：戴维南定理、二极管、MOSFET、小信号分析、运算放大器、反馈、逻辑门）；\n"
    "5. 不是题目的片段（目录、公式表、纯图片页说明等）跳过不输出；\n"
    "6. 除上述格式内容外，不要输出任何其它文字。"
)

GRADE_SYSTEM = (
    "你是课程助教，正在批改学生对一道题目的作答，做步骤级验证。\n"
    "输出要求：\n"
    "1. 第一行严格输出判定标记，只能以下四种之一：【判定】正确、【判定】部分正确、"
    "【判定】错误、【判定】无法判断；\n"
    "2. 空一行后给出分步反馈（Markdown）：先逐条对照学生的步骤，指出对在哪里、错在哪里"
    "（引用学生的原话），再点出缺失的关键步骤或未讨论的情况（如漏掉某个工作区），"
    "最后给出改进后的关键步骤——不要给出完整答案，引导学生自己完成；\n"
    "3. " + TEACHER_RULES + "\n"
    "4. 若材料没有参考答案，先自行求解再核对学生作答，不确定处明确说明；"
    "若题目依赖不可见的电路图等信息，说明基于文字部分的判断可能不完整。"
)

HINT_SYSTEM = (
    "你是课程助教。学生正在思考一道题，请给一段简短的「思路提示」，帮助学生自己找到方向：\n"
    "1. 点明该题考查的核心概念或该从哪一步下手（如用哪个定律、先分析哪个工作区、注意什么条件）；\n"
    "2. 最多 3 句话，不要给出最终答案、关键数值，也不要列出完整解题步骤；\n"
    "3. " + TEACHER_RULES
)

SOLUTION_SYSTEM = (
    "你是课程助教，请为下面这道题写出完整、严谨的解答。\n"
    "1. 先写「**思路**」简述解题方向，再写「**解答**」按步骤推导，每步注明依据"
    "（如 KVL、饱和区条件 $v_{DS} > v_{GS} - V_{TH}$）；\n"
    "2. 引用课程材料时使用格式 [来源: 文件名 第X页]；\n"
    "3. 若题目依赖不可见的电路图等信息，先说明你的假设，再按常规理解作答；\n"
    "4. 结尾用一两句话总结本题涉及的知识点。\n"
    "5. " + TEACHER_RULES
)


def _batch_prompt(batch: list[tuple[int, str]]) -> str:
    body = "\n\n".join(f"【第{p}页】\n{t}" for p, t in batch)
    return f"请提取以下材料文本中的全部题目：\n\n{body}"


def parse_problems_text(text: str) -> list[dict[str, Any]]:
    """解析「【题目】…【/题目】」标记格式；对 LaTeX 与引号天然免疫，比 JSON 更适合小模型。"""
    blocks = text.split("【题目】")[1:]
    items: list[dict[str, Any]] = []
    for block in blocks:
        end = block.find("【/题目】")
        if end >= 0:
            block = block[:end]
        number = ""
        page_raw = ""
        tags: list[str] = []
        stem_lines: list[str] = []
        answer_lines: list[str] = []
        section = "head"
        for raw_line in block.splitlines():
            line = raw_line.strip()
            plain = line.replace("**", "").replace("：", ":")
            if section == "head" and plain.startswith("题号"):
                number = plain.split(":", 1)[1].strip() if ":" in plain else ""
            elif section == "head" and plain.startswith("页码"):
                page_raw = plain.split(":", 1)[1].strip() if ":" in plain else ""
            elif section == "head" and plain.startswith(("知识点", "考点")):
                value = plain.split(":", 1)[1] if ":" in plain else ""
                tags = [s.strip() for s in re.split(r"[、,，;/|]", value) if s.strip()]
            elif section == "head" and plain.startswith("题干"):
                section = "stem"
                rest = plain.split(":", 1)[1].strip() if ":" in plain else ""
                if rest:
                    stem_lines.append(rest)
            elif section == "stem" and line.strip("【】") in ("解答", "答案", "参考答案"):
                section = "answer"
            elif section == "answer" and line.startswith("【"):
                break
            elif section == "stem":
                stem_lines.append(raw_line.rstrip())
            elif section == "answer":
                answer_lines.append(raw_line.rstrip())
        stem = "\n".join(stem_lines).strip()
        if not stem:
            continue
        answer = "\n".join(answer_lines).strip()
        if re.fullmatch(r"[（(][^（()）]{0,60}[)）]", answer):  # 模板占位语
            answer = ""
        m = re.search(r"\d+", page_raw)
        items.append(
            {
                "page": int(m.group()) if m else 0,
                "number": number,
                "stem": stem,
                "knowledge": tags[:6],
                "answer": answer,
            }
        )
    return items


_FENCE_RE = re.compile(r"```(?:json)?\s*([\s\S]*?)```")


def parse_problems_json(text: str) -> list[dict[str, Any]]:
    """兜底解析：模型偶尔仍输出 JSON 时使用（容忍代码块与多余文字）。"""
    raw = text.strip()
    fence = _FENCE_RE.search(raw)
    if fence:
        raw = fence.group(1).strip()
    start, end = raw.find("["), raw.rfind("]")
    if start >= 0 and end > start:
        data = json.loads(raw[start : end + 1])
    else:
        start, end = raw.find("{"), raw.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型输出中没有找到 JSON")
        data = [json.loads(raw[start : end + 1])]
    if not isinstance(data, list):
        raise TypeError("模型输出不是 JSON 数组")
    return [item for item in data if isinstance(item, dict)]


def _parse_output(text: str) -> list[dict[str, Any]]:
    items = parse_problems_text(text)
    if items:
        return items
    try:
        return parse_problems_json(text)
    except (ValueError, TypeError, json.JSONDecodeError):
        return []


def _normalize_item(item: dict[str, Any], max_page: int) -> dict[str, Any] | None:
    stem = str(item.get("stem") or "").strip()
    if not stem:
        return None
    try:
        page = int(item.get("page") or 0)
    except (TypeError, ValueError):
        page = 0
    if max_page > 0:
        page = min(max(0, page), max_page)
    raw_tags = item.get("knowledge") or []
    if isinstance(raw_tags, str):
        tags = [s.strip() for s in re.split(r"[、,，;/|]", raw_tags) if s.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(s).strip() for s in raw_tags if str(s).strip()]
    else:
        tags = []
    return {
        "page": page,
        "number": str(item.get("number") or "").strip()[:40],
        "stem": stem,
        "answer": str(item.get("answer") or "").strip(),
        "knowledge": json.dumps(tags[:6], ensure_ascii=False),
    }


async def run_extraction(material_id: int) -> None:
    """后台任务：解析材料页文本 -> LLM 结构化 -> 写入题目（可重复执行，替换旧数据）。"""
    _JOBS[material_id] = {"status": "running", "error": ""}
    try:
        with Session(db.engine) as session:
            material = session.get(Material, material_id)
            if material is None:
                raise ValueError("材料不存在")
            course_id, path = material.course_id, material.stored_path

        pages = extract_pages(path)
        max_page = max((p for p, _ in pages), default=0)
        batches = group_pages(pages, _EXTRACT_CHAR_BUDGET)
        if not batches:
            raise ValueError("材料中没有可提取的文本")

        items: list[dict[str, Any]] = []
        seen: set[str] = set()
        errors: list[str] = []
        for batch in batches:
            label = f"第{batch[0][0]}-{batch[-1][0]}页"
            retry_note = (
                "\n\n注意：请严格按照【题目】…【/题目】的标记格式输出，"
                "每个题目都必须包含 题号/页码/知识点/题干 四行标记，不要输出任何解释文字。"
            )
            try:
                parsed: list[dict[str, Any]] = []
                last_error: Exception | None = None
                for attempt in (1, 2):  # 瞬时故障（超时/网络）或格式不合格时重试一次
                    try:
                        text = await llm.complete(
                            [
                                {"role": "system", "content": EXTRACT_SYSTEM},
                                {
                                    "role": "user",
                                    "content": _batch_prompt(batch)
                                    + (retry_note if attempt == 2 else ""),
                                },
                            ],
                            max_tokens=_EXTRACT_MAX_TOKENS,
                            timeout_s=300.0,
                            model=settings.problem_model,
                        )
                        parsed = _parse_output(text)
                        if parsed:
                            break
                        last_error = ValueError(f"模型输出中没有解析出题目：{text[:150]!r}")
                    except Exception as exc:  # noqa: BLE001  重试由外层逻辑处理
                        last_error = exc
                    if attempt == 1:
                        await asyncio.sleep(2)
                if not parsed:
                    raise last_error or ValueError("抽取失败")
            except Exception as exc:  # noqa: BLE001  单批失败不拖垮整体
                errors.append(f"{label}: {exc}")
                continue
            for item in parsed:
                norm = _normalize_item(item, max_page)
                if norm is None:
                    continue
                key = f"{norm['number']}|{norm['stem'][:80]}"
                if key in seen:
                    continue
                seen.add(key)
                items.append(norm)

        if not items:
            raise ValueError(
                "未能从材料中提取出题目（可能不是题目类材料）"
                + (f"；{ '；'.join(errors)}" if errors else "")
            )

        with Session(db.engine) as session:
            session.exec(delete(Problem).where(Problem.material_id == material_id))
            for n in items:
                session.add(
                    Problem(
                        course_id=course_id,
                        material_id=material_id,
                        page=n["page"],
                        number=n["number"],
                        stem=n["stem"],
                        answer=n["answer"],
                        knowledge=n["knowledge"],
                    )
                )
            session.commit()
        note = "；".join(errors)[:200] if errors else ""
        _JOBS[material_id] = {"status": "done", "error": note, "count": len(items)}
    except Exception as exc:  # noqa: BLE001  把失败原因暴露给使用者
        _JOBS[material_id] = {"status": "failed", "error": str(exc)[:300]}


_VERDICT_RE = re.compile(r"【判定】\s*(部分正确|正确|错误|无法判断)")
_VERDICT_MAP = {"正确": "correct", "部分正确": "partial", "错误": "wrong", "无法判断": "unknown"}


def detect_verdict(text: str) -> str | None:
    m = _VERDICT_RE.search(text)
    return _VERDICT_MAP[m.group(1)] if m else None


async def generate_hint(problem: Problem) -> str:
    """一句话级别的方向提示：不泄露答案，引导学生自己做。"""
    tags = "、".join(parse_tags(problem.knowledge))
    prompt = f"题目（{problem.number or '未编号'}）：\n{problem.stem}"
    if tags:
        prompt += f"\n（知识点：{tags}）"
    hint = await llm.complete(
        [
            {"role": "system", "content": HINT_SYSTEM},
            {"role": "user", "content": prompt},
        ],
        max_tokens=400,
        timeout_s=120.0,
        model=settings.problem_model,
    )
    return hint.strip()


async def stream_grade(problem: Problem, student_answer: str) -> AsyncIterator[tuple[str, Any]]:
    """批改流：产出 ("verdict", 判定) 至多一次和若干 ("delta", 文本片段)；结束前存作答记录。"""
    ref = (
        f"\n参考答案与解析：\n{problem.answer}\n"
        if problem.answer
        else "\n（本题材料中没有参考答案）\n"
    )
    messages = [
        {"role": "system", "content": GRADE_SYSTEM},
        {
            "role": "user",
            "content": (
                f"题目（{problem.number or '未编号'}）：\n{problem.stem}\n{ref}\n"
                f"学生作答：\n{student_answer}"
            ),
        },
    ]
    acc = ""
    verdict_sent = False
    async for piece in llm.chat_stream(messages):
        acc += piece
        if not verdict_sent:
            verdict = detect_verdict(acc)
            if verdict:
                verdict_sent = True
                yield ("verdict", verdict)
        yield ("delta", piece)
    if not verdict_sent:
        yield ("verdict", "unknown")
    with Session(db.engine) as session:
        session.add(
            Attempt(
                problem_id=problem.id or 0,
                answer_text=student_answer,
                verdict=detect_verdict(acc) or "unknown",
                feedback=acc,
            )
        )
        session.commit()


async def stream_solution(session: Session, problem: Problem) -> AsyncIterator[tuple[str, Any]]:
    """AI 详解流：先产出 ("citations", [...]), 再不断产出 ("delta", 文本片段)。"""
    hits = await retrieve(session, problem.course_id, problem.stem[:300], top_k=4)
    yield (
        "citations",
        [
            {
                "material_id": h["material_id"],
                "material": h["material"],
                "page": h["page"],
                "snippet": h["snippet"],
            }
            for h in hits
        ],
    )
    context = "\n\n".join(
        f"[{i + 1}] {h['text']}\n（来源: {h['material']} 第{h['page']}页）" for i, h in enumerate(hits)
    )
    ref = f"\n参考答案（材料自带，供参考，如有误请以你的推导为准）：\n{problem.answer}\n" if problem.answer else ""
    messages = [
        {"role": "system", "content": SOLUTION_SYSTEM},
        {
            "role": "user",
            "content": f"题目（{problem.number or '未编号'}）：\n{problem.stem}\n{ref}\n课程材料节选：\n{context}",
        },
    ]
    async for piece in llm.chat_stream(messages):
        yield ("delta", piece)


def parse_tags(raw: str) -> list[str]:
    try:
        value = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(value, list):
        return []
    return [str(x) for x in value]
