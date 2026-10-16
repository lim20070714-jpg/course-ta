"""考试冲刺模式：SM-2 间隔压缩与加权推荐队列。"""

from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core.review import (
    SPRINT_SCHEDULE,
    SPRINT_WINDOW_DAYS,
    apply_sm2,
    cap_interval,
    card_weight,
    days_until,
    exam_deadline,
    interval_label,
    is_sprint,
    parse_exam_date,
    sprint_interval_days,
    sprint_message,
    sprint_stage,
)
from app.main import app
from app.models import Course, Problem, ReviewCard


def _now() -> datetime:
    return datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


def _exam_in(days: int) -> str:
    """相对今天 days 天的考试日期字符串（与 API 的自然日口径一致）。"""
    return (datetime.now(UTC).date() + timedelta(days=days)).isoformat()


# ---------------------------------------------------------------- 压缩策略


def test_sprint_interval_display_boundaries() -> None:
    # 展示用的参考节奏：最多用掉剩余天数的一半，下限半天
    assert sprint_interval_days(0) == 0.5
    assert sprint_interval_days(1) == 0.5
    assert sprint_interval_days(2) == 1.0
    assert sprint_interval_days(3) == 1.5
    assert sprint_interval_days(8) == 4.0
    assert sprint_interval_days(30) == 15.0  # 冲刺期边界
    assert sprint_interval_days(31) is None  # 超出冲刺窗口
    assert sprint_interval_days(None) is None


def test_sprint_interval_display_is_monotonic() -> None:
    previous = 0.0
    for days_left in range(SPRINT_WINDOW_DAYS + 1):
        interval = sprint_interval_days(days_left)
        assert interval is not None
        assert interval >= previous
        previous = interval


# ---------------------------------------------------------------- 硬不变量：复习点必须早于考试


def test_cap_interval_always_lands_before_exam() -> None:
    """穷举「距考试剩余时间 × 现在时刻」，压缩后的到期时刻必须严格早于考试。"""
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    for hours_left in (0.5, 1, 3, 6, 11.9, 12, 24, 72, 240, 700):
        now = deadline - timedelta(hours=hours_left)
        cap = cap_interval(now, deadline)
        due = now + timedelta(days=cap)
        assert due < deadline, f"hours_left={hours_left} -> due={due} >= deadline={deadline}"
        assert cap > 0


def test_cap_interval_past_deadline_is_tiny_not_negative() -> None:
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    assert cap_interval(deadline + timedelta(days=1), deadline) > 0


def test_apply_sm2_due_is_always_before_exam_deadline() -> None:
    """核心承诺：冲刺期任何一次判分（含遗忘）都不把卡片推到考试之后。

    覆盖 UTC+8 的三种真实时刻：考试前夜 20:00 / 23:00、考试当天 20:00。
    """
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    local = timedelta(hours=8)  # 东八区
    for review_local in (
        deadline - timedelta(hours=12 + 20),  # 前夜 20:00（本地）
        deadline - timedelta(hours=12 + 23),  # 前夜 23:00
        deadline - timedelta(hours=12 - 4),  # 考试当天 20:00
        deadline - timedelta(days=3),
        deadline - timedelta(days=8),
    ):
        now = review_local - local  # 转成 UTC
        for quality in (0, 1, 2, 3, 4, 5):
            for interval, reps in ((0.0, 0), (16.0, 5), (6.0, 2)):
                _e, _i, _r, _l, due = apply_sm2(
                    2.6, interval, reps, 1, quality, now, exam_at=deadline
                )
                assert due < deadline, (
                    f"quality={quality} interval={interval} reps={reps} "
                    f"now={now} -> due={due} (exam={deadline})"
                )


def test_apply_sm2_forget_is_compressed_during_sprint() -> None:
    """遗忘的卡片同样被压缩——最需要考前再见一次的正是刚忘掉的卡。"""
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    now = deadline - timedelta(days=1, hours=4)  # 距考试约 1 天
    _e, interval, reps, lapses, due = apply_sm2(2.6, 16.0, 5, 0, 1, now, exam_at=deadline)
    assert reps == 0 and lapses == 1  # 遗忘仍然重置序列
    assert interval < 1.0  # 但间隔被压到 1 天以内
    assert due < deadline


def test_apply_sm2_without_exam_matches_base_schedule() -> None:
    # 正常 SM-2：6 天 * 2.6 = 16 天；未设置考试日期时完全不受影响
    ease, interval, reps, _, due = apply_sm2(2.6, 6, 2, 0, 4, _now())
    assert (ease, interval, reps) == (2.6, 16.0, 3)
    assert due == _now() + timedelta(days=16)
    assert apply_sm2(2.6, 6, 2, 0, 4, _now()) == apply_sm2(
        2.6, 6, 2, 0, 4, _now(), exam_at=None
    )


