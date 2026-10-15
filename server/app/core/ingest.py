import asyncio
import re
import unicodedata
from pathlib import Path

import pymupdf
from pptx import Presentation
from sqlmodel import Session, delete

from app import db
from app.config import settings
from app.core import llm, summary
from app.core.glyph_tables import (
    GLITCH_CHAR_MAP,
    GLITCH_DROP,
    SYMBOL_MAP,
    WINGDING2_MAP,
    WINGDING_MAP,
)
from app.core.store import to_blob
from app.models import Chunk, Material

_EMBED_BATCH = 16
_EMBED_ATTEMPTS = 3

# 行聚类参数：垂直重叠比、同行片段间的空格阈值
_ROW_OVERLAP = 0.45
_SPACE_GAP = 0.3

# 定界符组合件（大括号/大括号的分段字形）→ 实际定界符
_DELIM_PIECES = {
    "⎛": "(", "⎜": "(", "⎝": "(",
    "⎡": "[", "⎢": "[", "⎣": "[",
    "⎧": "{", "⎨": "{", "⎩": "{", "⎪": "{",
    "⎞": ")", "⎟": ")", "⎠": ")",
    "⎤": "]", "⎥": "]", "⎦": "]",
    "⎫": "}", "⎬": "}", "⎭": "}",
    "⌠": "∫", "⎮": "∫", "⌡": "∫",
}
_DELIM_RUN = re.compile(r"([()\[\]{}])\s+(?=\1)")

# LLM 修复：乱码/碎片达到阈值才送修，单个材料最多修这么多页
_REPAIR_MIN_SCORE = 4
_REPAIR_MAX_PAGES = 60
_REPAIR_CONCURRENCY = 4
_REPAIR_SYSTEM = (
    "你是课程讲义排版修复助手。输入是 PDF 提取出的原始页面文本，常见问题："
    "排版碎片化（一行只剩几个字）、公式被拆成多行、字符乱码（□ 表示无法识别的字符）。"
    "请整理为通顺的 Markdown 文本：数学公式用 LaTeX（行内 $...$），分式写作 \\frac{}{}"
    "或 (分子)/(分母)；可以依据上下文修复明显的提取错误（如公式错位、拆分），"
    "但不要新增原文没有的内容；无法辨认处保留 □。只输出整理后的正文，不要解释。"
)


def extract_pages(path: str | Path) -> list[tuple[int, str]]:
    """提取文档每一页/每张幻灯片的文本，返回 [(页码, 文本), ...]。"""
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".pdf":
        return [(i, text) for i, text, _score in _extract_pdf(p)]
    if suffix == ".pptx":
        return _extract_pptx(p)
    if suffix in (".txt", ".md"):
        return [(1, p.read_text(encoding="utf-8", errors="ignore"))]
    if suffix == ".ppt":
        raise ValueError("旧版 .ppt 不受支持，请另存为 .pptx 后重新上传")
    raise ValueError(f"不支持的文件类型: {suffix}")


def _font_family(name: str, codes: set[int]) -> str:
    """按字体名与用到的码点判定解码表（匿名子集靠 0x80-0x9F 码点区分 Wingdings）。"""
    low = name.lower()
    if "wingdings 2" in low or "wingdings2" in low:
        return "wingding2"
    if "wingdings 3" in low or "wingdings3" in low:
        return "wingding3"
    if "wingding" in low or "webding" in low:
        return "wingding1"
    if "symbol" not in low and any(0x7F <= c <= 0x9F for c in codes):
        return "wingding1"
    return "symbol"


