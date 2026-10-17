import { describe, expect, it } from 'vitest'
import type { AttemptHistoryItem } from '../api'
import { dayLabel, groupByDay, localDayKey, streakDays } from './traceGroups'

/** 用本地钟表时间造 ISO，断言就不依赖测试机的时区。 */
const isoAt = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

const item = (id: number, verdict: string, created_at: string): AttemptHistoryItem => ({
  attempt_id: id,
  problem_id: id,
  material: '期末卷.pdf',
  page: 1,
  number: `第 ${id} 题`,
  excerpt: '求电压',
  knowledge: [],
  verdict,
  answer_text: '',
  feedback: '',
  created_at,
})

const NOW = new Date(2026, 9, 17, 20) // 本地 10 月 17 日晚

describe('groupByDay', () => {
  it('保持倒序并按本地日期分块，统计每块判定', () => {
    const days = groupByDay(
      [
        item(3, 'partial', isoAt(2026, 10, 17, 9)),
        item(2, 'correct', isoAt(2026, 10, 17, 23, 23)),
        item(1, 'wrong', isoAt(2026, 10, 15, 8)),
      ],
      NOW,
    )
    expect(days.map((d) => d.label)).toEqual(['今天', '10 月 15 日'])
    expect(days[0].items.map((i) => i.attempt_id)).toEqual([3, 2])
    expect(days[0].counts).toEqual({ correct: 1, partial: 1, wrong: 0, unknown: 0 })
    expect(days[1].counts.wrong).toBe(1)
  })

  it('晚上 23 点后做的题仍算今天，跨到 UTC 第二天也一样', () => {
    const late = item(1, 'correct', isoAt(2026, 10, 17, 23, 30))
    expect(localDayKey(late.created_at)).toBe('2026-10-17')
    expect(groupByDay([late], NOW)[0].label).toBe('今天')
  })

  it('空记录不分组', () => {
    expect(groupByDay([], NOW)).toEqual([])
  })

  it('忽略未知判定之外的脏值不报错', () => {
    const days = groupByDay([item(1, 'unanswered', isoAt(2026, 10, 17))], NOW)
    expect(days[0].counts).toEqual({ correct: 0, partial: 0, wrong: 0, unknown: 0 })
  })
})

describe('dayLabel', () => {
  it('区分今天、昨天与跨年', () => {
    expect(dayLabel('2026-10-17', NOW)).toBe('今天')
    expect(dayLabel('2026-10-16', NOW)).toBe('昨天')
    expect(dayLabel('2026-10-01', NOW)).toBe('10 月 1 日')
    expect(dayLabel('2025-12-31', NOW)).toBe('2025 年 12 月 31 日')
  })
})

describe('streakDays', () => {
  it('连续三天含今天', () => {
    const days = groupByDay(
      [
        item(3, 'correct', isoAt(2026, 10, 17)),
        item(2, 'correct', isoAt(2026, 10, 16)),
        item(1, 'correct', isoAt(2026, 10, 15)),
      ],
      NOW,
    )
    expect(streakDays(days, NOW)).toBe(3)
  })

  it('今天还没做则从昨天往前数', () => {
    const days = groupByDay([item(2, 'correct', isoAt(2026, 10, 16))], NOW)
    expect(streakDays(days, NOW)).toBe(1)
  })

  it('中间断了就只剩最近一段', () => {
    const days = groupByDay(
      [
        item(4, 'correct', isoAt(2026, 10, 17)),
        item(3, 'correct', isoAt(2026, 10, 16)),
        item(1, 'correct', isoAt(2026, 10, 14)),
      ],
      NOW,
    )
    expect(streakDays(days, NOW)).toBe(2)
  })

  it('没有记录是 0', () => {
    expect(streakDays([], NOW)).toBe(0)
  })
})
