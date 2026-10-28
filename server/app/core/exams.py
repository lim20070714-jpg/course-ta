"""限时模考核心：组卷、逐题批改与计分。

组卷只取「有参考答案」的题目——材料自带答案或已落库的 AI 详解都算；没有依据就无法给出可信判定。
批改复用题库的步骤级提示词（core.problems.GRADE_SYSTEM），判定同时写入 Attempt，
所以模考里做错的题会自然出现在错题本里，可以一键加入复习计划。

判分是后台任务（一题一次模型调用，整卷可能要几分钟），进度记在进程内 _JOBS：
服务重启会丢任务态，但已批改的逐题结果都在数据库里，成绩单依旧可用。
"""

import json
import random
from typing import Any

from sqlmodel import Session, select

from app import config, db
from app.core import llm, review
from app.core.problems import GRADE_SYSTEM, detect_verdict, parse_tags, reference_for_grading
from app.models import Attempt, ExamAnswer, MockExam, Problem

# 判定 → 单题得分（正确 1、部分正确 0.5，其余 0）
VERDICT_SCORE = {
    "correct": 1.0,
    "partial": 0.5,
    "wrong": 0.0,
    "unknown": 0.0,
    "unanswered": 0.0,
}

_JOBS: dict[int, dict[str, Any]] = {}


def parse_problem_ids(raw: str) -> list[int]:
    try:
        data = json.loads(raw or "[]")
    except json.JSONDecodeError:
        return []
    return [int(x) for x in data if isinstance(x, (int, float, str)) and str(x).isdigit()]


def job_status(exam_id: int) -> dict[str, Any]:
    job = _JOBS.get(exam_id)
    if job is None:
        return {"status": "idle", "graded": 0, "total": 0, "error": ""}
    return dict(job)


def clear_job(exam_id: int) -> None:
    _JOBS.pop(exam_id, None)


def gradeable(problems: list[Problem]) -> list[Problem]:
    """可组进卷子的题目：题干非空，且有材料答案或已落库的 AI 详解作为批改依据。"""
    return [p for p in problems if p.stem.strip() and (p.answer.strip() or p.solution.strip())]


def assemble(problems: list[Problem], count: int, seed: int | None = None) -> list[Problem]:
    """随机抽 count 题；候选不足则全取。给定 seed 时可复现同一份卷子。"""
    pool = gradeable(problems)
    if count >= len(pool):
        return list(pool)
    rng = random.Random(seed) if seed is not None else random
    return rng.sample(pool, count)


def knowledge_of(problem: Problem) -> list[str]:
    return parse_tags(problem.knowledge)


def score_percent(verdicts: list[str]) -> float:
    """百分制得分。"""
    if not verdicts:
        return 0.0
    total = sum(VERDICT_SCORE.get(v, 0.0) for v in verdicts)
    return round(total / len(verdicts) * 100, 1)


async def grade_one(problem: Problem, answer_text: str) -> tuple[str, str]:
    """批改一题，返回 (verdict, feedback)。空白作答不调用模型，直接记为未作答。"""
    if not answer_text.strip():
        return "unanswered", ""
    ref = reference_for_grading(problem)
    text = await llm.complete(
        [
            {"role": "system", "content": GRADE_SYSTEM},
            {
                "role": "user",
                "content": (
                    f"题目（{problem.number or '未编号'}）：\n{problem.stem}\n{ref}\n"
                    f"学生作答：\n{answer_text}"
                ),
            },
        ],
        max_tokens=1200,
        timeout_s=180.0,
        model=config.current().problem_model,
    )
    return detect_verdict(text) or "unknown", text.strip()


async def run_grading(exam_id: int) -> None:
    """后台逐题批改整卷：写回 ExamAnswer 判定与反馈，并记一笔 Attempt。"""
    _JOBS[exam_id] = {"status": "running", "graded": 0, "total": 0, "error": ""}
    try:
        with Session(db.engine) as session:
            exam = session.get(MockExam, exam_id)
            if exam is None:
                _JOBS[exam_id] = {"status": "failed", "graded": 0, "total": 0, "error": "考试不存在"}
                return
            ids = parse_problem_ids(exam.problem_ids)
            problems = {
                p.id: p
                for p in session.exec(  # type: ignore[call-overload]
                    select(Problem).where(Problem.id.in_(ids))  # type: ignore[attr-defined]
                ).all()
            }
            rows = {
                a.problem_id: a
                for a in session.exec(  # type: ignore[call-overload]
                    select(ExamAnswer).where(ExamAnswer.exam_id == exam_id)
                ).all()
            }
            plan = [(problems[pid], rows.get(pid)) for pid in ids if pid in problems]
        _JOBS[exam_id]["total"] = len(plan)

        for problem, row in plan:
            answer_text = row.answer_text if row else ""
            verdict, feedback = await grade_one(problem, answer_text)
            with Session(db.engine) as session:
                if row is not None and row.id is not None:
                    stored = session.get(ExamAnswer, row.id)
                    if stored is not None:
                        stored.verdict = verdict
                        stored.feedback = feedback
                        session.add(stored)
                else:
                    session.add(
                        ExamAnswer(
                            exam_id=exam_id,
                            problem_id=problem.id or 0,
                            answer_text="",
                            verdict=verdict,
                            feedback=feedback,
                        )
                    )
                # 未作答也记一笔（判为错误），让模考跳过的问题进错题本
                counted = "wrong" if verdict == "unanswered" else verdict
                session.add(
                    Attempt(
                        problem_id=problem.id or 0,
                        answer_text=answer_text,
                        verdict=counted,
                        feedback=feedback or "【判定】错误\n\n未作答。",
                    )
                )
                session.commit()
                review.schedule_after_verdict(session, problem.id or 0, counted)
            _JOBS[exam_id]["graded"] += 1

        with Session(db.engine) as session:
            exam = session.get(MockExam, exam_id)
            graded = {
                a.problem_id: a.verdict
                for a in session.exec(  # type: ignore[call-overload]
                    select(ExamAnswer).where(ExamAnswer.exam_id == exam_id)
                ).all()
            }
            if exam is not None:
                verdicts = [graded.get(pid, "unanswered") for pid in parse_problem_ids(exam.problem_ids)]
                exam.score = score_percent(verdicts)
                exam.status = "done"
                exam.error = ""
                session.add(exam)
                session.commit()
        _JOBS[exam_id] = {"status": "done", "graded": len(plan), "total": len(plan), "error": ""}
    except Exception as exc:  # noqa: BLE001  边界：把失败原因暴露给前端
        _JOBS[exam_id] = {
            **_JOBS.get(exam_id, {}),
            "status": "failed",
            "error": str(exc)[:300],
        }
        with Session(db.engine) as session:
            exam = session.get(MockExam, exam_id)
            if exam is not None:
                exam.status = "failed"
                exam.error = str(exc)[:300]
                session.add(exam)
                session.commit()