def _decode_span(text: str, family: str) -> tuple[str, int]:
    """把 PUA 与乱码码点还原为可读字符，返回 (文本, 丢失字符数)。"""
    table = {
        "symbol": SYMBOL_MAP, "wingding1": WINGDING_MAP, "wingding2": WINGDING2_MAP,
        "wingding3": WINGDING_MAP,
    }[family]
    out: list[str] = []
    lost = 0
    for c in text:
        o = ord(c)
        if 0xE000 <= o <= 0xF8FF:
            rep = table.get(o - 0xF000)
            if rep is None:
                out.append("□")
                lost += 1
            else:
                out.append(rep)
        elif c in GLITCH_CHAR_MAP:
            out.append(GLITCH_CHAR_MAP[c])
        elif 0x0900 <= o <= 0x0DFF or c in GLITCH_DROP:
            lost += 1
        elif 0x1D400 <= o <= 0x1D7FF or 0xFB00 <= o <= 0xFB4F:
            out.append(unicodedata.normalize("NFKC", c))
        else:
            out.append(c)
    return "".join(out), lost


def _rows_from_spans(spans: list[tuple[float, float, float, float, float, str]]) -> list[str]:
    """把同一文本块内的 span 按垂直重叠聚成视觉行，再按 x 顺序拼接。

    spans: [(x0, y0, x1, y1, size, text)]。修复 PyMuPDF 在 2D 公式/分散排版下
    把一行拆成多个碎片行的问题。
    """
    rows: list[dict] = []
    for x0, y0, x1, y1, size, text in sorted(spans, key=lambda s: (s[1], s[0])):
        h = max(1e-3, y1 - y0)
        best: dict | None = None
        best_ratio = 0.0
        for row in rows:
            overlap = min(row["y1"], y1) - max(row["y0"], y0)
            if overlap > 0:
                ratio = overlap / max(1e-3, min(row["h"], h))
                if ratio > best_ratio:
                    best_ratio, best = ratio, row
        if best is not None and best_ratio > _ROW_OVERLAP:
            best["y0"] = min(best["y0"], y0)
            best["y1"] = max(best["y1"], y1)
            best["h"] = best["y1"] - best["y0"]
            best["spans"].append((x0, x1, size, text))
        else:
            rows.append({"y0": y0, "y1": y1, "h": h, "spans": [(x0, x1, size, text)]})
    rows.sort(key=lambda r: (r["y0"], min(s[0] for s in r["spans"])))
    lines: list[str] = []
    for row in rows:
        row["spans"].sort(key=lambda s: s[0])
        parts: list[str] = []
        prev_x1: float | None = None
        prev_size = 0.0
        for x0, x1, size, text in row["spans"]:
            if parts and prev_x1 is not None and x0 - prev_x1 > _SPACE_GAP * max(prev_size, size):
                parts.append(" " + text)
            else:
                parts.append(text)
            prev_x1, prev_size = x1, size
        line = "".join(parts).strip()
        if line:
            lines.append(line)
    return lines


def _collapse_delimiter_pieces(text: str) -> tuple[str, int]:
    """把大定界符组合件映射为定界符，并合并重复（跨行）的同一个定界符。"""
    pieces = sum(text.count(p) for p in _DELIM_PIECES)
    for piece, delim in _DELIM_PIECES.items():
        text = text.replace(piece, delim)
    prev = None
    while prev != text:
        prev = text
        text = _DELIM_RUN.sub("", text)
    return text, pieces


def _frag_score(text: str) -> int:
    """排版碎片评分：2D 公式/矩阵被拆成大量短行（一行只有几个字）的诊断信号。"""
    short = sum(1 for line in text.split("\n") if 0 < len(line.strip()) <= 2)
    return min(short, 60) // 3


