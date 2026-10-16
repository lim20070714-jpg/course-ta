"""复习计划 API：SM-2 卡片的加入、自评、到期队列与统计。

考试冲刺模式（v0.9）：课程设置考试日期后，距考试 <= 30 天进入冲刺期——
1. 判分时间隔被压缩到考试之前的复习节奏（见 core.review.apply_sm2）；
2. 到期队列改为按「知识点高频程度」加权排序，并纳入尚未到期的卡片，
   让学生可以提前推进最可能考到的内容。
"""

import json
from datetime import UTC, datetime, time, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import Session, select

from app import db
from app.api.problems import _excerpt
from app.core.review import (
    SPRINT_SCHEDULE,
    apply_sm2,
    card_weight,
    clamp_quality,
    days_until,
    exam_deadline,
    is_sprint,
    parse_exam_date,
    sprint_message,
    sprint_stage,
)
from app.models import Course, Material, Problem, ReviewCard
from app.schemas import (
    ExamDateRead,
    ExamDateUpdate,
    ReviewCardRead,
    ReviewDayCount,
    ReviewDueItem,
    ReviewGradeRequest,
    ReviewSprintRead,
    ReviewStatsRead,
    SprintRecommendation,
)

router = APIRouter(tags=["review"])

_FORECAST_DAYS = 7


def _card_read(card: ReviewCard) -> ReviewCardRead:
    return ReviewCardRead(
        problem_id=card.problem_id,
        course_id=card.course_id,
        ease=card.ease,
        interval_days=card.interval_days,
        reps=card.reps,
        lapses=card.lapses,
        due_at=card.due_at,
        last_review_at=card.last_review_at,
    )


def _problem_knowledge(problem: Problem) -> list[str]:
    if not problem.knowledge:
        return []
    try:
        tags = json.loads(problem.knowledge)
    except (TypeError, ValueError):
        return []
    # 保持标签原样（历史数据均为字符串；非字符串也不做类型转换，避免响应形状漂移）
    return list(tags) if isinstance(tags, list) else []


def _tag_counts(session: Session, course_id: int) -> dict[str, int]:
    """知识点 -> 关联题目数（用于衡量「考点热度」）。"""
    counts: dict[str, int] = {}
    problems = session.exec(select(Problem).where(Problem.course_id == course_id)).all()
    for problem in problems:
        for tag in set(_problem_knowledge(problem)):
            counts[tag] = counts.get(tag, 0) + 1
    return counts


def _due_item(
    card: ReviewCard,
    problem: Problem,
    material: Material | None,
    weight: float = 0.0,
    reasons: list[str] | None = None,
    exam_at: datetime | None = None,
) -> ReviewDueItem:
    if exam_at is not None:
        # 冲刺模式下顺带说明这张卡相对考试日的安排位置
        days_before_exam = (exam_at - card.due_at).days
        if days_before_exam <= 0:
            reasons = [*(reasons or []), "考试前需完成"]
        else:
            reasons = [*(reasons or []), f"考前 {days_before_exam} 天"]
    return ReviewDueItem(
        **_card_read(card).model_dump(),
        number=problem.number,
        material=material.filename if material else "未知材料",
        page=problem.page,
        excerpt=_excerpt(problem.stem),
        knowledge=_problem_knowledge(problem),
        weight=weight,
        reasons=reasons or [],
    )


def _exam_of(session: Session, course_id: int) -> tuple[Course, int | None, datetime | None]:
    """返回 (课程, 距考试天数, 考试截止时刻)。未设置考试日期时后两项为 None。"""
    course = session.get(Course, course_id)
    if course is None:
        raise HTTPException(404, "课程不存在")
    now = datetime.now(UTC)
    if course.exam_date is None:
        return course, None, None
    return course, days_until(course.exam_date, now), exam_deadline(course.exam_date)


