/**
 * 计算台历史的纯逻辑：后端每次运算（含失败的）都落一行，
 * 前端把连续重复的同一次操作折叠掉，再按本地日期分组展示。
 */
import type { ComputeRun } from '../api'
import { dayLabel, localDayKey } from '../components/traceGroups'
import { OP_GROUPS, opNeeds } from './ops'

/** 一次拉取的历史条数；后端保留 200 条，这里只取最近这一段。 */
export const HISTORY_LIMIT = 50

export interface HistoryDay {
  key: string
  label: string
  items: ComputeRun[]
}

const LABELS = new Map<string, string>()
for (const g of OP_GROUPS) for (const o of g.ops) LABELS.set(o.id, o.label)

/** 运算 id 到中文标签；未知 id 原样显示，不崩。 */
export function opLabel(op: string): string {
  return LABELS.get(op) ?? op
}

/** 同一次表达式的连续重复（连点两次「计算」）用同一个签名。 */
export function runSignature(run: ComputeRun): string {
  const a = run.args
  return [
    run.expr,
    run.op,
    a.var ?? '',
    a.point ?? '',
    a.lower ?? '',
    a.upper ?? '',
    a.order ?? '',
    (a.symbols ?? []).map((s) => `${s.name}:${s.kind}`).join(','),
  ].join('|')
}

/** 折叠相邻重复行，保留每组最后一次的结果。 */
export function dedupeRuns(items: ComputeRun[]): ComputeRun[] {
  const out: ComputeRun[] = []
  let prev = ''
  for (const run of items) {
    const sig = runSignature(run)
    if (sig === prev) continue
    prev = sig
    out.push(run)
  }
  return out
}

export function groupRuns(items: ComputeRun[], now = new Date()): HistoryDay[] {
  const days: HistoryDay[] = []
  const index = new Map<string, HistoryDay>()
  for (const run of items) {
    const key = localDayKey(run.created_at)
    let day = index.get(key)
    if (!day) {
      day = { key, label: dayLabel(key, now), items: [] }
      index.set(key, day)
      days.push(day)
    }
    day.items.push(run)
  }
  return days
}

/** 把这次运算用的参数念出来，如「对 t · 0 ~ ∞ · 符号 a>0」。 */
export function argSummary(run: ComputeRun): string {
  const needs = opNeeds(run.op)
  const a = run.args
  const parts: string[] = []
  if (needs.variable && a.var) parts.push(`对 ${a.var}`)
  if (needs.point && a.point) parts.push(`在 ${a.point}`)
  if (needs.bounds && (a.lower || a.upper)) parts.push(`${a.lower || '—'} ~ ${a.upper || '—'}`)
  if (needs.order && a.order) parts.push(`${a.order} 阶`)
  for (const s of a.symbols ?? []) parts.push(`${s.name} 为${kindLabel(s.kind)}`)
  return parts.join(' · ')
}

const KIND_LABELS: Record<string, string> = {
  real: '实数',
  positive: '正数',
  negative: '负数',
  integer: '整数',
  nonzero: '非零',
  complex: '复数',
}

export function kindLabel(kind: string): string {
  return KIND_LABELS[kind] ?? kind
}

/** 历史行右侧的结果摘要：失败显示报错，成功显示纯文本结果。 */
export function runOutcome(run: ComputeRun): { text: string; failed: boolean } {
  if (run.error) return { text: run.error, failed: true }
  const approx = run.approx ? ` ≈ ${run.approx}` : ''
  return { text: `${run.result_plain}${approx}`, failed: false }
}
