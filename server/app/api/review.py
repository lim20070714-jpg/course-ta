"""复习计划 API：SM-2 卡片的加入、自评、到期队列与统计。"""

import json
from datetime import UTC, datetime, time, timedelta

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import Session, select

from app import db
from app.api.problems import _excerpt
from app.core.review import apply_sm2, clamp_quality
from app.models import Material, Problem, ReviewCard
from app.schemas import (
    ReviewCardRead,
    ReviewDayCount,
    ReviewDueItem,
    ReviewGradeRequest,
    ReviewStatsRead,
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


@router.get("/courses/{course_id}/review/due", response_model=list[ReviewDueItem])
def due_cards(
    course_id: int,
    limit: int = Query(100, ge=1, le=500),
) -> list[ReviewDueItem]:
    with Session(db.engine) as session:
        now = datetime.now(UTC)
        rows = session.exec(
            select(ReviewCard, Problem, Material)
            .join(Problem, Problem.id == ReviewCard.problem_id)
            .join(Material, Material.id == Problem.material_id, isouter=True)
            .where(ReviewCard.course_id == course_id, ReviewCard.due_at <= now)
            .order_by(ReviewCard.due_at, ReviewCard.problem_id)  # type: ignore[arg-type]
            .limit(limit)
        ).all()
        return [
            ReviewDueItem(
                **_card_read(card).model_dump(),
                number=problem.number,
                material=material.filename if material else "未知材料",
                page=problem.page,
                excerpt=_excerpt(problem.stem),
                knowledge=[] if not problem.knowledge else json.loads(problem.knowledge),
            )
            for card, problem, material in rows
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
            ReviewDueItem(
                **_card_read(card).model_dump(),
                number=problem.number,
                material=material.filename if material else "未知材料",
                page=problem.page,
                excerpt=_excerpt(problem.stem),
                knowledge=[] if not problem.knowledge else json.loads(problem.knowledge),
            )
            for card, problem, material in rows
        ]


@router.get("/courses/{course_id}/review/stats", response_model=ReviewStatsRead)
def review_stats(course_id: int) -> ReviewStatsRead:
    with Session(db.engine) as session:
        now = datetime.now(UTC)
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
        return ReviewStatsRead(
            card_count=len(cards),
            due_now=sum(1 for c in cards if c.due_at <= now),
            reviewed_today=sum(1 for c in cards if c.last_review_at and c.last_review_at >= day_start),
            forecast=forecast,
        )


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
        now = datetime.now(UTC)
        card.ease, card.interval_days, card.reps, card.lapses, card.due_at = apply_sm2(
            card.ease, card.interval_days, card.reps, card.lapses, quality, now
        )
        card.last_review_at = now
        session.add(card)
        session.commit()
        session.refresh(card)
        return _card_read(card)
