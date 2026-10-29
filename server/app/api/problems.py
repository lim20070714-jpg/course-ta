import json
import re
from collections.abc import AsyncIterator
from pathlib import Path

import pymupdf
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query
from fastapi.responses import Response
from sqlalchemy import func
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app import db
from app.core import problems as core
from app.core.crops import find_problem_rect
from app.models import Attempt, Material, Problem
from app.schemas import (
    AttemptHistoryCounts,
    AttemptHistoryItem,
    AttemptHistoryRead,
    AttemptRead,
    GradeRequest,
    ProblemDetailRead,
    ProblemListItem,
    ProblemListRead,
    ProblemSourceRead,
    SearchHit,
    TagCount,
    WrongItem,
)

router = APIRouter(tags=["problems"])


_EXCERPT_SYMBOLS = {
    "Omega": "Ω",
    "omega": "ω",
    "mu": "μ",
    "pi": "π",
    "times": "×",
    "cdot": "·",
    "pm": "±",
    "approx": "≈",
    "le": "≤",
    "ge": "≥",
    "neq": "≠",
    "infty": "∞",
    "alpha": "α",
    "beta": "β",
    "gamma": "γ",
    "delta": "δ",
    "lambda": "λ",
    "theta": "θ",
    "sigma": "σ",
    "tau": "τ",
    "phi": "φ",
}
_EXCERPT_WRAPPERS = r"text|mathbf|mathrm|mathit|overline|underline|hat|vec|bar"


def _excerpt(stem: str, width: int = 120) -> str:
    raw = re.sub(r"\$+", "", stem)
    inner = r"(?:[^{}]|\{[^{}]*\})*"
    raw = re.sub(rf"\\frac\{{({inner})\}}\{{({inner})\}}", r"(\1)/(\2)", raw)
    raw = re.sub(rf"\\(?:{_EXCERPT_WRAPPERS})\{{([^{{}}]*)\}}", r"\1", raw)
    raw = re.sub(r"\\(?:left|right|big|Big|displaystyle)\b\.?", "", raw)
    raw = re.sub(r"\\\\", " ", raw)
    raw = re.sub(
        r"\\([A-Za-z]+)", lambda m: _EXCERPT_SYMBOLS.get(m.group(1), m.group(1)), raw
    )
    raw = raw.replace("{", "").replace("}", "")
    raw = re.sub(r"[#*`>\[\]]+", " ", raw)
    raw = " ".join(raw.split())
    return raw if len(raw) <= width else raw[:width] + "…"


def _material_names(session: Session, course_id: int) -> dict[int, str]:
    return {
        m.id: m.filename
        for m in session.exec(select(Material).where(Material.course_id == course_id)).all()
    }


def _load_course_problems(session: Session, course_id: int) -> list[Problem]:
    return list(
        session.exec(
            select(Problem)
            .where(Problem.course_id == course_id)
            .order_by(Problem.material_id, Problem.page, Problem.id)  # type: ignore[arg-type]
        ).all()
    )


def _attempt_stats(
    session: Session, problem_ids: list[int]
) -> tuple[dict[int, int], dict[int, str], dict[int, Attempt]]:
    """每题的作答次数、最近判定、最近一次作答。"""
    if not problem_ids:
        return {}, {}, {}
    rows = session.exec(
        select(Attempt)
        .where(Attempt.problem_id.in_(problem_ids))  # type: ignore[attr-defined]
        .order_by(Attempt.created_at, Attempt.id)  # type: ignore[arg-type]
    ).all()
    counts: dict[int, int] = {}
    last: dict[int, Attempt] = {}
    for a in rows:
        counts[a.problem_id] = counts.get(a.problem_id, 0) + 1
        last[a.problem_id] = a
    return counts, {pid: a.verdict for pid, a in last.items()}, last


