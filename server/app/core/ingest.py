from pathlib import Path

import pymupdf
from pptx import Presentation
from sqlmodel import Session, delete

from app import db
from app.config import settings
from app.core import llm
from app.core.store import to_blob
from app.models import Chunk, Material

_EMBED_BATCH = 16


def extract_pages(path: str | Path) -> list[tuple[int, str]]:
    """提取文档每一页/每张幻灯片的文本，返回 [(页码, 文本), ...]。"""
    p = Path(path)
    suffix = p.suffix.lower()
    if suffix == ".pdf":
        return _extract_pdf(p)
    if suffix == ".pptx":
        return _extract_pptx(p)
    if suffix in (".txt", ".md"):
        return [(1, p.read_text(encoding="utf-8", errors="ignore"))]
    if suffix == ".ppt":
        raise ValueError("旧版 .ppt 不受支持，请另存为 .pptx 后重新上传")
    raise ValueError(f"不支持的文件类型: {suffix}")


def _extract_pdf(p: Path) -> list[tuple[int, str]]:
    """PyMuPDF 版面级抽取：保留换行与文本块顺序，中文与公式字符更可靠。"""
    with pymupdf.open(str(p)) as doc:
        return [(i + 1, page.get_text("text")) for i, page in enumerate(doc)]


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


def load_and_chunk(path: str | Path) -> list[dict]:
    return chunk_pages(extract_pages(path))


async def ingest_material(material_id: int) -> None:
    """后台任务：解析材料 -> 分块 -> 向量化 -> 入库（可重复执行，先清旧块）。"""
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            return
        material.status = "ingesting"
        material.error = ""
        session.add(material)
        session.commit()
        try:
            chunks = load_and_chunk(material.stored_path)
            if not chunks:
                raise ValueError("未从文件中提取到文本内容（扫描版 PDF 需要先做 OCR）")
            vectors: list[list[float]] = []
            for i in range(0, len(chunks), _EMBED_BATCH):
                batch = [c["text"] for c in chunks[i : i + _EMBED_BATCH]]
                vectors.extend(await llm.embed(batch))
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
            material.error = str(exc)[:500]
        session.add(material)
        session.commit()
