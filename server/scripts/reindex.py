"""重新解析并索引已入库材料（解析器升级后使用）。

用法（在 server/ 目录下）：
    uv run python scripts/reindex.py                 # 全部材料
    uv run python scripts/reindex.py --material-id 4  # 单份材料
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, select

from app import db
from app.core.ingest import ingest_material
from app.models import Material


async def main() -> None:
    parser = argparse.ArgumentParser(description="重新解析并索引已入库材料")
    parser.add_argument("--material-id", type=int, help="只处理指定材料")
    args = parser.parse_args()

    with Session(db.engine) as session:
        stmt = select(Material).order_by(Material.id)
        if args.material_id:
            stmt = stmt.where(Material.id == args.material_id)
        targets = [(m.id, m.filename) for m in session.exec(stmt).all()]

    print(f"待重新索引 {len(targets)} 份材料", flush=True)
    started = time.time()
    for i, (material_id, filename) in enumerate(targets, 1):
        await ingest_material(material_id)
        with Session(db.engine) as session:
            m = session.get(Material, material_id)
            status = m.status if m else "missing"
            chunks = m.chunk_count if m else 0
        print(f"[{i}/{len(targets)}] {filename} -> {status} ({chunks} 块) {time.time() - started:.0f}s", flush=True)
    print(f"完成，用时 {time.time() - started:.0f}s", flush=True)


if __name__ == "__main__":
    asyncio.run(main())