def _page_text(page: pymupdf.Page) -> tuple[str, int]:
    """单页抽取：按块做行聚类重建视觉行，按字体解码 PUA 与乱码字符。

    返回 (页面文本, 质量评分)；评分 = 无法还原的字符数 + 定界符组合件数 + 碎片分。
    """
    data = page.get_text("rawdict")
    font_codes: dict[str, set[int]] = {}
    for block in data["blocks"]:
        if block["type"] != 0:
            continue
        for line in block["lines"]:
            for span in line["spans"]:
                for ch in span["chars"]:
                    o = ord(ch["c"]) if len(ch["c"]) == 1 else 0
                    if 0xE000 <= o <= 0xF8FF:
                        font_codes.setdefault(span["font"], set()).add(o - 0xF000)
    families = {name: _font_family(name, codes) for name, codes in font_codes.items()}

    lost = 0
    blocks_out: list[str] = []
    for block in data["blocks"]:
        if block["type"] != 0:
            continue
        spans: list[tuple[float, float, float, float, float, str]] = []
        for line in block["lines"]:
            for span in line["spans"]:
                raw = "".join(ch["c"] for ch in span["chars"])
                text, n_lost = _decode_span(raw, families.get(span["font"], "symbol"))
                lost += n_lost
                if text.strip():
                    x0, y0, x1, y1 = span["bbox"]
                    spans.append((x0, y0, x1, y1, float(span["size"]), text))
        rows = _rows_from_spans(spans)
        if rows:
            blocks_out.append("\n".join(rows))
    text = "\n".join(blocks_out)
    text, pieces = _collapse_delimiter_pieces(text)
    return text, lost + pieces + _frag_score(text)


def _extract_pdf(p: Path) -> list[tuple[int, str, int]]:
    """PyMuPDF 页面抽取（v2）：行聚类 + PUA/乱码解码，附乱码评分。"""
    with pymupdf.open(str(p)) as doc:
        return [(i + 1, *(_page_text(page))) for i, page in enumerate(doc)]


def _extract_pptx(p: Path) -> list[tuple[int, str]]:
    """按段落抽取并保留大纲层级（缩进 + •），表格转成竖线分隔行。"""
    prs = Presentation(str(p))
    pages: list[tuple[int, str]] = []
    for i, slide in enumerate(prs.slides):
        parts: list[str] = []
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    text = para.text.strip()
                    if not text:
                        continue
                    level = para.level or 0
                    parts.append("  " * level + "• " + text if level > 0 else text)
            elif getattr(shape, "has_table", False):
                for row in shape.table.rows:
                    cells = [cell.text.strip() for cell in row.cells]
                    if any(cells):
                        parts.append(" | ".join(cells))
        if slide.has_notes_slide:
            notes = slide.notes_slide.notes_text_frame.text.strip()
            if notes:
                parts.append(f"【备注】{notes}")
        pages.append((i + 1, "\n".join(parts)))
    return pages