def test_apply_sm2_compresses_interval_during_sprint() -> None:
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    now = deadline - timedelta(days=8)
    _ease, interval, reps, _, due = apply_sm2(2.6, 6, 2, 0, 4, now, exam_at=deadline)
    assert reps == 3
    assert interval < 16.0  # 自然间隔被压缩
    assert due < deadline  # 且落在考试之前


def test_apply_sm2_compression_never_lengthens() -> None:
    # 不变量：冲刺压缩后的间隔一定 <= 同一状态下不做压缩的间隔，且到期早于考试。
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    for ease in (1.3, 2.0, 2.5, 2.8):
        for interval in (1.0, 5.0, 6.0, 16.0, 40.0):
            for reps in (0, 1, 2, 5):
                for quality in (0, 1, 2, 3, 4, 5):
                    for hours_left in (6, 24, 72, 120, 240, 700):
                        now = deadline - timedelta(hours=hours_left)
                        base = apply_sm2(ease, interval, reps, 0, quality, now)[1]
                        compressed, due = (
                            apply_sm2(ease, interval, reps, 0, quality, now, exam_at=deadline)[1],
                            apply_sm2(ease, interval, reps, 0, quality, now, exam_at=deadline)[4],
                        )
                        assert compressed <= base  # 只降不升
                        assert due < deadline  # 硬不变量


def test_apply_sm2_short_interval_not_lengthened_by_cap() -> None:
    # 自然间隔已经短于压缩上限时不变化（2 * 2.6 = 5.2 < 6.4 上限）
    exam = parse_exam_date("2026-11-20")
    deadline = exam_deadline(exam)
    now = deadline - timedelta(days=8)
    _e, interval, _r, _, due = apply_sm2(2.6, 2, 2, 0, 4, now, exam_at=deadline)
    assert interval == 5.0  # round(2 * 2.6) = 5，仍小于压缩上限 6.4
    assert due < deadline


def test_apply_sm2_forget_still_resets_sequence() -> None:
    _ease, interval, reps, lapses, due = apply_sm2(2.6, 16, 3, 0, 1, _now(), exam_at=None)
    assert (reps, interval, lapses) == (0, 1.0, 1)
    assert due == _now() + timedelta(days=1)


# ---------------------------------------------------------------- 日期与阶段


def test_days_until_and_is_sprint() -> None:
    now = _now()
    assert days_until(None, now) is None
    assert days_until(parse_exam_date("2026-10-16"), now) == 0
    assert days_until(parse_exam_date("2026-10-19"), now) == 3
    assert days_until(parse_exam_date("2026-10-15"), now) == -1
    assert is_sprint(0) and is_sprint(30)
    assert not is_sprint(31) and not is_sprint(-1) and not is_sprint(None)


def test_parse_exam_date_is_midnight_utc() -> None:
    parsed = parse_exam_date("2026-11-20")
    assert (parsed.year, parsed.month, parsed.day) == (2026, 11, 20)
    assert parsed.tzinfo is not None
    assert parsed.hour == parsed.minute == parsed.second == 0
    with pytest.raises(ValueError):
        parse_exam_date("2026/11/20")


def test_sprint_stage_and_message() -> None:
    assert sprint_stage(25) == "基础巩固"
    assert sprint_stage(8) == "强化冲刺"
    assert sprint_stage(4) == "考前收尾"
    assert sprint_stage(1) == "临考突击"
    assert sprint_stage(0) == "临考突击"
    assert sprint_stage(None) == "" and sprint_stage(31) == "" and sprint_stage(-1) == ""
    assert "未设置考试日期" in sprint_message(None, 0)
    assert "已经过去" in sprint_message(-2, 0)
    assert "充裕" in sprint_message(40, 0)
    assert "今天考试" in sprint_message(0, 5)
    assert "7 天" in sprint_message(7, 3)
    assert "半天" in sprint_message(1, 3)  # 考前一天的压缩可读


def test_interval_label_readable() -> None:
    assert interval_label(0.5) == "半天"
    assert interval_label(1.0) == "1 天"
    assert interval_label(7.4) == "7 天"
    assert interval_label(60) == "2.0 个月"
    assert interval_label(730) == "2.0 年"


# ---------------------------------------------------------------- 权重


