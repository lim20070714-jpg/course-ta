import json

import pytest

from app.api.problems import _excerpt
from app.core.problems import (
    detect_verdict,
    group_pages,
    parse_problems_json,
    parse_problems_text,
    parse_tags,
)

_SAMPLE = """好的，提取结果如下：

【题目】
题号: 一、1
页码: 2
知识点: 二极管, 伏安特性
题干:
求如图所示电路中 $v_{GS}$ 的值，已知 $V_{DD} = 12V$。
1）画出特性曲线
2）计算电流
【解答】
由 KVL 得 $v_{GS} = 3V$。
【/题目】

【题目】
题号: 二、3
页码: 3
知识点: MOSFET
题干:
写出饱和区条件 $v_{DS} > v_{GS} - V_{TH}$。
【解答】

【/题目】
"""


def test_parse_problems_text_basic() -> None:
    items = parse_problems_text(_SAMPLE)
    assert len(items) == 2
    first, second = items
    assert first["number"] == "一、1"
    assert first["page"] == 2
    assert first["knowledge"] == ["二极管", "伏安特性"]
    assert "$v_{GS}$" in first["stem"]
    assert "KVL" in first["answer"]
    assert second["answer"] == ""


def test_parse_problems_text_placeholder_answer_dropped() -> None:
    text = "【题目】\n题号: 1\n页码: 1\n知识点: 电阻\n题干:\n求 $R_1$\n【解答】\n（若材料没有解答则整行留空）\n【/题目】"
    items = parse_problems_text(text)
    assert items[0]["answer"] == ""


def test_parse_problems_text_full_width_colon() -> None:
    text = "【题目】\n题号：三\n页码：1\n知识点：运放\n题干：\n求增益\n【/题目】"
    items = parse_problems_text(text)
    assert items[0]["number"] == "三"
    assert items[0]["stem"] == "求增益"


def test_parse_problems_text_without_tags_returns_empty() -> None:
    assert parse_problems_text("没有任何标记的普通文本") == []


def test_group_pages_respects_budget() -> None:
    pages = [(1, "a" * 400), (2, "b" * 400), (3, "c" * 400)]
    batches = group_pages(pages, budget=900)
    assert [[p for p, _ in b] for b in batches] == [[1, 2], [3]]


def test_group_pages_skips_blank_and_keeps_single_oversized() -> None:
    pages = [(1, "  \n "), (2, "x" * 1000), (3, "y")]
    batches = group_pages(pages, budget=100)
    assert [[p for p, _ in b] for b in batches] == [[2], [3]]


def test_parse_problems_json_plain_array() -> None:
    text = '[{"number": "一、1", "page": 1, "stem": "求 $R_1$", "knowledge": ["电阻电路"]}]'
    items = parse_problems_json(text)
    assert items[0]["number"] == "一、1"
    assert items[0]["knowledge"] == ["电阻电路"]


def test_parse_problems_json_with_fence_and_preamble() -> None:
    text = '好的，以下是提取结果：\n```json\n[{"stem": "题干"}]\n```\n以上。'
    items = parse_problems_json(text)
    assert items == [{"stem": "题干"}]


def test_parse_problems_json_single_object_wrapped() -> None:
    items = parse_problems_json('说明文字 {"stem": "只有一题", "page": 2} 结尾')
    assert items == [{"stem": "只有一题", "page": 2}]


def test_parse_problems_json_invalid_raises() -> None:
    with pytest.raises(ValueError):
        parse_problems_json("这里没有任何 JSON")


def test_parse_problems_json_filters_non_dict_items() -> None:
    items = parse_problems_json('[1, {"stem": "有效"}, "x"]')
    assert items == [{"stem": "有效"}]


def test_detect_verdict() -> None:
    assert detect_verdict("【判定】正确\n\n做得好") == "correct"
    assert detect_verdict("【判定】部分正确\n\n") == "partial"
    assert detect_verdict("【判定】错误") == "wrong"
    assert detect_verdict("【判定】 无法判断") == "unknown"
    assert detect_verdict("没有标记") is None


def test_parse_tags() -> None:
    assert parse_tags(json.dumps(["二极管", "MOSFET"], ensure_ascii=False)) == ["二极管", "MOSFET"]
    assert parse_tags("not json") == []
    assert parse_tags('{"a": 1}') == []


def test_excerpt_converts_latex_to_plain_text() -> None:
    text = "已知信源内阻 $R_S=50\\Omega$，$H_0=1$，反馈系数 $\\mathbf{F}$，增益 $\\frac{v_{out}}{v_{in}}$。"
    out = _excerpt(text)
    assert "Ω" in out
    assert "\\" not in out
    assert "{" not in out and "}" not in out
    assert "(v_out)/(v_in)" in out


def test_excerpt_truncates_and_strips_markup() -> None:
    out = _excerpt("**" + "长" * 300)
    assert out.endswith("…")
    assert len(out) <= 121
    assert "*" not in out
