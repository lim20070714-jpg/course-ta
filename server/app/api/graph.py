import json
import re

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlmodel import Session, select

from app import db
from app.core import graph as graph_core
from app.models import Concept, ConceptEdge, Course, CourseGraph, Material, Problem
from app.schemas import GraphEdgeRead, GraphNodeRead, GraphProblemRef, GraphRead

router = APIRouter(tags=["graph"])

_MAX_PROBLEMS_PER_NODE = 5


def _norm(text: str) -> str:
    return re.sub(r"\s+", "", text)


def _problem_index(course_id: int) -> dict[str, list[tuple[int, str, str]]]:
    with Session(db.engine) as session:
        rows = session.exec(select(Problem).where(Problem.course_id == course_id)).all()
        names = {
            m.id: m.filename
            for m in session.exec(
                select(Material).where(Material.course_id == course_id)
            ).all()
        }
    index: dict[str, list[tuple[int, str, str]]] = {}
    for problem in rows:
        if problem.id is None:
            continue
        try:
            tags = json.loads(problem.knowledge)
        except json.JSONDecodeError:
            continue
        if not isinstance(tags, list):
            continue
        source = names.get(problem.material_id, "") if problem.material_id else ""
        for tag in tags:
            key = _norm(str(tag))
            if len(key) < 2:
                continue
            index.setdefault(key, []).append((problem.id, problem.number, source))
    return index


def _match_problems(name: str, index: dict[str, list[tuple[int, str, str]]]) -> list[GraphProblemRef]:
    key = _norm(name)
    refs: list[GraphProblemRef] = []
    seen: set[int] = set()
    for tag_key, items in index.items():
        if key == tag_key or (len(key) >= 2 and (key in tag_key or tag_key in key)):
            for problem_id, number, source in items:
                if problem_id not in seen:
                    seen.add(problem_id)
                    refs.append(GraphProblemRef(id=problem_id, number=number, material=source))
    return refs[:_MAX_PROBLEMS_PER_NODE]


@router.get("/courses/{course_id}/graph", response_model=GraphRead)
def get_graph(course_id: int) -> GraphRead:
    with Session(db.engine) as session:
        course = session.get(Course, course_id)
        if course is None:
            raise HTTPException(404, "课程不存在")
        record = session.get(CourseGraph, course_id)
        concepts = session.exec(
            select(Concept).where(Concept.course_id == course_id).order_by(Concept.order)
        ).all()
        edges = session.exec(select(ConceptEdge).where(ConceptEdge.course_id == course_id)).all()
        names = {
            m.id: m.filename
            for m in session.exec(
                select(Material).where(Material.course_id == course_id)
            ).all()
        }
    index = _problem_index(course_id)
    nodes = [
        GraphNodeRead(
            id=concept.id or 0,
            name=concept.name,
            description=concept.description,
            module=concept.module,
            order=concept.order,
            material_id=concept.material_id,
            material=names.get(concept.material_id, "") if concept.material_id else "",
            page=concept.page,
            problems=_match_problems(concept.name, index),
        )
        for concept in concepts
    ]
    return GraphRead(
        course_id=course_id,
        status=record.status if record else "pending",
        error=record.error if record else "",
        overview=record.overview if record else "",
        nodes=nodes,
        edges=[
            GraphEdgeRead(
                source=edge.source_id,
                target=edge.target_id,
                relation=edge.relation,
                note=edge.note,
            )
            for edge in edges
        ],
    )


@router.post("/courses/{course_id}/graph", status_code=202)
def regenerate_graph(course_id: int, background: BackgroundTasks) -> dict[str, str]:
    with Session(db.engine) as session:
        if session.get(Course, course_id) is None:
            raise HTTPException(404, "课程不存在")
        record = session.get(CourseGraph, course_id)
        if record and record.status == "generating":
            return {"status": "generating"}
        row = record or CourseGraph(course_id=course_id)
        row.status = "generating"
        row.error = ""
        session.add(row)
        session.commit()
    background.add_task(graph_core.generate_graph, course_id)
    return {"status": "accepted"}
