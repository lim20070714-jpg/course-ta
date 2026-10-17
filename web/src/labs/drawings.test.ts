import { describe, expect, it } from 'vitest'
import type { LabDrawingSummary } from '../api'
import { checkName, drawingCounts, isBuildShape, normalizeName, updatedLabel } from './drawings'

const NOW = new Date(2026, 9, 17, 20)

/** 用本地钟表时间造 ISO，断言就不依赖测试机的时区。 */
const isoAt = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

const summary = (over: Partial<LabDrawingSummary> = {}): LabDrawingSummary => ({
  id: 1,
  name: 'RC 低通',
  lab_id: '__free',
  comp_count: 4,
  wire_count: 3,
  updated_at: isoAt(2026, 10, 17, 14, 5),
  ...over,
})

describe('normalizeName', () => {
  it('去空白并截到 60 字', () => {
    expect(normalizeName('  反相放大器 ')).toBe('反相放大器')
    expect(normalizeName('a'.repeat(80))).toHaveLength(60)
  })
})

describe('checkName', () => {
  it('空名字与非法字符给提示', () => {
    expect(checkName('   ', [])).toBe('先给图纸起个名字')
    expect(checkName('a/b', [])).toBe('')
    expect(checkName('图:纸', [])).toContain('< > : "')
  })

  it('同名冲突，但改回自己的名字不算', () => {
    expect(checkName('RC 低通', ['RC 低通', '分压器'])).toBe('已有同名图纸：RC 低通')
    expect(checkName('RC 低通 ', ['RC 低通'], 'RC 低通')).toBe('')
  })

  it('截断后同名也算冲突', () => {
    const long = 'x'.repeat(70)
    expect(checkName(long, ['x'.repeat(60)])).toContain('已有同名图纸')
  })
})

describe('isBuildShape', () => {
  it('接受两个对象数组', () => {
    expect(isBuildShape({ comps: [{ id: 'R1' }], wires: [] })).toBe(true)
    expect(isBuildShape({ comps: [], wires: [] })).toBe(true)
  })

  it('拒绝缺字段、非数组、数组里塞标量', () => {
    expect(isBuildShape(null)).toBe(false)
    expect(isBuildShape(' RC')).toBe(false)
    expect(isBuildShape({ comps: [] })).toBe(false)
    expect(isBuildShape({ comps: ['R1'], wires: [] })).toBe(false)
    expect(isBuildShape({ comps: [], wires: [1] })).toBe(false)
  })
})

describe('drawingCounts', () => {
  it('念出元件与连线数量', () => {
    expect(drawingCounts(summary({ comp_count: 6, wire_count: 9 }))).toBe('6 个元件 · 9 条连线')
  })
})

describe('updatedLabel', () => {
  it('今天与昨天带时间，更早只给日期', () => {
    expect(updatedLabel(isoAt(2026, 10, 17, 14, 5), NOW)).toBe('今天 14:05')
    expect(updatedLabel(isoAt(2026, 10, 16, 9, 12), NOW)).toBe('昨天 09:12')
    expect(updatedLabel(isoAt(2026, 10, 12), NOW)).toBe('10 月 12 日')
  })
})