@router.get("/courses/{course_id}/problem-sources", response_model=list[ProblemSourceRead])
def problem_sources(course_id: int) -> list[ProblemSourceRead]:
    with Session(db.engine) as session:
        materials = session.exec(
            select(Material).where(Material.course_id == course_id).order_by(Material.id)
        ).all()
        counts = dict(
            session.exec(
                select(Problem.material_id, func.count(Problem.id))
                .where(Problem.course_id == course_id)
                .group_by(Problem.material_id)
            ).all()
        )
        out: list[ProblemSourceRead] = []
        for m in materials:
            job = core.job_status(m.id or 0)
            out.append(
                ProblemSourceRead(
                    material_id=m.id or 0,
                    filename=m.filename,
                    kind=m.kind,
                    status=m.status,
                    problem_count=counts.get(m.id, 0),
                    job_status=str(job.get("status", "idle")),
                    job_error=str(job.get("error", "")),
                )
            )
        return out


@router.post("/materials/{material_id}/extract-problems")
def extract_problems(material_id: int, background_tasks: BackgroundTasks) -> dict[str, str]:
    with Session(db.engine) as session:
        material = session.get(Material, material_id)
        if material is None:
            raise HTTPException(404, "材料不存在")
        if material.status != "ready":
            raise HTTPException(400, "材料尚未解析完成，无法提取题目")
    if core.job_status(material_id).get("status") == "running":
        raise HTTPException(409, "该材料的题目提取正在进行中")
    background_tasks.add_task(core.run_extraction, material_id)
    return {"status": "started"}


@router.get("/courses/{course_id}/problems", response_model=ProblemListRead)
def list_problems(
    course_id: int,
    material_id: int | None = Query(None),
    knowledge: str = Query(""),
    status: str = Query("", pattern="^(|unseen|wrong|correct)$"),
    q: str = Query("", max_length=100),
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> ProblemListRead:
    with Session(db.engine) as session:
        names = _material_names(session, course_id)
        problems = _load_course_problems(session, course_id)
        counts, verdicts, _ = _attempt_stats(session, [p.id or 0 for p in problems])

        items: list[ProblemListItem] = []
        for p in problems:
            if material_id is not None and p.material_id != material_id:
                continue
            tags = core.parse_tags(p.knowledge)
            if knowledge and knowledge not in tags:
                continue
            verdict = verdicts.get(p.id or 0, "")
            if status == "unseen" and p.id in verdicts:
                continue
            if status == "wrong" and verdict not in ("wrong", "partial"):
                continue
            if status == "correct" and verdict != "correct":
                continue
            if q and q.lower() not in p.stem.lower():
                continue
            items.append(
                ProblemListItem(
                    id=p.id or 0,
                    material_id=p.material_id,
                    material=names.get(p.material_id or -1, "来源已删除"),
                    page=p.page,
                    number=p.number,
                    excerpt=_excerpt(p.stem),
                    knowledge=tags,
                    attempt_count=counts.get(p.id or 0, 0),
                    last_verdict=verdict,
                )
            )
        total = len(items)
        return ProblemListRead(total=total, items=items[offset : offset + limit])


@router.get("/courses/{course_id}/attempts", response_model=AttemptHistoryRead)
def attempt_history(
    course_id: int,
    verdict: str = Query("", pattern="^(|correct|partial|wrong|unknown)$"),
    offset: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=500),
) -> AttemptHistoryRead:
    """做题足迹：整门课的作答记录，最新在前。

    Attempt 上没有 course_id（题目属于哪门课记在 Problem 上），所以要 join Problem 才能按课取。
    counts 恒为全量统计、只有 items 受筛选与分页影响——筛「做错」时也能看见一共做了多少题。
    """
    with Session(db.engine) as session:
        names = _material_names(session, course_id)
        rows = list(
            reversed(  # 逐题详情用正序取「最近一次」，足迹要倒序，直接反序列化更省事
                session.exec(
                    select(Attempt, Problem)
                    .join(Problem, Attempt.problem_id == Problem.id)
                    .where(Problem.course_id == course_id)
                    .order_by(Attempt.created_at, Attempt.id)  # type: ignore[arg-type]
                ).all()
            )
        )
        touched = {a.problem_id for a, _ in rows}
        ever_wrong = {a.problem_id for a, _ in rows if a.verdict in ("wrong", "partial")}
        by_verdict = {
            v: sum(1 for a, _ in rows if a.verdict == v)
            for v in ("correct", "partial", "wrong")
        }
        counts = AttemptHistoryCounts(
            total=len(rows),
            correct=by_verdict["correct"],
            partial=by_verdict["partial"],
            wrong=by_verdict["wrong"],
            unknown=len(rows) - sum(by_verdict.values()),
            problems_touched=len(touched),
            problems_ever_wrong=len(ever_wrong),
        )
        picked = [(a, p) for a, p in rows if not verdict or a.verdict == verdict]
        items = [
            AttemptHistoryItem(
                attempt_id=a.id or 0,
                problem_id=a.problem_id,
                material=names.get(p.material_id or -1, "已断开的来源"),
                page=p.page,
                number=p.number,
                excerpt=_excerpt(p.stem),
                knowledge=core.parse_tags(p.knowledge),
                verdict=a.verdict,
                answer_text=a.answer_text,
                feedback=a.feedback,
                created_at=a.created_at,
            )
            for a, p in picked[offset : offset + limit]
        ]
        return AttemptHistoryRead(counts=counts, filtered=len(picked), items=items)