@router.get("/courses/{course_id}/review/sprint", response_model=ReviewSprintRead)
def sprint_overview(course_id: int) -> ReviewSprintRead:
    """考试冲刺概览：倒计时、压缩节奏、阶段与最高频考点。"""
    with Session(db.engine) as session:
        course, days_left, _exam_at = _exam_of(session, course_id)
        now = datetime.now(UTC)
        cards = session.exec(select(ReviewCard).where(ReviewCard.course_id == course_id)).all()
        tag_counts = _tag_counts(session, course_id)
        due_count = sum(1 for c in cards if c.due_at <= now)
        active = is_sprint(days_left)
        if not active:
            if course.exam_date is None:
                status = "none"
            elif days_left is not None and days_left < 0:
                status = "over"
            else:
                status = "normal"  # 考试日期还很远（> 30 天）
            return ReviewSprintRead(
                course_id=course_id,
                exam_date=course.exam_date,
                days_left=days_left,
                sprint=False,
                status=status,
                schedule=list(SPRINT_SCHEDULE),
                due_count=due_count,
                sprint_pool=len(cards),
                recommended=due_count,
                tag_total=len(tag_counts),
                message=sprint_message(days_left, due_count),
                top_tags=_top_tags(tag_counts),
            )
        return ReviewSprintRead(
            course_id=course_id,
            exam_date=course.exam_date,
            days_left=days_left,
            sprint=True,
            status="sprint",
            schedule=list(SPRINT_SCHEDULE),
            stage=sprint_stage(days_left),
            due_count=due_count,
            sprint_pool=len(cards),
            recommended=len(cards),  # 冲刺期可提前推进全部计划卡片
            tag_total=len(tag_counts),
            message=sprint_message(days_left, len(cards)),
            top_tags=_top_tags(tag_counts),
        )


def _top_tags(tag_counts: dict[str, int], limit: int = 8) -> list[SprintRecommendation]:
    ranked = sorted(tag_counts.items(), key=lambda kv: (-kv[1], kv[0]))[:limit]
    return [
        SprintRecommendation(knowledge=tag, count=count, score=float(count))
        for tag, count in ranked
    ]


@router.get("/courses/{course_id}/review/due", response_model=list[ReviewDueItem])
def due_cards(
    course_id: int,
    limit: int = Query(100, ge=1, le=500),
    exam: bool = Query(False, description="true 时按考试冲刺模式取队列（含未到期卡片、按考点加权）"),
) -> list[ReviewDueItem]:
    """到期队列。

    `exam=true` 且课程已设置考试日期时进入冲刺模式：返回按考点热度加权的全部计划卡片
    （含尚未到期、但在考试之前需要复习的）；否则保持原有行为——只取已到期，
    按到期时间排序。截断始终发生在排序之后。
    """
    with Session(db.engine) as session:
        _course, days_left, exam_at = _exam_of(session, course_id)
        now = datetime.now(UTC)
        rows = session.exec(
            select(ReviewCard, Problem, Material)
            .join(Problem, Problem.id == ReviewCard.problem_id)
            .join(Material, Material.id == Problem.material_id, isouter=True)
            .where(ReviewCard.course_id == course_id)
        ).all()
        in_sprint = exam and is_sprint(days_left)
        if not in_sprint:
            # 非冲刺期：保持原有行为（只取已到期，按到期时间排序）
            due = [r for r in rows if r[0].due_at <= now]
            due.sort(key=lambda r: (r[0].due_at, r[0].problem_id))
            return [_due_item(card, problem, material) for card, problem, material in due[:limit]]
        tag_counts = _tag_counts(session, course_id)
        total_problems = len(rows) or len(tag_counts)
        scored: list[tuple[float, list[str], ReviewCard, Problem, Material | None]] = []
        for card, problem, material in rows:
            if exam_at is not None and card.due_at >= exam_at:
                continue  # 考试之后才到期的卡片不占用冲刺队列
            weight, reasons = card_weight(
                _problem_knowledge(problem),
                tag_counts,
                card.due_at,
                card.lapses,
                now,
                total_problems=total_problems,
                reps=card.reps,
            )
            scored.append((weight, reasons, card, problem, material))
        # 加权优先；同权按到期时间，再按题号保证稳定
        scored.sort(key=lambda r: (-r[0], r[2].due_at, r[2].problem_id))
        return [
            _due_item(c, p, m, w, r, exam_at=exam_at) for w, r, c, p, m in scored[:limit]
        ]


@router.get("/courses/{course_id}/review/cards", response_model=list[ReviewDueItem])
def all_cards(course_id: int) -> list[ReviewDueItem]:
    with Session(db.engine) as session:
        rows = session.exec(
            select(ReviewCard, Problem, Material)
            .join(Problem, Problem.id == ReviewCard.problem_id)
            .join(Material, Material.id == Problem.material_id, isouter=True)
            .where(ReviewCard.course_id == course_id)
            .order_by(ReviewCard.due_at, ReviewCard.problem_id)  # type: ignore[arg-type]
        ).all()
        return [
            _due_item(card, problem, material) for card, problem, material in rows
        ]


