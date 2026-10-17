/**
 * 做题足迹的分组逻辑：后端给的是 UTC 时间戳（带 Z），
 * 分组按浏览器本地日期走——「今天做了 8 道」说的是用户今天，不是 UTC 的今天。
 */
import type { AttemptHistoryItem } from '../api'

export const VERDICT_KEYS = ['correct', 'partial', 'wrong', 'unknown'] as const

export type VerdictKey = (typeof VERDICT_KEYS)[number]

export const VERDICT_LABELS: Record<VerdictKey, string> = {
  correct: '做对',
  partial: '半对',
  wrong: '做错',
  unknown: '待批改',
}

/** 筛选条：空串表示「全部」，由调用方自己处理。 */
export const VERDICT_FILTERS: readonly ('' | VerdictKey)[] = ['', ...VERDICT_KEYS]

export interface TraceDay {
  key: string // 本地日期 YYYY-MM-DD
  label: string // 今天 / 昨天 / 10 月 15 日
  counts: Record<VerdictKey, number>
  items: AttemptHistoryItem[]
}

const isVerdict = (v: string): v is VerdictKey => (VERDICT_KEYS as readonly string[]).includes(v)

/** 后端判定值到中文标签；脏值原样显示，不崩。 */
export const verdictLabel = (v: string): string => (isVerdict(v) ? VERDICT_LABELS[v] : v)

const pad = (n: number) => String(n).padStart(2, '0')

export function localDayKey(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function localTimeLabel(iso: string): string {
  const d = new Date(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function dayLabel(key: string, now = new Date()): string {
  const today = localDayKey(now.toISOString())
  const yesterday = new Date(now.getTime() - 24 * 3600 * 1000)
  const yKey = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`
  const [year, month, day] = key.split('-')
  if (key === today) return '今天'
  if (key === yKey) return '昨天'
  const sameYear = year === String(now.getFullYear())
  return sameYear ? `${Number(month)} 月 ${Number(day)} 日` : `${year} 年 ${Number(month)} 月 ${Number(day)} 日`
}

/** 按本地日期分组，保持传入顺序（后端已按时间倒序）。 */
export function groupByDay(items: AttemptHistoryItem[], now = new Date()): TraceDay[] {
  const days: TraceDay[] = []
  const index = new Map<string, TraceDay>()
  for (const item of items) {
    const key = localDayKey(item.created_at)
    let day = index.get(key)
    if (!day) {
      day = {
        key,
        label: dayLabel(key, now),
        counts: { correct: 0, partial: 0, wrong: 0, unknown: 0 },
        items: [],
      }
      index.set(key, day)
      days.push(day)
    }
    if (isVerdict(item.verdict)) day.counts[item.verdict] += 1
    day.items.push(item)
  }
  return days
}

/** 「连续做题天数」：从今天（或昨天）往前数，中间断一天就停。 */
export function streakDays(days: TraceDay[], now = new Date()): number {
  if (days.length === 0) return 0
  const keys = new Set(days.map((d) => d.key))
  const cursor = new Date(now)
  if (!keys.has(localDayKey(cursor.toISOString()))) {
    cursor.setDate(cursor.getDate() - 1) // 今天还没做，从昨天往前数
    if (!keys.has(localDayKey(cursor.toISOString()))) return 0
  }
  let streak = 0
  while (keys.has(localDayKey(cursor.toISOString()))) {
    streak += 1
    cursor.setDate(cursor.getDate() - 1)
  }
  return streak
}
