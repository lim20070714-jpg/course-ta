"""SM-2 间隔重复调度（SuperMemo-2 算法）与考试冲刺压缩策略。

基础调度（未设置考试日期）：quality 0-5 自评，<3 视为遗忘（重置序列），>=3 递增间隔。

冲刺调度（已设置考试日期且距考试 <= 30 天）：
- 间隔被压缩到考试之前，并在考前留出至少两次复习机会；
- 到期队列改为按「考点热度 + 紧迫度」加权排序，允许提前推进尚未到期的卡片。
"""

from datetime import UTC, datetime, timedelta

MIN_EASE = 1.3
LEARN_DAYS = (1.0, 6.0)  # 第 1、2 次记住后的固定间隔

SPRINT_WINDOW_DAYS = 30  # 距考试 <= 30 天进入冲刺期
SPRINT_MIN_INTERVAL = 0.5  # 最小压缩间隔（天）：再短就没有复习意义
SPRINT_SCHEDULE = (1, 2, 4, 7, 11, 16, 22)  # 冲刺期展示用的参考节奏（天）
SPRINT_TARGET_RATIO = 0.8  # 复习点落在「现在 -> 考试」这段时间的 80% 处
SPRINT_DUE_BOOST = 0.5  # 已到期的紧迫度加成
SPRINT_LAPSE_BOOST = 0.4  # 多次遗忘的加成
SPRINT_LAPSE_THRESHOLD = 2
SPRINT_HOT_SHARE = 0.05  # 考点覆盖率 >= 5% 视为高频考点

# 考试日期只有「哪一天」，把它视为该自然日结束（UTC 轴上的 23:59:59）。
# 最坏情况时区为 UTC-12，东八区加 8 小时，32 小时足以覆盖所有时区的「当天」。
_EXAM_DAY_END = timedelta(hours=32)


def clamp_quality(quality: int) -> int:
    return max(0, min(5, int(quality)))


def next_ease(ease: float, quality: int) -> float:
    q = clamp_quality(quality)
    return max(MIN_EASE, ease + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)))


def _scheduled_interval(ease2: float, interval_days: float, reps2: int) -> float:
    """SM-2 原生的下一间隔（未压缩）。"""
    if reps2 <= len(LEARN_DAYS):
        return LEARN_DAYS[reps2 - 1]
    return float(max(1, round(interval_days * ease2)))


def exam_deadline(exam_date: datetime) -> datetime:
    """考试日期的截止时刻（视为该自然日结束）。"""
    return exam_date + _EXAM_DAY_END


def cap_interval(now: datetime, exam_at: datetime) -> float:
    """距考试只剩一段时间时，允许的最长间隔（天）。

    复习点被安排在「现在 -> 考试截止」这段剩余时间的 SPRINT_TARGET_RATIO 处，
    因此严格早于考试。正常冲刺期（剩余时间 >= 约 15 小时）下限为
    `SPRINT_MIN_INTERVAL`；剩余时间更少时下限自动让位，保证「落在考试之前」
    这个硬约束永远不会被破坏。
    """
    remaining = (exam_at - now).total_seconds() / 86400.0
    if remaining <= 0:
        return SPRINT_MIN_INTERVAL
    floor = min(SPRINT_MIN_INTERVAL, remaining * 0.5)
    return max(floor, remaining * SPRINT_TARGET_RATIO)


def sprint_interval_days(days_left: int | None) -> float | None:
    """冲刺期展示用的参考间隔（天）：最多用掉剩余天数的一半；非冲刺期返回 None。"""
    if days_left is None or days_left < 0 or days_left > SPRINT_WINDOW_DAYS:
        return None
    return max(SPRINT_MIN_INTERVAL, days_left / 2.0)


def apply_sm2(
    ease: float,
    interval_days: float,
    reps: int,
    lapses: int,
    quality: int,
    now: datetime,
    exam_at: datetime | None = None,
) -> tuple[float, float, int, int, datetime]:
    """返回 (ease, interval_days, reps, lapses, due_at)。

    `exam_at` 为考试截止时刻（None 表示未设置考试日期）：给出后间隔会被压缩，
    保证下次复习排在考试之前，但绝不拉长已有间隔；遗忘（q<3）也走同一条压缩路径。
    """
    q = clamp_quality(quality)
    ease2 = next_ease(ease, q)
    if q < 3:
        interval = LEARN_DAYS[0]
        reps2, lapses2 = 0, lapses + 1
    else:
        reps2 = reps + 1
        lapses2 = lapses
        interval = _scheduled_interval(ease2, interval_days, reps2)
    if exam_at is not None:
        interval = min(interval, cap_interval(now, exam_at))  # 压缩只降不升
    return ease2, interval, reps2, lapses2, now + timedelta(days=interval)