@router.get("/problems/{problem_id}", response_model=ProblemDetailRead)
def problem_detail(problem_id: int) -> ProblemDetailRead:
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        names = _material_names(session, problem.course_id)
        attempts = session.exec(
            select(Attempt)
            .where(Attempt.problem_id == problem_id)
            .order_by(Attempt.created_at.desc(), Attempt.id.desc())  # type: ignore[attr-defined]
        ).all()
        return ProblemDetailRead(
            id=problem.id or 0,
            course_id=problem.course_id,
            material_id=problem.material_id,
            material=names.get(problem.material_id or -1, "来源已删除"),
            page=problem.page,
            number=problem.number,
            stem=problem.stem,
            answer=problem.answer,
            knowledge=core.parse_tags(problem.knowledge),
            solution=problem.solution,
            solution_citations=[
                SearchHit(**c) for c in core.parse_citations(problem.solution_citations)
            ],
            solution_model=problem.solution_model,
            attempts=[
                AttemptRead(
                    id=a.id or 0,
                    answer_text=a.answer_text,
                    verdict=a.verdict,
                    feedback=a.feedback,
                    created_at=a.created_at,
                )
                for a in attempts
            ],
        )


@router.get("/problems/{problem_id}/image")
def problem_image(
    problem_id: int,
    zoom: float = Query(2.0, ge=0.5, le=4.0),
) -> Response:
    """题目配图：从试卷页面裁剪出该题区域（题干与配图都在内）；定位失败时退化为整页。"""
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        material = session.get(Material, problem.material_id) if problem.material_id else None
        if material is None:
            raise HTTPException(404, "该题目没有来源材料")
        path, filename = material.stored_path, material.filename
        page_no, number = problem.page, problem.number
    if Path(path).suffix.lower() != ".pdf":
        raise HTTPException(400, f"{filename} 不是 PDF，暂不支持题目配图")
    with pymupdf.open(path) as doc:
        if page_no < 1 or page_no > doc.page_count:
            raise HTTPException(404, f"页码超出范围（共 {doc.page_count} 页）")
        page = doc[page_no - 1]
        clip = find_problem_rect(page, number)
        pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), clip=clip)
    return Response(
        content=pix.tobytes("png"),
        media_type="image/png",
        headers={"Cache-Control": "public, max-age=3600"},
    )


