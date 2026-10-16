"""Word 文档与图片的处理：文本提取、内嵌图片导出、图片的视觉描述。

设计要点：
- `.docx` 的文字按段落抽取；内嵌图片导出到 `data/media/{material_id}/`，各自成为
  「一页」（页码连续编号），页图直接返回该图片文件。
- 独立图片材料（png/jpg/webp/…）本身即第 1 页，页图即原文件。
- 若配置了 `VISION_MODEL`，图片会经视觉模型生成文字描述；这段描述会作为该页正文
  入库并参与向量化，因此图片内容可以被提问、总结与图谱引用。
- 未配置视觉模型时只跳过「描述」这一步，图片依然可上传、可查看。
"""

import base64
import io
import json
from pathlib import Path

import pymupdf

from app import config
from app.core import llm

# 可直接作为「一页」的图片格式
IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff"}
IMAGE_MIME = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
    ".tif": "image/tiff",
    ".tiff": "image/tiff",
}

_VISION_PROMPT = (
    "你在为课程学习平台整理课件截图。请用中文客观描述这张图片："
    "1) 它是什么（电路图 / 公式推导 / 表格 / 波形图 / 幻灯片 / 手写笔记等）；"
    "2) 图中出现的文字与公式，公式用 LaTeX；"
    "3) 如果是电路图，说明元件、连接关系与待求量。"
    "只输出描述正文，不要寒暄，不要编造图中没有的内容；看不清的部分写「不清晰」。"
)


def is_image(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


def media_dir(data_dir: Path, material_id: int) -> Path:
    """材料的内嵌图片导出目录。"""
    return data_dir / "media" / str(material_id)


def extract_docx_body(path: str | Path) -> tuple[str, list[bytes]]:
    """提取 .docx 的正文文本与内嵌图片字节（按文档中出现顺序）。

    只取文档真正引用的图片：`/word/media/` 下的图片 part，以及正文关系里的图片。
    包级元数据（如 `/docProps/thumbnail.jpeg` 缩略图）不是文档内容，必须排除，
    否则会把封面缩略图当成一张正文图片导出。
    """
    from docx import Document

    doc = Document(str(path))
    lines: list[str] = []
    for para in doc.paragraphs:
        text = para.text.strip()
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style is not None else ""
        if "heading" in style or "标题" in style:
            lines.append(f"## {text}")
        elif style.startswith("list") or "列表" in style:
            lines.append(f"- {text}")
        else:
            lines.append(text)

    for table in doc.tables:
        for row in table.rows:
            cells = [cell.text.strip().replace("\n", " ") for cell in row.cells]
            if any(cells):
                lines.append(" | ".join(cells))

    return "\n".join(lines), _referenced_image_blobs(doc)


def _referenced_image_blobs(doc) -> list[bytes]:
    """按 partname 顺序取出文档引用的图片字节，排除缩略图等包级元数据。"""
    parts = list(doc.part.package.parts)
    order = {str(getattr(p, "partname", "")): i for i, p in enumerate(parts)}
    blobs: list[tuple[int, bytes]] = []
    seen: set[str] = set()
    for part in parts:
        name = str(getattr(part, "partname", ""))
        ctype = getattr(part, "content_type", "") or ""
        if not ctype.startswith("image/"):
            continue
        if name in seen or _is_package_metadata(name):
            continue
        blob = getattr(part, "blob", None)
        if not blob:
            continue
        seen.add(name)
        blobs.append((order.get(name, 0), blob))
    blobs.sort(key=lambda item: item[0])
    return [blob for _i, blob in blobs]


def _is_package_metadata(partname: str) -> bool:
    """判断是否为 OOXML 包级元数据（不是文档正文内容）。"""
    low = partname.lower()
    return any(
        marker in low
        for marker in ("/docprops/", "/customxml/", "/_rels/", "thumbnail", "docpreview")
    )


def write_images(blobs: list[bytes], target_dir: Path, stem: str = "image") -> list[Path]:
    """把图片字节写盘，返回文件路径（1 起始编号，保证顺序稳定）。"""
    target_dir.mkdir(parents=True, exist_ok=True)
    written: list[Path] = []
    for index, blob in enumerate(blobs, start=1):
        suffix = _sniff_suffix(blob)
        out = target_dir / f"{stem}-{index:03d}{suffix}"
        out.write_bytes(blob)
        written.append(out)
    return written


def _sniff_suffix(blob: bytes) -> str:
    """按文件头判断图片格式，避免扩展名与实际内容不符。"""
    if blob.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if blob.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if blob[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return ".webp"
    if blob[:2] in (b"II", b"MM"):
        return ".tif"
    return ".png"


def render_page_png(path: str | Path, page: int, zoom: float = 2.0) -> bytes:
    """把 PDF 的某一页渲染为 PNG 字节。"""
    with pymupdf.open(str(path)) as doc:
        if page > doc.page_count:
            raise ValueError(f"页码超出范围（共 {doc.page_count} 页）")
        pix = doc[page - 1].get_pixmap(matrix=pymupdf.Matrix(zoom, zoom))
        return pix.tobytes("png")


def image_size(path: str | Path) -> tuple[int, int]:
    """图片像素尺寸（用于前端按比例展示）。"""
    with pymupdf.open(str(path)) as doc:
        rect = doc[0].rect
        return int(rect.width), int(rect.height)


def _png_bytes(path: str | Path, max_side: int = 1600) -> bytes:
    """读取任意图片并转成适合送模型的 PNG（限制最长边，控制请求体积）。"""
    with pymupdf.open(str(path)) as doc:
        page = doc[0]
        longest = max(page.rect.width, page.rect.height)
        scale = min(1.0, max_side / longest) if longest > 0 else 1.0
        pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale))
        return pix.tobytes("png")


