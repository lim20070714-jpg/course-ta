from fastapi import APIRouter, HTTPException
from sqlmodel import Session, select

from app import db
from app.core import compute
from app.models import Formula
from app.schemas import (
    ComputeRequest,
    ComputeResult,
    FormulaCreate,
    FormulaRead,
    FormulaUpdate,
)

router = APIRouter(tags=["compute"])

_CATEGORIES = ("高等微积分", "线性代数", "物理", "电子", "复变函数", "自定义")


@router.post("/compute/evaluate", response_model=ComputeResult)
def compute_evaluate(req: ComputeRequest) -> ComputeResult:
    try:
        result = compute.evaluate(req.model_dump())
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    return ComputeResult(**result)


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
    """首次启动时写入预置公式库（用户可编辑/删除）。"""
    with Session(db.engine) as session:
        if session.exec(select(Formula.id).limit(1)).first() is not None:
            return
        for item in compute.PRESET_FORMULAS:
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
