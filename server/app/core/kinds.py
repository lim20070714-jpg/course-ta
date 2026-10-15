"""材料类型：分类定义与按文件名的自动识别。

类型决定处理方式：教材/课件/讲义 → 原文 + 知识总结；试题 → 不做总结，
入库后自动抽取题目（题干/解答/知识点）。
"""

import re

KIND_LABELS = {
    "textbook": "教材",
    "slides": "课件",
    "handout": "讲义",
    "exam": "试题",
    "other": "其他",
}
VALID_KINDS = set(KIND_LABELS)

_EXAM_PATTERNS = (
    r"真题|试卷|试题|模拟|考卷",  # 注意：不匹配「考试版」复习课件
    r"(?:^|[^a-z])(?:final|middle|midterm|exam|quiz|test)(?:[^a-z]|$)",
    r"^0\d\d[春秋][ab][中末]",
    r"^[ab]\d\d-",
)
_TEXTBOOK_PATTERNS = (r"教材|课本|textbook|edition|irwin|razavi|sedra",)
_HANDOUT_PATTERNS = (r"讲义|辅导|笔记|梳理|作业|handout|notes|tutorial",)
_SLIDES_PATTERNS = (r"课件|slide|lecture|幻灯片|^a1-|^\d\d\.",)


def _matches(patterns: tuple[str, ...], name: str) -> bool:
    return any(re.search(p, name) for p in patterns)


def detect_kind(filename: str) -> str:
    """按文件名猜材料类型；无法判断时返回 other。"""
    name = filename.lower()
    if _matches(_EXAM_PATTERNS, name):
        return "exam"
    if _matches(_TEXTBOOK_PATTERNS, name):
        return "textbook"
    if _matches(_HANDOUT_PATTERNS, name):
        return "handout"
    if _matches(_SLIDES_PATTERNS, name):
        return "slides"
    return "other"
