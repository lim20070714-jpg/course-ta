from datetime import UTC, datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core.review import MIN_EASE, apply_sm2, clamp_quality, next_ease
from app.main import app
from app.models import Course, Problem, ReviewCard


def _now() -> datetime:
    return datetime(2026, 10, 16, 12, 0, tzinfo=UTC)


def test_sm2_first_review_good() -> None:
    # q=4 是中性分：EF 不变，进入 1 天学习间隔
    ease, interval, reps, lapses, due = apply_sm2(2.5, 0, 0, 0, 4, _now())
    assert (ease, interval, reps, lapses) == (2.5, 1.0, 1, 0)
    assert due == _now() + timedelta(days=1)
    # q=5 才奖励 ease
    assert apply_sm2(2.5, 0, 0, 0, 5, _now())[0] == 2.6


def test_sm2_second_review_good_six_days() -> None:
    ease, interval, reps, _, due = apply_sm2(2.6, 1, 1, 0, 4, _now())
    assert (ease, interval, reps) == (2.6, 6.0, 2)
    assert due == _now() + timedelta(days=6)


def test_sm2_interval_multiplies_by_ease() -> None:
    ease, interval, reps, _, due = apply_sm2(2.6, 6, 2, 0, 4, _now())
    assert (ease, interval, reps) == (2.6, 16.0, 3)  # round(6 * 2.6)
    assert due == _now() + timedelta(days=16)


def test_sm2_forget_resets_sequence_and_counts_lapse() -> None:
    _ease, interval, reps, lapses, due = apply_sm2(2.6, 16, 3, 0, 1, _now())
    assert (reps, interval) == (0, 1.0)
    assert lapses == 1
    assert due == _now() + timedelta(days=1)


def test_sm2_forget_loses_separate_from_lapse() -> None:
    # 质量分 0-2 都算遗忘，但 ease 惩罚不同（q 越低扣越多）
    assert next_ease(2.5, 0) < next_ease(2.5, 2) < 2.5


def test_sm2_ease_has_floor() -> None:
    ease = 1.3
    for _ in range(10):
        ease, *_ = apply_sm2(ease, 16, 3, 0, 0, _now())
    assert ease == MIN_EASE


def test_sm2_hard_grows_slower_than_good() -> None:
    e3, i3, *_ = apply_sm2(2.5, 16, 3, 0, 3, _now())
    e4, i4, *_ = apply_sm2(2.5, 16, 3, 0, 4, _now())
    assert i3 < i4 and e3 < e4


def test_sm2_quality_clamped() -> None:
    assert clamp_quality(-2) == 0
    assert clamp_quality(9) == 5
    assert clamp_quality(4) == 4


def test_sm2_perfect_keeps_ease_at_most_initial() -> None:
    ease, *_ = apply_sm2(2.5, 16, 3, 0, 5, _now())
    assert ease == 2.6  # EF 上浮不超过 +0.1


@pytest.fixture(name="client")
def client_fixture(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    monkeypatch.setattr(db_module, "engine", engine)
    with Session(engine) as session:
        session.add(Course(id=1, name="电路"))
        session.add(Problem(id=11, course_id=1, number="1", stem="求 $R$", knowledge='["电阻"]'))
        session.add(Problem(id=12, course_id=1, number="2", stem="求 $C$"))
        session.commit()
    return TestClient(app)


def test_enroll_is_idempotent_and_card_of(client: TestClient) -> None:
    first = client.put("/api/problems/11/review")
    assert first.status_code == 200
    card = first.json()
    assert card["problem_id"] == 11 and card["reps"] == 0 and card["ease"] == 2.5
    again = client.put("/api/problems/11/review").json()
    assert again["problem_id"] == 11
    assert client.get("/api/problems/11/review").json()["problem_id"] == 11
    assert client.get("/api/problems/12/review").json() is None
    assert client.put("/api/problems/999/review").status_code == 404


def test_grade_updates_schedule_and_due_list(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    resp = client.post("/api/problems/11/review/grade", json={"quality": 4})
    assert resp.status_code == 200
    card = resp.json()
    assert card["reps"] == 1 and card["interval_days"] == 1.0
    assert card["last_review_at"] is not None

    # 刚复习过 → 不在到期队列
    due = client.get("/api/courses/1/review/due").json()
    assert all(item["problem_id"] != 11 for item in due)

    # 手动把 due_at 拨到过去 → 出现在队列且带题目信息
    with Session(db_module.engine) as session:
        card_row = session.exec(select(ReviewCard)).first()
        assert card_row is not None
        card_row.due_at = datetime.now(UTC) - timedelta(hours=2)
        session.add(card_row)
        session.commit()
    due = client.get("/api/courses/1/review/due").json()
    assert len(due) == 1
    item = due[0]
    assert item["problem_id"] == 11
    assert item["number"] == "1"
    assert "电阻" in item["knowledge"]
    assert "求 R" in item["excerpt"]


def test_grade_requires_enrolled_card(client: TestClient) -> None:
    assert client.post("/api/problems/12/review/grade", json={"quality": 4}).status_code == 404


def test_remove_card(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    assert client.delete("/api/problems/11/review").status_code == 200
    assert client.get("/api/problems/11/review").json() is None
    assert client.delete("/api/problems/11/review").status_code == 404


def test_stats_and_forecast(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    client.post("/api/problems/11/review/grade", json={"quality": 4})

    stats = client.get("/api/courses/1/review/stats").json()
    assert stats["card_count"] == 2
    # 题 11 刚复习过（明天到期），题 12 立即到期
    assert stats["due_now"] == 1
    assert stats["reviewed_today"] == 1
    forecast = {d["date"]: d["count"] for d in stats["forecast"]}
    today = datetime.now(UTC).date()
    assert forecast[today.isoformat()] == 1
    assert forecast[(today + timedelta(days=1)).isoformat()] == 1
    assert len(stats["forecast"]) == 7


def test_cards_list_orders_by_due(client: TestClient) -> None:
    client.put("/api/problems/11/review")
    client.put("/api/problems/12/review")
    with Session(db_module.engine) as session:
        cards = session.exec(select(ReviewCard).order_by(ReviewCard.problem_id)).all()  # type: ignore[arg-type]
        cards[1].due_at = datetime.now(UTC) - timedelta(days=1)  # 题 12 更早到期
        for c in cards:
            session.add(c)
        session.commit()
    rows = client.get("/api/courses/1/review/cards").json()
    assert [r["problem_id"] for r in rows] == [12, 11]
