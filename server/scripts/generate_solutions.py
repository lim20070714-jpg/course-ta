"""批量为题库生成 AI 参考解答并落库（在 server/ 目录下运行）。

默认只处理「材料没有参考答案、也还没有 AI 详解」的题目；生成结果写入 Problem.solution，
之后打开题目、批改、模考都直接读库，不再重复调用模型。

用法：
    uv run python scripts/generate_solutions.py                 # 全部课程，补缺
    uv run python scripts/generate_solutions.py --course-id 1   # 指定课程
    uv run python scripts/generate_solutions.py --material-id 3 # 指定试卷
    uv run python scripts/generate_solutions.py --force         # 已有详解也重新生成
    uv run python scripts/generate_solutions.py --concurrency 4 --limit 20

单题超时由 SOLUTION_TIMEOUT_S 控制（默认 200s）。跑本地小模型时并发会摊薄每个
请求的速度，长题容易超时，此时把 SOLUTION_TIMEOUT_S 调到 900 并把并发降到 2：
    SOLUTION_TIMEOUT_S=900 uv run python scripts/generate_solutions.py --concurrency 2
"""

import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlmodel import Session, select

from app import config, db
from app.core import problems as core
from app.models import Problem


def _pick(args: argparse.Namespace) -> list[int]:
    with Session(db.engine) as session:
        stmt = select(Problem).order_by(Problem.id)  # type: ignore[arg-type]
        if args.course_id:
            stmt = stmt.where(Problem.course_id == args.course_id)
        if args.material_id:
            stmt = stmt.where(Problem.material_id == args.material_id)
        rows = session.exec(stmt).all()
    picked = [
        p.id or 0
        for p in rows
        if (args.force or not p.solution) and (args.include_answered or not p.answer)
    ]
    return picked[: args.limit] if args.limit else picked


async def _one(problem_id: int, sem: asyncio.Semaphore, attempts: int) -> tuple[int, str, int]:
    async with sem:
        last = ""
        for attempt in range(1, attempts + 1):
            with Session(db.engine) as session:
                problem = session.get(Problem, problem_id)
                if problem is None:
                    return problem_id, "missing", 0
                try:
                    text = await core.generate_solution(session, problem)
                except Exception as exc:  # noqa: BLE001  单题失败不中断整批
                    last = str(exc)[:160]
                    if attempt < attempts:
                        await asyncio.sleep(5 * attempt)
                        continue
                    return problem_id, f"failed: {last}", 0
                return problem_id, "ok" if text else "empty", len(text)
        return problem_id, f"failed: {last}", 0


async def main() -> None:
    parser = argparse.ArgumentParser(description="批量生成 AI 参考解答")
    parser.add_argument("--course-id", type=int, help="只处理指定课程")
    parser.add_argument("--material-id", type=int, help="只处理指定材料")
    parser.add_argument("--force", action="store_true", help="已有详解的题目也重新生成")
    parser.add_argument(
        "--include-answered", action="store_true", help="材料自带参考答案的题目也生成详解"
    )
    parser.add_argument("--concurrency", type=int, default=3, help="并发请求数（默认 3）")
    parser.add_argument("--retries", type=int, default=3, help="单题失败重试次数（默认 3）")
    parser.add_argument("--limit", type=int, help="最多处理多少题")
    args = parser.parse_args()

    db.init_db()
    ids = _pick(args)
    print(
        f"待生成 {len(ids)} 题，模型 {config.current().problem_model}，"
        f"单题超时 {config.settings.solution_timeout_s:.0f}s",
        flush=True,
    )
    if not ids:
        return

    sem = asyncio.Semaphore(max(1, args.concurrency))
    started = time.time()
    ok = chars = 0
    for done, coro in enumerate(
        asyncio.as_completed([_one(i, sem, max(1, args.retries)) for i in ids]), 1
    ):
        problem_id, status, length = await coro
        if status == "ok":
            ok += 1
            chars += length
        print(
            f"[{done}/{len(ids)}] #{problem_id} {status} "
            f"{length}字 {time.time() - started:.0f}s",
            flush=True,
        )
    print(
        f"完成：成功 {ok}/{len(ids)}，共 {chars} 字，用时 {time.time() - started:.0f}s",
        flush=True,
    )


if __name__ == "__main__":
    asyncio.run(main())
