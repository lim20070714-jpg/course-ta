"""限时模考 API：组卷、开考、作答、交卷与批改。

计时以服务端为准：deadline_at = started_at + duration_min，
每个响应都带 seconds_left，前端倒计时只做显示，超时由交卷请求判定 late。
"""

import json
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlmodel import Session, select

from app import db
from app.api.problems import _material_names
from app.core import exams as core
from app.models import ExamAnswer, MockExam, Problem
from app.schemas import (
    ExamAnswerUpdate,
    MockExamCreate,
    MockExamDetail,
    MockExamItem,
    MockExamListItem,
    MockExamRead,
)

router = APIRouter(tags=["exams"])


def _load_exam(session: Session, exam_id: int) -> MockExam:
    exam = session.get(MockExam, exam_id)
    if exam is None:
        raise HTTPException(404, "这场模考不存在")
    return exam


def _seconds_left(exam: MockExam, now: datetime) -> int:
    if exam.deadline_at is None:
        return exam.duration_min * 60
    if exam.submitted_at is not None:
        return 0
    return max(0, int((exam.deadline_at - now).total_seconds()))


def _read(session: Session, exam: MockExam, now: datetime) -> MockExamRead:
    ids = core.parse_problem_ids(exam.problem_ids)
    answers = {
        a.problem_id: a
        for a in session.exec(  # type: ignore[call-overload]
            select(ExamAnswer).where(ExamAnswer.exam_id == exam.id)
        ).all()
    }
    job = core.job_status(exam.id or 0)
    count = len(ids)
    graded = int(job.get("graded", 0)) if exam.status == "grading" else (count if exam.status == "done" else 0)
    return MockExamRead(
        id=exam.id or 0,
        course_id=exam.course_id,
        title=exam.title,
        status=exam.status,
        count=count,
        duration_min=exam.duration_min,
        score=exam.score,
        late=exam.late,
        started_at=exam.started_at,
        deadline_at=exam.deadline_at,
        submitted_at=exam.submitted_at,
        seconds_left=_seconds_left(exam, now),
        answered=sum(1 for pid in ids if answers.get(pid) and answers[pid].answer_text.strip()),
        graded=graded,
        error=exam.error,
    )


def _ordered_problems(session: Session, exam: MockExam) -> list[Problem]:
    ids = core.parse_problem_ids(exam.problem_ids)
    if not ids:
        return []
    found = session.exec(  # type: ignore[call-overload]
        select(Problem).where(Problem.id.in_(ids))  # type: ignore[attr-defined]
    ).all()
    by_id = {p.id: p for p in found}
    return [by_id[pid] for pid in ids if pid in by_id]


@router.post("/courses/{course_id}/mock-exams", response_model=MockExamRead)
def create_exam(course_id: int, payload: MockExamCreate) -> MockExamRead:
    now = datetime.now(UTC)
    with Session(db.engine) as session:
        problems = session.exec(  # type: ignore[call-overload]
            select(Problem).where(Problem.course_id == course_id).order_by(Problem.id)  # type: ignore[arg-type]
        ).all()
        pool = list(problems)
        if payload.material_id is not None:
            pool = [p for p in pool if p.material_id == payload.material_id]
        if payload.knowledge:
            pool = [p for p in pool if payload.knowledge in core.knowledge_of(p)]
        picked = core.assemble(pool, max(1, payload.count))
        if not picked:
            raise HTTPException(400, "没有可用于组卷的题目（需要带参考答案，请先在题库提取真题）")
        exam = MockExam(
            course_id=course_id,
            title=payload.title.strip()
            or f"模拟卷 {now.strftime('%m-%d %H:%M')}（{len(picked)} 题 / {payload.duration_min} 分钟）",
            duration_min=max(1, payload.duration_min),
            problem_ids=json.dumps([p.id for p in picked]),
            status="ready",
        )
        session.add(exam)
        session.commit()
        session.refresh(exam)
        return _read(session, exam, now)


@router.get("/courses/{course_id}/mock-exams", response_model=list[MockExamListItem])
def list_exams(course_id: int) -> list[MockExamListItem]:
    with Session(db.engine) as session:
        rows = session.exec(  # type: ignore[call-overload]
            select(MockExam)
            .where(MockExam.course_id == course_id)
            .order_by(MockExam.id.desc())  # type: ignore[arg-type]
        ).all()
        return [
            MockExamListItem(
                id=e.id or 0,
                title=e.title,
                status=e.status,
                count=len(core.parse_problem_ids(e.problem_ids)),
                duration_min=e.duration_min,
                score=e.score,
                late=e.late,
                created_at=e.created_at,
                submitted_at=e.submitted_at,
            )
            for e in rows
        ]


