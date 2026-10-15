"""CourseTA 评测脚本：让 AI 助教用课程材料回答测试题，按关键点命中率打分。

用法（在 server 目录下运行，保证依赖可用）：
    uv run python ../evals/run_eval.py --dry-run        # 只校验数据集格式
    uv run python ../evals/run_eval.py --course-id 1    # 真实评测（需要配置 .env 且材料已入库）
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "server"))

DATASET = Path(__file__).resolve().parent / "dataset" / "sample.jsonl"


def load_dataset(path: Path) -> list[dict]:
    items: list[dict] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        assert item.get("question") and item.get("keypoints"), f"第 {i} 行缺少 question/keypoints"
        items.append(item)
    return items


def match_keypoints(answer: str, keypoints: list[str]) -> tuple[int, int]:
    hit = sum(1 for k in keypoints if k in answer)
    return hit, len(keypoints)


async def run(course_id: int) -> None:
    from sqlmodel import Session

    from app import db
    from app.core import llm, rag

    db.init_db()
    items = load_dataset(DATASET)
    total_hit = total_all = 0
    with Session(db.engine) as session:
        for item in items:
            hits = await rag.retrieve(session, course_id, item["question"])
            messages = rag.build_messages(item["question"], hits, None)
            answer = await llm.complete(messages)
            hit, n = match_keypoints(answer, item["keypoints"])
            total_hit += hit
            total_all += n
            print(f"[{'PASS' if hit == n else 'FAIL'}] {item['question']}  ({hit}/{n})")
    if total_all:
        print(f"\n关键点总命中率: {total_hit}/{total_all} = {total_hit / total_all:.0%}")


def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")  # Windows 控制台中文输出
    parser = argparse.ArgumentParser(description="CourseTA 评测")
    parser.add_argument("--course-id", type=int, default=0, help="评测使用的课程 ID")
    parser.add_argument("--dry-run", action="store_true", help="只校验数据集格式，不调用模型")
    args = parser.parse_args()

    items = load_dataset(DATASET)
    print(f"数据集: {DATASET}（共 {len(items)} 题）")
    if args.dry_run:
        for item in items:
            print(f"  - {item['question']}")
        return
    if not args.course_id:
        parser.error("真实评测需要 --course-id（可先用 --dry-run 校验数据集格式）")
    asyncio.run(run(args.course_id))


if __name__ == "__main__":
    main()
