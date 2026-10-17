"""实验台图纸：把画布上的元件与连线存到服务端，换浏览器也能接着画。

前端拥有画布结构（`comps` / `wires` 的字段），服务端只校验顶层形状与大小，
把 JSON 原样存下来再原样还回去——这样加一种元件不用动后端。
"""

import json
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from sqlmodel import Session, select

from app import db
from app.models import LabDrawing
from app.schemas import LabDrawingDeleted, LabDrawingDetail, LabDrawingIn, LabDrawingRead

router = APIRouter(tags=["labs"])

MAX_NAME = 60
MAX_BUILD_CHARS = 200_000  # 一张 32×18 网格的图纸远小于这个数，超了就是前端出了毛病


def validate_build(build: dict[str, Any]) -> tuple[str, int, int]:
    """校验画布内容并序列化成入库字符串，返回 (json, 元件数, 连线数)。"""
    comps = build.get("comps")
    wires = build.get("wires")
    if not isinstance(comps, list) or not isinstance(wires, list):
        raise HTTPException(422, "图纸必须有 comps 与 wires 两个数组")
    if not all(isinstance(c, dict) for c in comps) or not all(isinstance(w, dict) for w in wires):
        raise HTTPException(422, "图纸里的元件与连线必须是对象")
    payload = json.dumps({"comps": comps, "wires": wires}, ensure_ascii=False)
    if len(payload) > MAX_BUILD_CHARS:
        raise HTTPException(422, f"图纸过大（{len(payload)} 字符，上限 {MAX_BUILD_CHARS}）")
    return payload, len(comps), len(wires)


def validate_name(raw: str) -> str:
    name = raw.strip()
    if not name:
        raise HTTPException(422, "图纸名不能为空")
    return name[:MAX_NAME]


def to_read(row: LabDrawing, comp_count: int, wire_count: int) -> LabDrawingRead:
    return LabDrawingRead(
        id=row.id or 0,
        name=row.name,
        lab_id=row.lab_id,
        comp_count=comp_count,
        wire_count=wire_count,
        updated_at=row.updated_at,
    )


def counts_of(row: LabDrawing) -> tuple[int, int]:
    try:
        build = json.loads(row.build)
    except json.JSONDecodeError:
        return 0, 0
    if not isinstance(build, dict):
        return 0, 0
    comps = build.get("comps")
    wires = build.get("wires")
    return (
        len(comps) if isinstance(comps, list) else 0,
        len(wires) if isinstance(wires, list) else 0,
    )


def to_detail(row: LabDrawing) -> LabDrawingDetail:
    try:
        build = json.loads(row.build)
    except json.JSONDecodeError:
        build = {"comps": [], "wires": []}
    comps, wires = counts_of(row)
    return LabDrawingDetail(
        id=row.id or 0,
        name=row.name,
        lab_id=row.lab_id,
        build=build if isinstance(build, dict) else {"comps": [], "wires": []},
        comp_count=comps,
        wire_count=wires,
        updated_at=row.updated_at,
    )


def reject_duplicate_name(
    session: Session, name: str, lab_id: str, keep_id: int | None = None
) -> None:
    """同名图纸会让人分不清存的是哪张，所以直接拒绝而不是自动加后缀。"""
    stmt = select(LabDrawing).where(LabDrawing.name == name).where(LabDrawing.lab_id == lab_id)
    for row in session.exec(stmt).all():
        if row.id != keep_id:
            raise HTTPException(409, f"已存在同名图纸：{name}")


@router.get("/labs/drawings", response_model=list[LabDrawingRead])
def list_drawings(lab_id: str = Query("")) -> list[LabDrawingRead]:
    """图纸列表，最近改动的排前面；`lab_id` 为空表示所有实验。"""
    with Session(db.engine) as session:
        stmt = select(LabDrawing).order_by(LabDrawing.updated_at.desc(), LabDrawing.id.desc())  # type: ignore[arg-type]
        rows = session.exec(stmt.where(LabDrawing.lab_id == lab_id) if lab_id else stmt).all()
        return [to_read(row, *counts_of(row)) for row in rows]


@router.post("/labs/drawings", response_model=LabDrawingDetail)
def create_drawing(payload: LabDrawingIn) -> LabDrawingDetail:
    name = validate_name(payload.name)
    lab_id = payload.lab_id.strip()[:40] or "__free"
    build, _, _ = validate_build(payload.build)
    with Session(db.engine) as session:
        reject_duplicate_name(session, name, lab_id)
        row = LabDrawing(name=name, lab_id=lab_id, build=build)
        session.add(row)
        session.commit()
        session.refresh(row)
        return to_detail(row)


@router.get("/labs/drawings/{drawing_id}", response_model=LabDrawingDetail)
def get_drawing(drawing_id: int) -> LabDrawingDetail:
    with Session(db.engine) as session:
        row = session.get(LabDrawing, drawing_id)
        if row is None:
            raise HTTPException(404, "图纸不存在")
        return to_detail(row)


@router.put("/labs/drawings/{drawing_id}", response_model=LabDrawingDetail)
def update_drawing(drawing_id: int, payload: LabDrawingIn) -> LabDrawingDetail:
    """整张覆盖保存：名字、归属实验与画布内容一起更新。"""
    name = validate_name(payload.name)
    lab_id = payload.lab_id.strip()[:40] or "__free"
    build, _, _ = validate_build(payload.build)
    with Session(db.engine) as session:
        row = session.get(LabDrawing, drawing_id)
        if row is None:
            raise HTTPException(404, "图纸不存在")
        reject_duplicate_name(session, name, lab_id, keep_id=drawing_id)
        row.name = name
        row.lab_id = lab_id
        row.build = build
        row.updated_at = datetime.now(UTC)
        session.add(row)
        session.commit()
        session.refresh(row)
        return to_detail(row)


@router.delete("/labs/drawings/{drawing_id}", response_model=LabDrawingDeleted)
def delete_drawing(drawing_id: int) -> LabDrawingDeleted:
    """只删图纸本身：它不影响资料、题目与学习记录。"""
    with Session(db.engine) as session:
        row = session.get(LabDrawing, drawing_id)
        if row is None:
            raise HTTPException(404, "图纸不存在")
        name = row.name
        session.delete(row)
        session.commit()
    return LabDrawingDeleted(name=name)