@router.get("/mock-exams/{exam_id}", response_model=MockExamDetail)
def exam_detail(exam_id: int) -> MockExamDetail:
    now = datetime.now(UTC)
    with Session(db.engine) as session:
        exam = _load_exam(session, exam_id)
        names = _material_names(session, exam.course_id)
        answers = {
            a.problem_id: a
            for a in session.exec(  # type: ignore[call-overload]
                select(ExamAnswer).where(ExamAnswer.exam_id == exam_id)
            ).all()
        }
        reveal = exam.status == "done"
        items = [
            MockExamItem(
                problem_id=p.id or 0,
                number=p.number,
                material=names.get(p.material_id or -1, "来源已删除"),
                page=p.page,
                knowledge=core.knowledge_of(p),
                stem=p.stem,
                answer_text=(answers[p.id].answer_text if p.id in answers else ""),
                verdict=(answers[p.id].verdict if p.id in answers else "unanswered"),
                feedback=(answers[p.id].feedback if p.id in answers else ""),
                answer=(p.answer or p.solution) if reveal else "",
            )
            for p in _ordered_problems(session, exam)
        ]
        return MockExamDetail(exam=_read(session, exam, now), items=items)


@router.post("/mock-exams/{exam_id}/start", response_model=MockExamRead)
def start_exam(exam_id: int) -> MockExamRead:
    now = datetime.now(UTC)
    with Session(db.engine) as session:
        exam = _load_exam(session, exam_id)
        if exam.status in ("grading", "done"):
            raise HTTPException(409, "这场模考已经交卷了")
        if exam.status == "failed":
            raise HTTPException(409, "这场模考批改失败，请新建一场")
        if exam.started_at is None:
            exam.started_at = now
            exam.deadline_at = now + timedelta(minutes=exam.duration_min)
            exam.status = "running"
            session.add(exam)
            session.commit()
            session.refresh(exam)
        return _read(session, exam, now)


@router.put("/mock-exams/{exam_id}/answers/{problem_id}", response_model=MockExamDetail)
def save_answer(exam_id: int, problem_id: int, payload: ExamAnswerUpdate) -> MockExamDetail:
    now = datetime.now(UTC)
    with Session(db.engine) as session:
        exam = _load_exam(session, exam_id)
        if exam.status in ("grading", "done"):
            raise HTTPException(409, "已交卷，无法再修改作答")
        if problem_id not in core.parse_problem_ids(exam.problem_ids):
            raise HTTPException(404, "该题不在这场模考里")
        row = session.exec(  # type: ignore[call-overload]
            select(ExamAnswer)
            .where(ExamAnswer.exam_id == exam_id, ExamAnswer.problem_id == problem_id)
        ).first()
        if row is None:
            row = ExamAnswer(exam_id=exam_id, problem_id=problem_id)
        row.answer_text = payload.answer_text
        row.updated_at = now
        session.add(row)
        session.commit()
    return exam_detail(exam_id)


@router.post("/mock-exams/{exam_id}/submit", response_model=MockExamRead)
def submit_exam(exam_id: int, background_tasks: BackgroundTasks) -> MockExamRead:
    now = datetime.now(UTC)
    with Session(db.engine) as session:
        exam = _load_exam(session, exam_id)
        if exam.status == "done":
            raise HTTPException(409, "这场模考已经批改完成")
        if exam.status == "grading":
            raise HTTPException(409, "批改正在进行中")
        if exam.started_at is None:
            # 没点开考就交卷：按满分时长补一个起点，避免 deadline 为空
            exam.started_at = now
            exam.deadline_at = now + timedelta(minutes=exam.duration_min)
        exam.submitted_at = now
        exam.late = exam.deadline_at is not None and now > exam.deadline_at
        exam.status = "grading"
        exam.error = ""
        session.add(exam)
        session.commit()
        session.refresh(exam)
        read = _read(session, exam, now)
    background_tasks.add_task(core.run_grading, exam_id)
    return read


@router.delete("/mock-exams/{exam_id}", response_model=dict[str, str])
def delete_exam(exam_id: int) -> dict[str, str]:
    with Session(db.engine) as session:
        exam = _load_exam(session, exam_id)
        for row in session.exec(  # type: ignore[call-overload]
            select(ExamAnswer).where(ExamAnswer.exam_id == exam_id)
        ).all():
            session.delete(row)
        session.delete(exam)
        session.commit()
    core.clear_job(exam_id)
    return {"status": "deleted"}