@router.post("/problems/{problem_id}/hint")
async def problem_hint(problem_id: int) -> dict[str, str]:
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        session.expunge(problem)
    try:
        return {"hint": await core.generate_hint(problem)}
    except Exception as exc:  # 边界：把可读错误发给前端
        raise HTTPException(502, f"提示生成失败：{exc}") from exc



@router.post("/problems/{problem_id}/grade")
async def grade_problem(problem_id: int, payload: GradeRequest) -> EventSourceResponse:
    answer = payload.answer.strip()
    if not answer:
        raise HTTPException(400, "请先填写你的作答")
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        session.expunge(problem)

    async def event_stream() -> AsyncIterator[dict]:
        try:
            async for kind, data in core.stream_grade(problem, answer):
                event = "verdict" if kind == "verdict" else "delta"
                body = {"verdict": data} if kind == "verdict" else {"text": data}
                yield {"event": event, "data": json.dumps(body, ensure_ascii=False)}
        except Exception as exc:  # noqa: BLE001  边界：把可读错误发给前端
            yield {"event": "error", "data": json.dumps({"message": str(exc)}, ensure_ascii=False)}
        finally:
            yield {"event": "done", "data": "{}"}

    return EventSourceResponse(event_stream())


@router.post("/problems/{problem_id}/solution")
async def problem_solution(problem_id: int, regenerate: bool = False) -> EventSourceResponse:
    with Session(db.engine) as session:
        problem = session.get(Problem, problem_id)
        if problem is None:
            raise HTTPException(404, "题目不存在")
        session.expunge(problem)

    async def event_stream() -> AsyncIterator[dict]:
        try:
            with Session(db.engine) as session:
                async for kind, data in core.stream_solution(session, problem, regenerate=regenerate):
                    if kind in ("meta", "citations"):
                        yield {"event": kind, "data": json.dumps(data, ensure_ascii=False)}
                    else:
                        yield {
                            "event": "delta",
                            "data": json.dumps({"text": data}, ensure_ascii=False),
                        }
        except Exception as exc:  # noqa: BLE001
            yield {"event": "error", "data": json.dumps({"message": str(exc)}, ensure_ascii=False)}
        finally:
            yield {"event": "done", "data": "{}"}

    return EventSourceResponse(event_stream())


@router.get("/courses/{course_id}/wrongbook", response_model=list[WrongItem])
def wrongbook(course_id: int) -> list[WrongItem]:
    with Session(db.engine) as session:
        names = _material_names(session, course_id)
        problems = _load_course_problems(session, course_id)
        counts, verdicts, last = _attempt_stats(session, [p.id or 0 for p in problems])
        items: list[WrongItem] = []
        for p in problems:
            verdict = verdicts.get(p.id or 0, "")
            if verdict not in ("wrong", "partial"):
                continue
            attempt = last.get(p.id or 0)
            items.append(
                WrongItem(
                    id=p.id or 0,
                    material_id=p.material_id,
                    material=names.get(p.material_id or -1, "来源已删除"),
                    page=p.page,
                    number=p.number,
                    excerpt=_excerpt(p.stem),
                    knowledge=core.parse_tags(p.knowledge),
                    attempt_count=counts.get(p.id or 0, 0),
                    last_verdict=verdict,
                    last_feedback=(
                        _excerpt(re.sub(r"^\s*【判定】[^\n]*\n*", "", attempt.feedback), 160)
                        if attempt
                        else ""
                    ),
                )
            )
        return items


@router.get("/courses/{course_id}/problem-tags", response_model=list[TagCount])
def problem_tags(course_id: int) -> list[TagCount]:
    with Session(db.engine) as session:
        problems = _load_course_problems(session, course_id)
        counts: dict[str, int] = {}
        for p in problems:
            for tag in core.parse_tags(p.knowledge):
                counts[tag] = counts.get(tag, 0) + 1
        ordered = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return [TagCount(tag=t, count=c) for t, c in ordered]
