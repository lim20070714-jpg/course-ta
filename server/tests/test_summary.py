from app.core.summary import _sample_batches, parse_summary_text


def test_parse_summary_full_format() -> None:
    text = (
        "【总结】\n这份材料讲了基尔霍夫定律与等效电路。\n【/总结】\n\n"
        "【知识点】\n标题: 戴维南定理\n页码: 12, 15\n说明:\n"
        "线性含源单口网络可等效为电压源串联电阻，$v_{th}=v_{oc}$。\n【/知识点】\n"
        "【知识点】\n标题: 叠加定理\n页码: 3\n说明:\n分别求各电源响应后相加。\n【/知识点】"
    )
    parsed = parse_summary_text(text)
    assert parsed["overview"].startswith("这份材料")
    assert parsed["key_points"] == [
        {
            "title": "戴维南定理",
            "detail": "线性含源单口网络可等效为电压源串联电阻，$v_{th}=v_{oc}$。",
            "pages": [12, 15],
        },
        {"title": "叠加定理", "detail": "分别求各电源响应后相加。", "pages": [3]},
    ]


def test_parse_summary_full_width_colon() -> None:
    text = "【知识点】\n标题：KVL\n页码：8\n说明：回路电压代数和为零 $\\sum u_k = 0$\n【/知识点】"
    parsed = parse_summary_text(text)
    assert parsed["key_points"][0]["title"] == "KVL"
    assert parsed["key_points"][0]["pages"] == [8]


def test_parse_summary_requires_title_and_detail() -> None:
    text = (
        "【知识点】\n页码: 1\n说明: 只有说明没有标题\n【/知识点】\n"
        "【知识点】\n标题: 只有标题没有说明\n【/知识点】"
    )
    assert parse_summary_text(text)["key_points"] == []


def test_parse_summary_without_repeated_markers() -> None:
    text = (
        "【知识点】\n标题: 电路系统的构成\n页码: 12, 15\n说明:\n由功能单元电路连接构成。\n\n"
        "标题: 基尔霍夫电流定律\n页码: 12, 26\n说明:\n流入等于流出，$\\sum I_{in} = \\sum I_{out}$。\n\n"
        "标题: 欧姆定律\n页码: 30\n说明:\n$v = iR$，只对线性电阻成立。"
    )
    parsed = parse_summary_text(text)
    assert [p["title"] for p in parsed["key_points"]] == [
        "电路系统的构成",
        "基尔霍夫电流定律",
        "欧姆定律",
    ]
    assert parsed["key_points"][0]["detail"] == "由功能单元电路连接构成。"
    assert parsed["key_points"][1]["pages"] == [12, 26]
    assert parsed["key_points"][2]["detail"].startswith("$v = iR$")


def test_parse_summary_tolerates_bullet_prefix() -> None:
    text = "- **标题**: KCL\n- 页码: 12\n- 说明: 节点电流代数和为零。"
    parsed = parse_summary_text(text)
    assert parsed["key_points"] == [
        {"title": "KCL", "detail": "节点电流代数和为零。", "pages": [12]}
    ]


def test_parse_summary_no_markers() -> None:
    assert parse_summary_text("普通的一段文本") == {"overview": "", "key_points": []}


def test_parse_summary_caps_points() -> None:
    text = "".join(
        f"【知识点】\n标题: 点{i}\n页码: {i}\n说明: 第{i}个知识点。\n【/知识点】" for i in range(1, 40)
    )
    assert len(parse_summary_text(text)["key_points"]) == 32


def test_sample_batches_keeps_short_lists() -> None:
    batches = [[(1, "a")], [(2, "b")]]
    assert _sample_batches(batches) == batches


def test_sample_batches_caps_and_keeps_ends() -> None:
    batches = [[(i, "x")] for i in range(1, 101)]
    sampled = _sample_batches(batches)
    assert len(sampled) == 12
    assert sampled[0] == batches[0]
    assert sampled[-1] == batches[-1]
    assert sampled[1] == batches[9]
