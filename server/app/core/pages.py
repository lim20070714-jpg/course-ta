from app.config import settings
from app.models import Chunk


def merge_texts(parts: list[str], max_overlap: int | None = None) -> str:
    """把带重叠的相邻片段拼回连续文本：逐段寻找最长重叠并去除后拼接。"""
    if not parts:
        return ""
    max_overlap = max_overlap or settings.chunk_overlap
    out = parts[0]
    for piece in parts[1:]:
        k = min(max_overlap, len(out), len(piece))
        while k > 0 and not out.endswith(piece[:k]):
            k -= 1
        out += piece[k:]
    return out


def merge_page_chunks(chunks: list[Chunk]) -> dict[int, str]:
    """按页码分组重组文本（依赖 chunks 已按 seq 排序），返回 {页码: 全文}。"""
    grouped: dict[int, list[str]] = {}
    for chunk in chunks:
        grouped.setdefault(chunk.page, []).append(chunk.text)
    return {page: merge_texts(texts) for page, texts in grouped.items()}


def snippet_around(text: str, query: str, width: int = 70) -> str:
    """截取命中位置附近的片段，供搜索结果展示。"""
    pos = text.lower().find(query.lower())
    if pos < 0:
        return text[: width * 2]
    start = max(0, pos - width)
    end = min(len(text), pos + len(query) + width)
    prefix = "…" if start > 0 else ""
    suffix = "…" if end < len(text) else ""
    return f"{prefix}{text[start:end]}{suffix}"


def group_pages(
    pages: list[tuple[int, str]], budget: int
) -> list[list[tuple[int, str]]]:
    """把页面按字符预算分批，避免单次提示过长。"""
    batches: list[list[tuple[int, str]]] = []
    cur: list[tuple[int, str]] = []
    size = 0
    for page_no, text in pages:
        text = text.strip()
        if not text:
            continue
        if cur and size + len(text) > budget:
            batches.append(cur)
            cur, size = [], 0
        cur.append((page_no, text))
        size += len(text)
    if cur:
        batches.append(cur)
    return batches
