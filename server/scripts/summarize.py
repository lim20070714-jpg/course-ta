"""批量为已入库材料生成总结与知识点（在 server/ 目录下运行）。

用法：
    uv run python scripts/summarize.py                # 全部 ready 材料
    uv run python scripts/summarize.py --material-id 4  # 指定材料
    uv run python scripts/summarize.py --missing-only   # 只补没有总结的
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, select

from app import db
from app.core import summary
from app.models import Material, Summary


async def main() -> None:
    parser = argparse.ArgumentParser(description="批量生成材料总结")
    parser.add_argument("--material-id", type=int, help="只处理指定材料")
    parser.add_argument("--missing-only", action="store_true", help="只处理没有总结的材料")
    args = parser.parse_args()

    with Session(db.engine) as session:
        stmt = (
            select(Material)
            .where(Material.status == "ready")
            .order_by(Material.id)
        )
        if args.material_id:
            stmt = stmt.where(Material.id == args.material_id)
        materials = [(m.id, m.filename) for m in session.exec(stmt).all()]
        if args.missing_only:
            existing = {s.material_id for s in session.exec(select(Summary)).all()}
            materials = [(i, f) for i, f in materials if i not in existing]

    print(f"待总结 {len(materials)} 份材料", flush=True)
    started = time.time()
    for i, (material_id, filename) in enumerate(materials, 1):
        await summary.generate_summary(material_id)
        job = summary.job_status(material_id)
        status = job["status"]
        note = job.get("error", "")
        print(
            f"[{i}/{len(materials)}] {filename} -> {status} "
            f"{time.time() - started:.0f}s{(' | ' + note) if note else ''}",
            flush=True,
        )
    print(f"完成，用时 {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