def test_card_weight_rewards_high_frequency_tags() -> None:
    tag_counts = {"戴维南定理": 5, "电阻": 1}
    hot, reasons = card_weight(["戴维南定理"], tag_counts, _now() + timedelta(days=3), 0, _now())
    cold, _ = card_weight(["电阻"], tag_counts, _now() + timedelta(days=3), 0, _now())
    assert hot > cold
    assert hot == 6.0  # 基础 1.0 + 5 道题共享该考点
    # 给出题库总题数后才标注「高频知识点」理由
    _w, labeled = card_weight(
        ["戴维南定理"], tag_counts, _now() + timedelta(days=3), 0, _now(), total_problems=10
    )
    assert any("高频知识点" in r for r in labeled)
    assert all("高频知识点" not in r for r in reasons)  # 缺 total_problems 时不标注


def test_card_weight_rewards_due_and_lapsed() -> None:
    due, reasons = card_weight([], {}, _now() - timedelta(hours=1), 0, _now())
    future, _ = card_weight([], {}, _now() + timedelta(days=5), 0, _now())
    assert due > future
    assert "已到期" in reasons
    lapsed, lapsed_reasons = card_weight([], {}, _now() + timedelta(days=5), 3, _now())
    assert lapsed > future
    assert any("遗忘" in r for r in lapsed_reasons)


def test_card_weight_without_tags_has_plain_reason() -> None:
    weight, reasons = card_weight([], {}, _now() + timedelta(days=2), 0, _now(), reps=3)
    assert weight == 1.0  # 仅基础分
    assert reasons == ["计划内复习"]


def test_card_weight_new_card_bonus() -> None:
    weight, reasons = card_weight([], {}, _now() + timedelta(days=2), 0, _now(), reps=0)
    assert weight == 2.0
    assert "新卡未过" in reasons


def test_sprint_schedule_constant_is_sorted_and_positive() -> None:
    assert list(SPRINT_SCHEDULE) == sorted(SPRINT_SCHEDULE)
    assert all(d > 0 for d in SPRINT_SCHEDULE)


# ---------------------------------------------------------------- API


@pytest.fixture(name="client")
def client_fixture(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    with Session(engine) as session:
        session.add(Course(id=1, name="电路"))
        session.add(Course(id=2, name="信号"))
        # 「电容」出现在 2 道题里（高频考点），「戴维南定理」只在 p11 出现
        session.add(Problem(id=11, course_id=1, number="1", stem="求 $R$", knowledge='["戴维南定理"]'))
        session.add(Problem(id=12, course_id=1, number="2", stem="求 $C$", knowledge='["电容"]'))
        session.add(Problem(id=13, course_id=1, number="3", stem="求 $U$", knowledge='["电容"]'))
        session.commit()
    return TestClient(app)


def test_set_and_clear_exam_date(client: TestClient) -> None:
    target = _exam_in(10)
    resp = client.put("/api/courses/1/exam-date", json={"exam_date": target})
    assert resp.status_code == 200
    # 对外只暴露日期，不带时间与时区
    assert resp.json() == {"course_id": 1, "exam_date": target}
    # 课程列表也应带出考试日期
    course = next(c for c in client.get("/api/courses").json() if c["id"] == 1)
    assert course["exam_date"] == target
    # 冲刺概览同样只给日期
    sprint = client.get("/api/courses/1/review/sprint").json()
    assert sprint["exam_date"] == target
    # 清除
    cleared = client.put("/api/courses/1/exam-date", json={"exam_date": None})
    assert cleared.status_code == 200
    assert cleared.json() == {"course_id": 1, "exam_date": None}


def test_exam_date_validation_and_missing_course(client: TestClient) -> None:
    assert client.put("/api/courses/1/exam-date", json={"exam_date": "2026/11/20"}).status_code == 400
    assert client.put("/api/courses/1/exam-date", json={"exam_date": "not-a-date"}).status_code == 400
    assert client.put("/api/courses/999/exam-date", json={"exam_date": _exam_in(5)}).status_code == 404
    assert client.get("/api/courses/999/review/sprint").status_code == 404


def test_sprint_overview_without_exam_date(client: TestClient) -> None:
    body = client.get("/api/courses/1/review/sprint").json()
    assert body["status"] == "none"
    assert body["sprint"] is False
    assert body["days_left"] is None
    assert body["exam_date"] is None
    assert body["schedule"] == list(SPRINT_SCHEDULE)
    assert "未设置考试日期" in body["message"]


def test_sprint_overview_during_sprint_lists_top_tags(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(10)})
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    body = client.get("/api/courses/1/review/sprint").json()
    assert body["status"] == "sprint" and body["sprint"] is True
    assert body["days_left"] == 10
    assert body["stage"] == "强化冲刺"
    assert body["sprint_pool"] == 2
    assert body["recommended"] == 2  # 冲刺期可推进全部计划卡片
    assert body["tag_total"] == 2
    top = body["top_tags"]
    assert top[0]["knowledge"] == "电容"  # 出现在 2 道题里
    assert top[0]["count"] == 2


