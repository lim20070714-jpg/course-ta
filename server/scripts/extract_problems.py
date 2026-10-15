"""批量把题目类材料结构化抽取为题库（在 server/ 目录下运行）。

用法：
    uv run python scripts/extract_problems.py                    # 自动匹配真题/试卷类材料
    uv run python scripts/extract_problems.py --material-id 45   # 指定单份材料
    uv run python scripts/extract_problems.py --all              # 全部材料（含课件/教材，慎用）
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, func, select

from app import db
from app.core import problems as core
from app.models import Material, Problem

_PAPER_HINTS = ("真题", "final", "middle", "考试版", "A中", "A末", "新A", "新B")


def _targets(use_all: bool, material_id: int | None) -> list[tuple[int, str]]:
    with Session(db.engine) as session:
        stmt = select(Material).where(Material.status == "ready").order_by(Material.id)
        if material_id:
            stmt = stmt.where(Material.id == material_id)
        rows = session.exec(stmt).all()
        if use_all or material_id:
            return [(m.id, m.filename) for m in rows]
        return [
            (m.id, m.filename)
            for m in rows
            if any(hint in m.filename for hint in _PAPER_HINTS)
        ]


async def main() -> None:
    parser = argparse.ArgumentParser(description="批量抽取题库")
    parser.add_argument("--material-id", type=int, help="只处理指定材料")
    parser.add_argument("--all", action="store_true", help="处理全部 ready 材料")
    args = parser.parse_args()

    targets = _targets(args.all, args.material_id)
    print(f"待抽取 {len(targets)} 份材料", flush=True)
    started = time.time()
    for i, (material_id, filename) in enumerate(targets, 1):
        await core.run_extraction(material_id)
        job = core.job_status(material_id)
        with Session(db.engine) as session:
            count = session.exec(
                select(func.count(Problem.id)).where(Problem.material_id == material_id)
            ).one()
        status = job.get("status")
        note = job.get("error", "")
        print(
            f"[{i}/{len(targets)}] {filename} -> {status} ({count} 题) "
            f"{time.time() - started:.0f}s{(' | ' + note) if note else ''}",
            flush=True,
        )
    print(f"完成，用时 {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
