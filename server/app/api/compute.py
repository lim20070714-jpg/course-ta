import json
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import Session, delete, select

from app import db
from app.core import compute
from app.models import ComputeRun, Formula
from app.schemas import (
    ComputeHistoryCleared,
    ComputeHistoryRead,
    ComputeRequest,
    ComputeResult,
    ComputeRunRead,
    FormulaCreate,
    FormulaRead,
    FormulaUpdate,
)

router = APIRouter(tags=["compute"])

_CATEGORIES = ("微积分", "代数", "变换", "线性代数", "复数", "物理与工程", "自定义")
HISTORY_KEEP = 200  # 计算台只留最近这么多条，写满就裁最老的
_AUX_FIELDS = ("var", "point", "lower", "upper", "order")


def record_run(req: ComputeRequest, result: ComputeResult | None, error: str) -> None:
    """把这次运算（成功或失败）记进历史，并把超出上限的旧行裁掉。

    失败也记：报错信息（「未识别的函数」「积分超时」）正是下次要避开的坑。
    历史只是附属功能，写失败不能把运算结果一起拖垮，所以这里吞掉异常。
    """
    args: dict[str, Any] = {field: getattr(req, field) for field in _AUX_FIELDS}
    args["symbols"] = [symbol.model_dump() for symbol in req.symbols]
    try:
        with Session(db.engine) as session:
            session.add(
                ComputeRun(
                    expr=req.expr[:2000],
                    op=req.op,
                    args=json.dumps(args, ensure_ascii=False),
                    result_latex=result.latex if result else "",
                    result_plain=result.plain if result else "",
                    approx=result.approx if result else "",
                    error=error,
                )
            )
            session.commit()
            stale = list(
                session.exec(
                    select(ComputeRun.id)
                    .order_by(ComputeRun.id.desc())  # type: ignore[attr-defined]
                    .offset(HISTORY_KEEP)
                ).all()
            )
            if stale:
                session.exec(delete(ComputeRun).where(ComputeRun.id.in_(stale)))  # type: ignore[attr-defined]
                session.commit()
    except Exception:  # noqa: BLE001 - 历史记录不影响运算本身
        return


def run_read(row: ComputeRun) -> ComputeRunRead:
    try:
        args = json.loads(row.args)
    except json.JSONDecodeError:
        args = {}
    return ComputeRunRead(
        id=row.id or 0,
        expr=row.expr,
        op=row.op,
        args=args if isinstance(args, dict) else {},
        result_latex=row.result_latex,
        result_plain=row.result_plain,
        approx=row.approx,
        error=row.error,
        created_at=row.created_at,
    )


@router.post("/compute/evaluate", response_model=ComputeResult)
def compute_evaluate(req: ComputeRequest) -> ComputeResult:
    try:
        result = compute.evaluate(req.model_dump())
    except ValueError as exc:
        record_run(req, None, str(exc))
        raise HTTPException(422, str(exc)) from exc
    out = ComputeResult(**result)
    record_run(req, out, "")
    return out


@router.get("/compute/history", response_model=ComputeHistoryRead)
def compute_history(limit: int = Query(50, ge=1, le=HISTORY_KEEP)) -> ComputeHistoryRead:
    """计算台历史，最新在前；`args` 足够把这一次运算原样回填到输入区。"""
    with Session(db.engine) as session:
        rows = list(session.exec(select(ComputeRun).order_by(ComputeRun.id.desc())).all())
    return ComputeHistoryRead(
        total=len(rows), kept=HISTORY_KEEP, items=[run_read(r) for r in rows[:limit]]
    )


@router.delete("/compute/history", response_model=ComputeHistoryCleared)
def clear_compute_history() -> ComputeHistoryCleared:
    with Session(db.engine) as session:
        removed = len(session.exec(select(ComputeRun.id)).all())
        session.exec(delete(ComputeRun))
        session.commit()
    return ComputeHistoryCleared(removed=removed)


def _to_read(formula: Formula) -> FormulaRead:
    return FormulaRead(
        id=formula.id or 0,
        title=formula.title,
        latex=formula.latex,
        category=formula.category,
        note=formula.note,
        preset=formula.preset,
    )


@router.get("/formulas", response_model=list[FormulaRead])
def list_formulas() -> list[FormulaRead]:
    with Session(db.engine) as session:
        rows = session.exec(select(Formula).order_by(Formula.id)).all()
    return [_to_read(f) for f in rows]


@router.post("/formulas", response_model=FormulaRead)
def create_formula(payload: FormulaCreate) -> FormulaRead:
    title = payload.title.strip()
    latex = payload.latex.strip()
    if not title or not latex:
        raise HTTPException(422, "标题与公式不能为空")
    category = payload.category if payload.category in _CATEGORIES else "自定义"
    with Session(db.engine) as session:
        formula = Formula(
            title=title[:80], latex=latex, category=category, note=payload.note.strip()[:200]
        )
        session.add(formula)
        session.commit()
        session.refresh(formula)
        return _to_read(formula)


@router.put("/formulas/{formula_id}", response_model=FormulaRead)
def update_formula(formula_id: int, payload: FormulaUpdate) -> FormulaRead:
    with Session(db.engine) as session:
        formula = session.get(Formula, formula_id)
        if formula is None:
            raise HTTPException(404, "公式不存在")
        if payload.title is not None and payload.title.strip():
            formula.title = payload.title.strip()[:80]
        if payload.latex is not None and payload.latex.strip():
            formula.latex = payload.latex.strip()
        if payload.category is not None and payload.category in _CATEGORIES:
            formula.category = payload.category
        if payload.note is not None:
            formula.note = payload.note.strip()[:200]
        session.add(formula)
        session.commit()
        session.refresh(formula)
        return _to_read(formula)


@router.delete("/formulas/{formula_id}")
def delete_formula(formula_id: int) -> dict[str, str]:
    with Session(db.engine) as session:
        formula = session.get(Formula, formula_id)
        if formula is None:
            raise HTTPException(404, "公式不存在")
        session.delete(formula)
        session.commit()
    return {"status": "ok"}


def seed_formulas() -> None:
    """写入预置公式库（用户可编辑/删除）；旧分类的预置项在升级时自动替换为普适分类。"""
    with Session(db.engine) as session:
        existing = session.exec(select(Formula)).all()
        stale = [f for f in existing if f.preset and f.category not in _CATEGORIES]
        for f in stale:
            session.delete(f)
        titles = {f.title for f in existing if f not in stale}
        for item in compute.PRESET_FORMULAS:
            if item["title"] in titles:
                continue
            session.add(
                Formula(
                    title=item["title"],
                    latex=item["latex"],
                    category=item["category"],
                    note=item.get("note", ""),
                    preset=True,
                )
            )
        session.commit()
