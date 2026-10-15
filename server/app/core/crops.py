"""题目配图：在试卷页面上定位题目区域并裁剪为图片。

试题题干经 LLM 改写（Unicode 数学符号→LaTeX），无法与页面文本做精确子串匹配，
因此用「题号标记行」估计边界：区域从对应标记行开始，到下一个标记行前结束；
定位失败时返回 None，调用方退化为整页。
"""

import re

import pymupdf

# 题号标记行：行首「1.」「1、」或「一、」；后随空白/中文/行尾，避免误吃行首小数（如 "1.5 V"）
_MARKER_RE = re.compile(
    r"^\s*(?:(\d{1,2})\s*[.．、]\s*(?=\s|[^\x00-\x7F]|$)"
    r"|([一二三四五六七八九十]{1,4})\s*[、.．]\s*(?=\S|$))"
)

_PAD_TOP = 6.0
_PAD_BOTTOM = 2.0
_MIN_SPAN_H = 24.0


def _line_markers(page: pymupdf.Page) -> list[dict]:
    """页面上全部题号标记行（含题号与 bbox），按纵坐标排序。"""
    data = page.get_text("dict")
    markers: list[dict] = []
    for block in data.get("blocks", []):
        if block.get("type") != 0:
            continue
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", []))
            m = _MARKER_RE.match(text)
            if m is None:
                continue
            _, y0, _, y1 = line["bbox"]
            markers.append(
                {
                    "num": int(m.group(1)) if m.group(1) else None,
                    "cn": m.group(2),
                    "y0": y0,
                    "y1": y1,
                }
            )
    markers.sort(key=lambda mk: mk["y0"])
    return markers


def _find_index(markers: list[dict], number: str) -> int | None:
    """按题号挑选标记行下标；有章节号（如「一、1」）时限定在其章节范围内。"""
    number = number.strip()
    if not number:
        return None
    digits = re.findall(r"\d+", number)
    target_num = int(digits[-1]) if digits else None
    cn = re.findall(r"[一二三四五六七八九十]{1,4}", number)
    target_cn = cn[-1] if cn else None
    if target_num is not None:
        hits = [i for i, mk in enumerate(markers) if mk["num"] == target_num]
        if hits and target_cn is not None:
            section = next((i for i, mk in enumerate(markers) if mk["cn"] == target_cn), None)
            if section is not None:
                after = [i for i in hits if i > section]
                if after:
                    return after[0]
        if hits:
            return hits[0]
    if target_cn is not None:
        hits = [i for i, mk in enumerate(markers) if mk["cn"] == target_cn]
        if hits:
            return hits[0]
    return None


def find_problem_rect(page: pymupdf.Page, number: str) -> pymupdf.Rect | None:
    """题目区域（全宽，纵向从题号行到下一题号行）；找不到时返回 None。"""
    markers = _line_markers(page)
    idx = _find_index(markers, number)
    if idx is None:
        return None
    start = markers[idx]
    y0 = start["y0"] - _PAD_TOP
    y1 = page.rect.y1
    for later in markers[idx + 1 :]:
        if later["y0"] > start["y0"] + 1.0:
            y1 = later["y0"] - _PAD_BOTTOM
            break
    if y1 - y0 < _MIN_SPAN_H:
        return None
    return pymupdf.Rect(page.rect.x0 + 2.0, max(page.rect.y0, y0), page.rect.x1 - 2.0, min(page.rect.y1, y1))
