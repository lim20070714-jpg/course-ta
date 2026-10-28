"""批改后自动维护复习卡：判定 → 建卡 + 推进一次 SM-2，无法判断时不动。"""

from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from sqlmodel import Session, SQLModel, create_engine, select
from sqlmodel.pool import StaticPool

import app.db as db_module
from app.core import exams as exam_core
from app.core import problems as core
from app.core import review as review_core
from app.models import Course, Material, Problem, ReviewCard

NOW = datetime(2026, 10, 20, 9, 0, tzinfo=UTC)


@pytest.fixture()
def engine(monkeypatch: pytest.MonkeyPatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(db_module, "engine", eng)
    with Session(eng) as session:
        session.add(Course(id=1, name="电路", created_at=NOW))
        session.add(Material(id=1, course_id=1, filename="期末卷.pdf", stored_path="x", kind="exam"))
        for pid in (1, 2):
            session.add(
                Problem(
                    id=pid,
                    course_id=1,
                    material_id=1,
                    page=pid,
                    number=f"第{pid}题",
                    stem=f"题干 {pid}",
                    answer="参考答案",
                    knowledge="[]",
                )
            )
        session.commit()
    return eng


def _cards(session: Session) -> list[ReviewCard]:
    return list(session.exec(select(ReviewCard)).all())


def test_verdict_mapping_is_one_review_step(engine):
    with Session(engine) as session:
        card = review_core.schedule_after_verdict(session, 1, "correct", NOW)
        assert card is not None
        assert (card.reps, card.interval_days, card.lapses) == (1, 1.0, 0)
        assert card.due_at == NOW + timedelta(days=1)

        # 同一张题再判半对：沿用同一张卡，累加复习次数
        card = review_core.schedule_after_verdict(session, 1, "partial", NOW)
        assert card is not None
        assert card.reps == 2
        assert card.interval_days == 6.0
        assert len(_cards(session)) == 1


def test_wrong_resets_and_counts_lapse(engine):
    with Session(engine) as session:
        review_core.schedule_after_verdict(session, 2, "correct", NOW)
        card = review_core.schedule_after_verdict(session, 2, "wrong", NOW)
        assert card is not None
        assert (card.reps, card.lapses, card.interval_days) == (0, 1, 1.0)


def test_unknown_leaves_schedule_alone(engine):
    with Session(engine) as session:
        assert review_core.schedule_after_verdict(session, 1, "unknown", NOW) is None
        assert _cards(session) == []


def test_unknown_does_not_touch_existing_card(engine):
    with Session(engine) as session:
        review_core.schedule_after_verdict(session, 1, "correct", NOW)
        before = _cards(session)[0].due_at
        assert review_core.schedule_after_verdict(session, 1, "unknown", NOW) is None
        assert _cards(session)[0].due_at == before


def test_sprint_compression_applies_to_auto_cards(engine):
    with Session(engine) as session:
        course = session.get(Course, 1)
        assert course is not None
        course.exam_date = NOW + timedelta(days=4)
        session.add(course)
        session.commit()
        card = review_core.schedule_after_verdict(session, 1, "correct", NOW)
        assert card is not None
        assert card.due_at < course.exam_date + timedelta(hours=32)


def _stub_grade(monkeypatch: pytest.MonkeyPatch, verdict: str) -> None:
    async def fake_stream(messages, model=None) -> AsyncIterator[str]:
        yield "【判定】" + verdict + "\n"
        yield "步骤 1 正确。"

    monkeypatch.setattr(core.llm, "chat_stream", fake_stream)


@pytest.mark.anyio()
async def test_grade_endpoint_creates_card(engine, monkeypatch: pytest.MonkeyPatch):
    _stub_grade(monkeypatch, "错误")
    with Session(engine) as session:
        problem = session.get(Problem, 1)
        assert problem is not None
        session.expunge(problem)
    events = [event async for event in core.stream_grade(problem, "我的作答")]
    assert ("verdict", "wrong") in events
    with Session(engine) as session:
        cards = _cards(session)
        assert len(cards) == 1
        assert (cards[0].problem_id, cards[0].lapses) == (1, 1)


@pytest.mark.anyio()
async def test_correct_grade_advances_existing_card(engine, monkeypatch: pytest.MonkeyPatch):
    with Session(engine) as session:
        review_core.schedule_after_verdict(session, 2, "wrong", NOW)
    _stub_grade(monkeypatch, "正确")
    with Session(engine) as session:
        problem = session.get(Problem, 2)
        assert problem is not None
        session.expunge(problem)
    [event async for event in core.stream_grade(problem, "作答")]
    with Session(engine) as session:
        card = _cards(session)[0]
        assert card.reps == 1
        assert card.lapses == 1


@pytest.mark.anyio()
async def test_exam_grading_creates_cards(engine, monkeypatch: pytest.MonkeyPatch):
    async def fake_grade(problem, answer_text):
        return ("partial" if answer_text else "unanswered"), "反馈"

    monkeypatch.setattr(exam_core, "grade_one", fake_grade)
    with Session(engine) as session:
        from app.models import ExamAnswer, MockExam

        session.add(
            MockExam(
                id=1,
                course_id=1,
                problem_ids="[1, 2]",
                question_count=2,
                duration_minutes=10,
                status="grading",
                created_at=NOW,
            )
        )
        session.add_all(
            [
                ExamAnswer(exam_id=1, problem_id=1, answer_text="作答 1"),
                ExamAnswer(exam_id=1, problem_id=2, answer_text=""),
            ]
        )
        session.commit()

    await exam_core.run_grading(1)

    with Session(engine) as session:
        cards = {c.problem_id: c for c in _cards(session)}
        assert set(cards) == {1, 2}
        assert cards[1].reps == 1  # 部分正确
        assert cards[2].lapses == 1  # 未作答按错误处理
