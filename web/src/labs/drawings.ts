/**
 * 实验台图纸的前端规则：命名校验与画布内容识别。
 * 服务端只认 comps/wires 两个数组（见 server/app/api/labs.py），结构归这里，
 * 加一种元件不用改后端。
 */
import type { LabDrawingSummary } from '../api'
import { dayLabel, localDayKey, localTimeLabel } from '../components/traceGroups'
import type { Build } from './builder'

/** 自由搭建画板的归属 id：参数实验场不需要存图纸，只有画板用。 */
export const FREE_LAB_ID = '__free'

export const MAX_DRAWING_NAME = 60

export function normalizeName(raw: string): string {
  return raw.trim().slice(0, MAX_DRAWING_NAME)
}

/** 返回错误文案；空串表示可以保存。`self` 是这张图纸现在的名字，改名时不算冲突。 */
export function checkName(raw: string, taken: string[], self = ''): string {
  const name = normalizeName(raw)
  if (!name) return '先给图纸起个名字'
  if (/[<>:"|?*]/.test(name)) return '名字里不能有 < > : " | ? * 这些字符'
  if (name === self) return ''
  if (taken.some((x) => normalizeName(x) === name)) return `已有同名图纸：${name}`
  return ''
}

/** 服务端回来的 build 是 unknown，载入前确认形状，避免画布拿到坏数据直接崩。 */
export function isBuildShape(value: unknown): value is Build {
  if (typeof value !== 'object' || value === null) return false
  const b = value as Record<string, unknown>
  if (!Array.isArray(b.comps) || !Array.isArray(b.wires)) return false
  return (
    b.comps.every((c) => typeof c === 'object' && c !== null) &&
    b.wires.every((w) => typeof w === 'object' && w !== null)
  )
}

export function drawingCounts(d: LabDrawingSummary): string {
  return `${d.comp_count} 个元件 · ${d.wire_count} 条连线`
}

/** 「今天 14:05」「昨天 09:12」「10 月 15 日」——图纸列表只关心最近改过的是哪张。 */
export function updatedLabel(iso: string, now = new Date()): string {
  const label = dayLabel(localDayKey(iso), now)
  return label === '今天' || label === '昨天' ? `${label} ${localTimeLabel(iso)}` : label
}
