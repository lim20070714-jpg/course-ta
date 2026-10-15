import pymupdf

from app.core.crops import _line_markers, find_problem_rect

_LINES = [
    "电子电路与系统基础 期末考试",
    "一、选择题（每题 5 分）",
    "1. 求图中电路的电流 $I$。",
    "（1）画出等效电路",
    "（2）计算功率",
    "2. 计算等效电阻 $R$。",
    "已知电压为 3.5 V 的电源。",
    "二、计算题",
    "1. 用戴维南定理求电压 $U$。",
    "2. 求最大功率。",
]


def _make_page() -> pymupdf.Page:
    doc = pymupdf.open()
    page = doc.new_page(width=595, height=842)
    y = 60.0
    for line in _LINES:
        page.insert_text((50, y), line, fontname="china-s", fontsize=11)
        y += 28.0
    return page


def test_line_markers_excludes_subquestions_and_decimals() -> None:
    markers = _line_markers(_make_page())
    # 一、/1./2./二、/1./2. 共 6 个；「（1）」子问与「3.5 V」小数不算
    assert [m["num"] for m in markers] == [None, 1, 2, None, 1, 2]
    assert [m["cn"] for m in markers] == ["一", None, None, "二", None, None]


def test_find_rect_first_problem_ends_at_next_marker() -> None:
    page = _make_page()
    markers = _line_markers(page)
    rect = find_problem_rect(page, "一、1")
    assert rect is not None
    start = markers[1]["y0"]
    next_y = markers[2]["y0"]
    assert rect.y0 < start <= next_y
    assert rect.y1 <= next_y
    # 子问（1）（2）落在裁剪区域内
    assert rect.y1 > markers[2]["y0"] - 30


def test_find_rect_disambiguates_by_section() -> None:
    page = _make_page()
    markers = _line_markers(page)
    rect = find_problem_rect(page, "二、1")
    assert rect is not None
    assert rect.y0 > markers[3]["y0"]  # 在「二、」标题之后，而不是第一个「1.」


def test_find_rect_last_problem_reaches_page_bottom() -> None:
    page = _make_page()
    rect = find_problem_rect(page, "二、2")
    assert rect is not None
    assert rect.y1 >= page.rect.y1 - 1


def test_find_rect_returns_none_when_not_found() -> None:
    page = _make_page()
    assert find_problem_rect(page, "9") is None
    assert find_problem_rect(page, "") is None
