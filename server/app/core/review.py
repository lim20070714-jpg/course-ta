"""SM-2 间隔重复调度（SuperMemo-2 算法）。

质量分 quality：0-5 自评；<3 视为遗忘（重置序列），>=3 递增间隔。
"""

from datetime import datetime, timedelta

MIN_EASE = 1.3
LEARN_DAYS = (1.0, 6.0)  # 第 1、2 次记住后的固定间隔


def clamp_quality(quality: int) -> int:
    return max(0, min(5, int(quality)))


def next_ease(ease: float, quality: int) -> float:
    q = clamp_quality(quality)
    return max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))


def apply_sm2(
    ease: float,
    interval_days: float,
    reps: int,
    lapses: int,
    quality: int,
    now: datetime,
) -> tuple[float, float, int, int, datetime]:
    """返回 (ease, interval_days, reps, lapses, due_at)。"""
    q = clamp_quality(quality)
    ease2 = next_ease(ease, q)
    if q < 3:
        return ease2, LEARN_DAYS[0], 0, lapses + 1, now + timedelta(days=LEARN_DAYS[0])
    reps2 = reps + 1
    if reps2 <= len(LEARN_DAYS):
        interval = LEARN_DAYS[reps2 - 1]
    else:
        interval = float(max(1, round(interval_days * ease2)))
    return ease2, interval, reps2, lapses, now + timedelta(days=interval)