async def describe_image(path: str | Path) -> str:
    """用视觉模型描述图片（中文）；未配置 VISION_MODEL 时返回空串。"""
    if not config.current().vision_model:
        return ""
    png = _png_bytes(path)
    b64 = base64.b64encode(png).decode("ascii")
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": _VISION_PROMPT},
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/png;base64,{b64}"},
                },
            ],
        }
    ]
    try:
        text = await llm.complete(messages, max_tokens=700, timeout_s=180.0, model=config.current().vision_model)
    except Exception as exc:  # noqa: BLE001  描述失败不影响图片入库
        return f"（图片描述失败：{type(exc).__name__}）"
    return (text or "").strip()


def description_text(desc: str, index: int) -> str:
    """把描述包装成可检索的页正文。"""
    body = desc.strip()
    if not body:
        return ""
    return f"[图片 {index}] {body}"


def is_png_available() -> bool:
    """Pillow 仅用于兜底格式转换；缺失也不影响主要链路。"""
    try:
        import PIL  # noqa: F401
    except ImportError:
        return False
    return True


def image_map(raw: str) -> dict[int, str]:
    """解析 Material.pages：返回 {页码: 图片绝对路径}。"""
    try:
        rows = json.loads(raw) if raw else []
    except (TypeError, ValueError):
        return {}
    if not isinstance(rows, list):
        return {}
    out: dict[int, str] = {}
    for row in rows:
        if not isinstance(row, dict):
            continue
        page, rel = row.get("page"), row.get("path")
        if not isinstance(page, int) or not isinstance(rel, str) or not rel:
            continue
        out[page] = str(resolve_media_path(rel))
    return out


def resolve_media_path(rel: str) -> Path:
    """图片相对路径 → 绝对路径；已是绝对路径则原样返回。"""
    path = Path(rel)
    return path if path.is_absolute() else (config.current().data_dir / path)


def image_page_numbers(raw: str) -> list[int]:
    return sorted(image_map(raw))


def media_type_for(path: str | Path) -> str:
    """按扩展名给出响应 Content-Type；图片以外按 PNG 兜底。"""
    return IMAGE_MIME.get(Path(path).suffix.lower(), "image/png")


def to_io(blob: bytes) -> io.BytesIO:
    return io.BytesIO(blob)
