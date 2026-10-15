from collections.abc import AsyncIterator
from typing import Any

from sqlmodel import Session, select

from app.config import settings
from app.core import llm
from app.core.store import search_chunks
from app.models import Material

SYSTEM_PROMPT = (
    "你是课程 AI 助教，服务于大学课程（主要面向电路、信号、电子类课程，也支持其他课程）。"
    "请严格基于提供的课程材料回答学生问题：\n"
    "1. 引用材料时使用格式 [来源: 文件名 第X页]，方便学生核对；\n"
    "2. 不要编造材料中没有的内容；材料不足以回答时，明确说明并建议查阅范围；\n"
    "3. 涉及数学推导时给出关键步骤并解释思路，但鼓励学生自己补全细节；\n"
    "4. 所有数学公式必须用 LaTeX 书写，且只用美元符号定界：行内公式用 $...$，"
    "独立成行的公式用 $$...$$；禁止使用 \\( \\)、\\[ \\] 或方括号包裹公式；"
    "电路量用标准符号（如 $v_{GS}$、$V_{TH}$、$R_1$）；\n"
    "5. 用 Markdown 组织答案：小标题、有序/无序列表、重点加粗，便于阅读；\n"
    "6. 用中文回答，语气耐心，像一位认真的助教。"
)


async def retrieve(
    session: Session, course_id: int, question: str, top_k: int | None = None
) -> list[dict[str, Any]]:
    (query_vec,) = await llm.embed([question])
    hits = search_chunks(session, course_id, query_vec, top_k or settings.top_k)
    names = {
        m.id: m.filename
        for m in session.exec(select(Material).where(Material.course_id == course_id)).all()
    }
    return [
        {
            "material_id": chunk.material_id,
            "material": names.get(chunk.material_id, "未知材料"),
            "page": chunk.page,
            "snippet": chunk.text[:120],
            "text": chunk.text,
            "score": score,
        }
        for chunk, score in hits
    ]


def build_messages(
    question: str, hits: list[dict[str, Any]], history: list[dict] | None = None
) -> list[dict]:
    context = "\n\n".join(
        f"[{i + 1}] {h['text']}\n（来源: {h['material']} 第{h['page']}页）"
        for i, h in enumerate(hits)
    )
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PROMPT}]
    for turn in history or []:
        if turn.get("role") in ("user", "assistant") and turn.get("content"):
            messages.append({"role": turn["role"], "content": turn["content"]})
    messages.append({"role": "user", "content": f"课程材料：\n{context}\n\n学生问题：{question}"})
    return messages


async def stream_answer(
    session: Session, course_id: int, question: str, history: list[dict] | None = None
) -> AsyncIterator[tuple[str, Any]]:
    """依次产出 ("citations", [...]) 和若干 ("delta", 文本片段)。"""
    hits = await retrieve(session, course_id, question)
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
    if not hits:
        yield ("delta", "这门课还没有可检索的材料，请先上传课件或教材（PDF / PPTX）。")
        return
    messages = build_messages(question, hits, history)
    async for piece in llm.chat_stream(messages):
        yield ("delta", piece)