def normalize_text(text: str) -> str:
    """统一换行符、去掉行尾空白，把连续空行压缩成一个。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    out: list[str] = []
    for raw in lines:
        line = raw.rstrip()
        if line:
            out.append(line)
        elif out and out[-1]:
            out.append("")
    return "\n".join(out).strip()


def chunk_pages(
    pages: list[tuple[int, str]], chunk_size: int | None = None, overlap: int | None = None
) -> list[dict]:
    """把每页文本切成带重叠的片段（保留换行结构），保留页码信息。"""
    chunk_size = chunk_size or settings.chunk_size
    overlap = overlap or settings.chunk_overlap
    chunks: list[dict] = []
    seq = 0
    for page_no, text in pages:
        text = normalize_text(text)
        start = 0
        while start < len(text):
            piece = text[start : start + chunk_size].strip()
            if piece:
                chunks.append({"page": page_no, "seq": seq, "text": piece})
                seq += 1
            if start + chunk_size >= len(text):
                break
            start += chunk_size - overlap
    return chunks


def _repair_targets(scored: list[tuple[int, str, int]]) -> list[tuple[int, str]]:
    """挑出需要 LLM 修复的页面（乱码多/碎片化），最差的优先修，超出上限丢弃。"""
    candidates = [
        (score, page_no, text)
        for page_no, text, score in scored
        if score >= _REPAIR_MIN_SCORE and 20 <= len(text) <= 8000
    ]
    candidates.sort(key=lambda c: -c[0])
    return [(page_no, text) for _score, page_no, text in candidates[:_REPAIR_MAX_PAGES]]


async def _repair_one(text: str, title: str, page_no: int) -> str:
    try:
        out = await llm.complete(
            [
                {"role": "system", "content": _REPAIR_SYSTEM},
                {"role": "user", "content": f"来源：《{title}》第 {page_no} 页\n\n{text}"},
            ],
            max_tokens=3072,
            timeout_s=180.0,
            model=settings.problem_model,
        )
    except Exception:  # noqa: BLE001 修复失败保留原文，不影响入库
        return text
    out = out.strip()
    if len(out) < 8 or len(out) > len(text) * 5 + 200:
        return text
    if out.count("$$") % 2 or out.count("\\[") != out.count("\\]"):
        return text  # 定界符不配对，疑似被截断，保留原文
    return out


async def _repair_pages(scored: list[tuple[int, str, int]], title: str) -> list[tuple[int, str]]:
    """对乱码严重的页面做 LLM 语义修复（用户可感知的"自己补全"）。"""
    targets = _repair_targets(scored)
    if targets:
        sem = asyncio.Semaphore(_REPAIR_CONCURRENCY)

        async def work(page_no: int, text: str) -> tuple[int, str]:
            async with sem:
                return page_no, await _repair_one(text, title, page_no)

        fixed = dict(await asyncio.gather(*(work(pn, t) for pn, t in targets)))
    else:
        fixed = {}
    return [(page_no, fixed.get(page_no, text)) for page_no, text, _score in scored]


async def _embed_with_retry(batch: list[str]) -> list[list[float]]:
    """向量化带重试：网关偶发 502/超时不应让整份材料入库失败。"""
    for attempt in range(1, _EMBED_ATTEMPTS + 1):
        try:
            return await llm.embed(batch)
        except Exception:  # 最后一次仍失败才向上抛
            if attempt == _EMBED_ATTEMPTS:
                raise
            await asyncio.sleep(3.0 * attempt)


async def ingest_material(material_id: int, repair: bool = True) -> None:
    """后台任务：解析材料 -> （可选）LLM 修复 -> 分块 -> 向量化 -> 入库。"""
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            return
        material.status = "ingesting"
        material.error = ""
        session.add(material)
        session.commit()
        try:
            path = Path(material.stored_path)
            if path.suffix.lower() == ".pdf":
                scored = _extract_pdf(path)
            else:
                scored = [(page_no, text, 0) for page_no, text in extract_pages(path)]
            pages = await _repair_pages(scored, material.filename) if repair else [
                (page_no, text) for page_no, text, _score in scored
            ]
            chunks = chunk_pages(pages)
            if not chunks:
                raise ValueError("未从文件中提取到文本内容（扫描版 PDF 需要先做 OCR）")
            vectors: list[list[float]] = []
            for i in range(0, len(chunks), _EMBED_BATCH):
                batch = [c["text"] for c in chunks[i : i + _EMBED_BATCH]]
                vectors.extend(await _embed_with_retry(batch))
            session.exec(delete(Chunk).where(Chunk.material_id == material_id))
            for c, vec in zip(chunks, vectors, strict=True):
                session.add(
                    Chunk(
                        course_id=material.course_id,
                        material_id=material.id,
                        page=c["page"],
                        seq=c["seq"],
                        text=c["text"],
                        embedding=to_blob(vec),
                    )
                )
            material.chunk_count = len(chunks)
            material.status = "ready"
            material.error = ""
        except Exception as exc:  # noqa: BLE001  把失败原因暴露给上传者
            material.status = "failed"
            material.error = (str(exc) or type(exc).__name__)[:500]
        session.add(material)
        session.commit()
        if material.status == "ready" and material.kind != "exam":  # 试题不做知识总结
            try:
                await summary.generate_summary(material_id)
            except Exception:  # noqa: BLE001 总结失败不影响材料入库
                return