@router.get("/courses/{course_id}/review/stats", response_model=ReviewStatsRead)
def review_stats(course_id: int) -> ReviewStatsRead:
    with Session(db.engine) as session:
        now = datetime.now(UTC)
        course = session.get(Course, course_id)
        days_left = days_until(course.exam_date, now) if course else None
        cards = session.exec(
            select(ReviewCard).where(ReviewCard.course_id == course_id)
        ).all()
        today = now.date()
        day_start = datetime.combine(today, time.min, tzinfo=UTC)
        forecast: list[ReviewDayCount] = []
        for offset in range(_FORECAST_DAYS):
            day = today + timedelta(days=offset)
            if offset == 0:
                count = sum(1 for c in cards if c.due_at <= now)  # 逾期都算今天
            else:
                next_start = datetime.combine(day, time.min, tzinfo=UTC)
                day_end = next_start + timedelta(days=1)
                count = sum(1 for c in cards if next_start <= c.due_at < day_end)
            forecast.append(ReviewDayCount(date=day.isoformat(), count=count))
        # 考试日结束前到期的卡片数（含逾期）：冲刺期需要清空的量
        due_before_exam = 0
        if course is not None and course.exam_date is not None:
            exam_end = datetime.combine(
                course.exam_date.date() + timedelta(days=1), time.min, tzinfo=UTC
            )
            due_before_exam = sum(1 for c in cards if c.due_at < exam_end)
        return ReviewStatsRead(
            card_count=len(cards),
            due_now=sum(1 for c in cards if c.due_at <= now),
            reviewed_today=sum(1 for c in cards if c.last_review_at and c.last_review_at >= day_start),
            forecast=forecast,
            exam_date=course.exam_date if course else None,
            exam_days_left=days_left,
            due_before_exam=due_before_exam,
        )


@router.put("/courses/{course_id}/exam-date", response_model=ExamDateRead)
def set_exam_date(course_id: int, payload: ExamDateUpdate) -> ExamDateRead:
    """设置 / 清除课程考试日期。只改课程字段，不改动已有卡片的 due_at。"""
    raw = (payload.exam_date or "").strip()
    parsed: datetime | None = None
    if raw:
        try:
            parsed = parse_exam_date(raw)
        except ValueError as exc:
            raise HTTPException(400, "考试日期格式应为 YYYY-MM-DD") from exc
    with Session(db.engine) as session:
        course = session.get(Course, course_id)
        if course is None:
            raise HTTPException(404, "课程不存在")
        course.exam_date = parsed
        session.add(course)
        session.commit()
        session.refresh(course)
        return ExamDateRead(course_id=course_id, exam_date=course.exam_date)


@router.get("/problems/{problem_id}/review", response_model=ReviewCardRead | None)
def card_of(problem_id: int) -> ReviewCardRead | None:
    with Session(db.engine) as session:
        card = session.exec(
            select(ReviewCard).where(ReviewCard.problem_id == problem_id)
        ).first()
        return _card_read(card) if card else None


@router.put("/problems/{problem_id}/review", response_model=ReviewCardRead)
def enroll(problem_id: int) -> ReviewCardRead:
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        card = session.exec(
            select(ReviewCard).where(ReviewCard.problem_id == problem_id)
        ).first()
        if card is None:
            card = ReviewCard(problem_id=problem_id, course_id=problem.course_id)
            session.add(card)
            session.commit()
            session.refresh(card)
        return _card_read(card)


@router.delete("/problems/{problem_id}/review")
def remove(problem_id: int) -> dict[str, str]:
    with Session(db.engine) as session:
        card = session.exec(
            select(ReviewCard).where(ReviewCard.problem_id == problem_id)
        ).first()
        if card is None:
            raise HTTPException(404, "该题目不在复习计划中")
        session.delete(card)
        session.commit()
    return {"status": "removed"}


@router.post("/problems/{problem_id}/review/grade", response_model=ReviewCardRead)
def grade(problem_id: int, payload: ReviewGradeRequest) -> ReviewCardRead:
    quality = clamp_quality(payload.quality)
    with Session(db.engine) as session:
        card = session.exec(
            select(ReviewCard).where(ReviewCard.problem_id == problem_id)
        ).first()
        if card is None:
            raise HTTPException(404, "该题目不在复习计划中")
        course = session.get(Course, card.course_id)
        # 只有冲刺期（考试 0..30 天内）才压缩；考试日已过则回到普通 SM-2
        days_left = days_until(course.exam_date, datetime.now(UTC)) if course else None
        exam_at = (
            exam_deadline(course.exam_date)
            if course is not None and course.exam_date is not None and is_sprint(days_left)
            else None
        )
        now = datetime.now(UTC)
        card.ease, card.interval_days, card.reps, card.lapses, card.due_at = apply_sm2(
            card.ease,
            card.interval_days,
            card.reps,
            card.lapses,
            quality,
            now,
            exam_at=exam_at,
        )
        card.last_review_at = now
        session.add(card)
        session.commit()
        session.refresh(card)
        return _card_read(card)