def test_sprint_overview_when_exam_passed(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(-3)})
    body = client.get("/api/courses/1/review/sprint").json()
    assert body["status"] == "over" and body["sprint"] is False
    assert body["days_left"] == -3
    assert "已经过去" in body["message"]


def test_sprint_overview_when_exam_far_away(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(45)})
    body = client.get("/api/courses/1/review/sprint").json()
    assert body["status"] == "normal" and body["sprint"] is False
    assert body["days_left"] == 45
    assert "充裕" in body["message"]


def test_sprint_overview_on_exam_day(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(0)})
    body = client.get("/api/courses/1/review/sprint").json()
    assert body["status"] == "sprint" and body["days_left"] == 0
    assert body["stage"] == "临考突击"
    assert "今天考试" in body["message"]


def test_weighted_queue_orders_by_knowledge_frequency_and_reports_reasons(
    client: TestClient,
) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(20)})
    client.put("/api/problems/11/review")  # 低频考点：戴维南定理（1 道题）
    client.put("/api/problems/12/review")  # 高频考点：电容（2 道题）
    rows = client.get("/api/courses/1/review/due", params={"exam": True}).json()
    assert [r["problem_id"] for r in rows] == [12, 11]  # 高频优先
    top = rows[0]
    assert top["weight"] > rows[1]["weight"]
    assert any("电容" in r for r in top["reasons"])
    assert top["knowledge"] == ["电容"]
    # 权重至少包含基础分与共享考点数
    assert top["weight"] >= 3.0


def test_exam_mode_requires_flag_and_exam_date(client: TestClient) -> None:
    # 未设置考试日期时，exam=true 退化为普通到期队列
    client.put("/api/problems/11/review")
    fallback = client.get("/api/courses/1/review/due", params={"exam": True}).json()
    plain = client.get("/api/courses/1/review/due").json()
    assert [r["problem_id"] for r in fallback] == [r["problem_id"] for r in plain]
    assert fallback[0]["weight"] == 0.0 and fallback[0]["reasons"] == []
    # 设置了考试日期但不带 exam 标记：保持普通队列行为（显式开关，不隐式改变）
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(10)})
    still_plain = client.get("/api/courses/1/review/due").json()
    assert all(r["weight"] == 0.0 and r["reasons"] == [] for r in still_plain)
    assert client.get("/api/courses/1/review/due", params={"exam": True}).json()[0][
        "weight"
    ] > 0


def test_weighted_queue_includes_not_yet_due_cards_during_sprint(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    # 卡片设为 3 天后到期：普通队列不得到期，但仍早于考试
    with Session(db_module.engine) as session:
        card = session.exec(select(ReviewCard).where(ReviewCard.problem_id == 11)).one()
        card.due_at = datetime.now(UTC) + timedelta(days=3)
        session.add(card)
        session.commit()
    assert client.get("/api/courses/1/review/due").json() == []
    # 设置考试日期 + exam=true -> 未到期但在考试前需要复习的卡片进入队列
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(15)})
    sprint_queue = client.get("/api/courses/1/review/due", params={"exam": True}).json()
    assert [r["problem_id"] for r in sprint_queue] == [11]
    assert sprint_queue[0]["weight"] > 0
    assert any("考前" in r for r in sprint_queue[0]["reasons"])


def test_sprint_queue_excludes_cards_due_after_exam(client: TestClient) -> None:
    """考试之后才到期的卡片不占用冲刺队列。"""
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(5)})
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    with Session(db_module.engine) as session:
        card = session.exec(select(ReviewCard).where(ReviewCard.problem_id == 12)).one()
        card.due_at = datetime.now(UTC) + timedelta(days=30)  # 远在考试之后
        session.add(card)
        session.commit()
    rows = client.get("/api/courses/1/review/due", params={"exam": True}).json()
    assert [r["problem_id"] for r in rows] == [11]


def test_sprint_queue_respects_limit_after_sorting(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(20)})
    for pid in (11, 12, 13):
        client.put(f"/api/problems/{pid}/review")
    rows = client.get("/api/courses/1/review/due", params={"exam": True, "limit": 2}).json()
    assert len(rows) == 2
    # 截断发生在排序之后：留下权重最高的两张（电容 = 2 道题）
    assert [r["problem_id"] for r in rows] == [12, 13]
    assert all(r["weight"] >= 0 for r in rows)


