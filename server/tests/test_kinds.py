from app.core.kinds import detect_kind

# 真实课程材料：分类必须全部符合预期
_REAL = {
    "A1-01电路定律.pdf": "slides",
    "A1-15期末复习.pdf": "slides",
    "A1-15期末复习-考试版.pdf": "slides",
    "016秋A末4.pdf": "exam",
    "004春A中4.pdf": "exam",
    "电电1A小班辅导-知识梳理.pdf": "handout",
    "电电1A小班辅导-真题讲解-含批注.pdf": "exam",
    "A11-新A春1.pdf": "exam",
    "B22-新B秋2.pdf": "exam",
    "01.Intro.pdf": "slides",
    "13.OpAmp&Feedback.pdf": "slides",
    "final2020fallA.pdf": "exam",
    "middle2023fall.pdf": "exam",
    "basic-engineering-circuit-analysis-10th-irwin.pdf": "textbook",
    "Microelectronic_Circuits_6th_Edition_Ade.pdf": "textbook",
}


def test_detect_kind_real_materials() -> None:
    for filename, expected in _REAL.items():
        assert detect_kind(filename) == expected, filename


def test_detect_kind_unknown_falls_back_to_other() -> None:
    assert detect_kind("杂乱文件.pdf") == "other"
    assert detect_kind("report-2024.pdf") == "other"


def test_detect_kind_ignores_decimal_and_latest_words() -> None:
    # "latest" 里的 "test"、行内小数不应触发误判
    assert detect_kind("1.5V电源手册.pdf") == "other"
    assert detect_kind("latest-results.pdf") == "other"