def days_until(exam_date: datetime | None, now: datetime) -> int | None:
    """距考试的自然日天数；未设置考试日期时返回 None。

    0 表示就是考试当天，负数表示考试已过。
    """
    if exam_date is None:
        return None
    return (exam_date.date() - now.date()).days


def is_sprint(days_left: int | None) -> bool:
    """是否处于冲刺期：已设置考试日期且距考试 0..30 天（含考试当天）。"""
    return days_left is not None and 0 <= days_left <= SPRINT_WINDOW_DAYS


def sprint_stage(days_left: int | None) -> str:
    """冲刺阶段名称，用于前端展示复习节奏。"""
    if days_left is None or days_left > SPRINT_WINDOW_DAYS or days_left < 0:
        return ""
    if days_left <= 1:
        return "临考突击"
    if days_left <= 4:
        return "考前收尾"
    if days_left <= 11:
        return "强化冲刺"
    return "基础巩固"


def interval_label(days: float) -> str:
    """把间隔天数写成中文可读文本（0.5 -> 半天）。"""
    if days < 1:
        return "半天"
    if days < 30:
        return f"{round(days)} 天"
    if days < 365:
        return f"{days / 30:.1f} 个月"
    return f"{days / 365:.1f} 年"


def sprint_message(days_left: int | None, recommended: int) -> str:
    """一句话说明当前冲刺安排。"""
    if days_left is None:
        return "未设置考试日期：按普通 SM-2 间隔复习。"
    if days_left < 0:
        return "考试日期已经过去：可以移除或更新考试日期。"
    if not is_sprint(days_left):
        return f"距考试还有 {days_left} 天，间隔仍然充裕，保持正常复习节奏即可。"
    if days_left == 0:
        return f"今天考试：{recommended} 张卡片排在冲刺队列最前，按权重过一遍高频考点。"
    cap = sprint_interval_days(days_left)
    cap = 1.0 if cap is None else cap
    return (
        f"距考试还有 {days_left} 天：进入「{sprint_stage(days_left)}」，"
        f"复习间隔已压缩到 {interval_label(cap)}以内，"
        f"优先处理 {recommended} 张高频考点卡片。"
    )


def parse_exam_date(value: str) -> datetime:
    """把 `YYYY-MM-DD` 解析为 UTC 零点的 datetime（仅日期语义）。"""
    parsed = datetime.strptime(value.strip(), "%Y-%m-%d")
    return datetime(parsed.year, parsed.month, parsed.day, tzinfo=UTC)


def card_weight(
    problem_knowledge: list[str],
    tag_counts: dict[str, int],
    due_at: datetime,
    lapses: int,
    now: datetime,
    total_problems: int | None = None,
    reps: int | None = None,
) -> tuple[float, list[str]]:
    """给复习卡片打分：考点在题库中出现得越多（越可能考）权重越高。

    组成：基础 1.0 + 共享考点的题目数 + 已到期加成 + 多次遗忘加成 + 新卡加成。
    `total_problems` / `reps` 可选：给出后可额外区分「高频考点」与「新卡未过」。
    """
    related = max((tag_counts.get(tag, 0) for tag in problem_knowledge), default=0)
    score = 1.0 + float(related)
    reasons: list[str] = []

    # 取覆盖率最高的考点作为展示理由（而不是遇到的第一个）
    hot = max(problem_knowledge, key=lambda t: tag_counts.get(t, 0), default="")
    if hot and total_problems:
        share = tag_counts.get(hot, 0) / total_problems
        if share >= SPRINT_HOT_SHARE:
            reasons.append(f"高频知识点：{hot}")
    if due_at <= now:
        score += SPRINT_DUE_BOOST
        reasons.append("已到期")
    if lapses >= SPRINT_LAPSE_THRESHOLD:
        score += SPRINT_LAPSE_BOOST
        reasons.append(f"已遗忘 {lapses} 次")
    if reps == 0:
        score += 1.0
        reasons.append("新卡未过")
    if not reasons:
        reasons.append("计划内复习")
    return round(score, 3), reasons