def test_non_sprint_queue_unchanged_and_no_weight(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    rows = client.get("/api/courses/1/review/due").json()
    assert len(rows) == 2
    assert all(r["weight"] == 0.0 and r["reasons"] == [] for r in rows)


def test_stats_reports_exam_fields(client: TestClient) -> None:
    exam_day = _exam_in(4)
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    client.put("/api/problems/13/review")
    with Session(db_module.engine) as session:
        for pid, days in ((11, -1), (12, 2), (13, 10)):
            card = session.exec(select(ReviewCard).where(ReviewCard.problem_id == pid)).one()
            card.due_at = datetime.now(UTC) + timedelta(days=days)
            session.add(card)
        session.commit()
    plain = client.get("/api/courses/1/review/stats").json()
    assert plain["exam_date"] is None
    assert plain["exam_days_left"] is None
    assert plain["due_before_exam"] == 0

    client.put("/api/courses/1/exam-date", json={"exam_date": exam_day})
    stats = client.get("/api/courses/1/review/stats").json()
    assert stats["exam_date"] == exam_day
    assert stats["exam_days_left"] == 4
    assert stats["due_before_exam"] == 2  # 题 11（逾期）+ 题 12（考前到期）
    assert stats["due_now"] == 1


def test_grade_during_sprint_compresses_next_interval(client: TestClient) -> None:
    exam_day = _exam_in(8)
    client.put("/api/courses/1/exam-date", json={"exam_date": exam_day})
    client.put("/api/problems/11/review")
    # 先连对两次把间隔推到 6 天，再连对一次：正常应为 15 天，冲刺期被压缩
    assert client.post("/api/problems/11/review/grade", json={"quality": 4}).json()[
        "interval_days"
    ] == 1.0
    assert client.post("/api/problems/11/review/grade", json={"quality": 4}).json()[
        "interval_days"
    ] == 6.0
    graded = client.post("/api/problems/11/review/grade", json={"quality": 4}).json()
    assert graded["interval_days"] < 15.0  # 被压缩
    # 硬不变量：到期早于考试截止时刻
    deadline = exam_deadline(parse_exam_date(exam_day))
    assert datetime.fromisoformat(graded["due_at"]) < deadline


def test_grade_forget_during_sprint_still_before_exam(client: TestClient) -> None:
    """核心承诺：复习最紧张的「忘记」也绝不会被排到考试之后。"""
    exam_day = _exam_in(1)  # 明天考试
    client.put("/api/courses/1/exam-date", json={"exam_date": exam_day})
    client.put("/api/problems/11/review")
    graded = client.post("/api/problems/11/review/grade", json={"quality": 1}).json()
    deadline = exam_deadline(parse_exam_date(exam_day))
    due = datetime.fromisoformat(graded["due_at"])
    assert due < deadline
    assert graded["reps"] == 0 and graded["lapses"] == 1  # 遗忘仍然重置序列


def test_grade_without_exam_date_keeps_normal_intervals(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    client.post("/api/problems/11/review/grade", json={"quality": 4})
    client.post("/api/problems/11/review/grade", json={"quality": 4})
    graded = client.post("/api/problems/11/review/grade", json={"quality": 4}).json()
    # 基础 SM-2：ease 已回落到 2.5，6 * 2.5 = 15 天，不受冲刺逻辑影响
    assert graded["interval_days"] == 15.0


def test_grade_after_exam_date_returns_to_normal_sm2(client: TestClient) -> None:
    # 考试日已过：不再压缩，回到基础 SM-2
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(-3)})
    client.put("/api/problems/11/review")
    client.post("/api/problems/11/review/grade", json={"quality": 4})
    client.post("/api/problems/11/review/grade", json={"quality": 4})
    graded = client.post("/api/problems/11/review/grade", json={"quality": 4}).json()
    assert graded["interval_days"] == 15.0


def test_exam_date_does_not_rewrite_existing_due_at(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    before = client.get("/api/problems/11/review").json()["due_at"]
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(3)})
    after = client.get("/api/problems/11/review").json()["due_at"]
    assert before == after


def test_sprint_isolated_per_course(client: TestClient) -> None:
    client.put("/api/courses/1/exam-date", json={"exam_date": _exam_in(5)})
    assert client.get("/api/courses/1/review/sprint").json()["sprint"] is True
    assert client.get("/api/courses/2/review/sprint").json()["sprint"] is False
