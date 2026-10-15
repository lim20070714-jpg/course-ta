"""生成课程知识图谱（在 server/ 目录下运行）。

用法：
    uv run python scripts/build_graph.py                # 全部课程
    uv run python scripts/build_graph.py --course-id 1  # 指定课程
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, select

from app import db
from app.core import graph
from app.models import Concept, ConceptEdge, Course, CourseGraph


async def main() -> None:
    parser = argparse.ArgumentParser(description="生成课程知识图谱")
    parser.add_argument("--course-id", type=int, help="只处理指定课程")
    args = parser.parse_args()

    with Session(db.engine) as session:
        stmt = select(Course).order_by(Course.id)
        if args.course_id:
            stmt = stmt.where(Course.id == args.course_id)
        courses = [(c.id, c.name) for c in session.exec(stmt).all()]

    print(f"待生成知识图谱 {len(courses)} 门课程", flush=True)
    started = time.time()
    for i, (course_id, name) in enumerate(courses, 1):
        await graph.generate_graph(course_id)
        with Session(db.engine) as session:
            record = session.get(CourseGraph, course_id)
            concepts = session.exec(select(Concept).where(Concept.course_id == course_id)).all()
            edge_count = len(
                session.exec(
                    select(ConceptEdge).where(ConceptEdge.course_id == course_id)
                ).all()
            )
        status = record.status if record else "pending"
        note = record.error if record and record.error else ""
        anchored = len([c for c in concepts if c.material_id])
        print(
            f"[{i}/{len(courses)}] {name} -> {status} | 概念 {len(concepts)} 个（锚定 {anchored}）"
            f" / 关系 {edge_count} 条 | {time.time() - started:.0f}s"
            f"{(' | ' + note) if note else ''}",
            flush=True,
        )
    print(f"完成，用时 {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
