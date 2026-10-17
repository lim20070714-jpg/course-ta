import { describe, expect, it } from 'vitest'
import type { ComputeRun } from '../api'
import { argSummary, dedupeRuns, groupRuns, kindLabel, opLabel, runOutcome } from './history'

/** 用本地钟表时间造 ISO，断言就不依赖测试机的时区。 */
const isoAt = (year: number, month: number, day: number, hour = 12, minute = 0) =>
  new Date(year, month - 1, day, hour, minute).toISOString()

const run = (id: number, over: Partial<ComputeRun> = {}): ComputeRun => ({
  id,
  expr: `x^${id}`,
  op: 'diff',
  args: { var: 'x', order: 1 },
  result_latex: `${id}x`,
  result_plain: `${id}x`,
  approx: '',
  error: '',
  created_at: isoAt(2026, 10, 17, 10, id),
  ...over,
})

const NOW = new Date(2026, 9, 17, 20)

describe('opLabel', () => {
  it('已知运算给中文，未知原样', () => {
    expect(opLabel('laplace')).toBe('拉普拉斯变换')
    expect(opLabel('series')).toBe('series')
  })
})

describe('dedupeRuns', () => {
  it('折叠连点两次得到的相同操作', () => {
    const a = run(2, { expr: 'sin(x)', op: 'diff' })
    const b = run(1, { expr: 'sin(x)', op: 'diff' })
    expect(dedupeRuns([a, b]).map((r) => r.id)).toEqual([2])
  })

  it('参数不同就不算重复，哪怕表达式一样', () => {
    const a = run(2, { expr: 'sin(x)', args: { var: 'x' } })
    const b = run(1, { expr: 'sin(x)', args: { var: 't' } })
    expect(dedupeRuns([a, b]).map((r) => r.id)).toEqual([2, 1])
  })

  it('隔了一条又出现同样的操作要保留（不是相邻重复）', () => {
    const a = run(3, { expr: 'sin(x)' })
    const b = run(2, { expr: 'cos(x)' })
    const c = run(1, { expr: 'sin(x)' })
    expect(dedupeRuns([a, b, c]).map((r) => r.id)).toEqual([3, 2, 1])
  })

  it('符号声明不同视为不同操作', () => {
    const a = run(2, { args: { var: 'x', symbols: [{ name: 'a', kind: 'positive' }] } })
    const b = run(1, { args: { var: 'x', symbols: [{ name: 'a', kind: 'real' }] } })
    expect(dedupeRuns([a, b]).map((r) => r.id)).toEqual([2, 1])
  })

  it('空历史原样返回', () => {
    expect(dedupeRuns([])).toEqual([])
  })
})

describe('groupRuns', () => {
  it('按本地日期分块并倒序保留', () => {
    const days = groupRuns(
      [run(3), run(2, { created_at: isoAt(2026, 10, 17, 23, 5) }), run(1, { created_at: isoAt(2026, 10, 15) })],
      NOW,
    )
    expect(days.map((d) => d.label)).toEqual(['今天', '10 月 15 日'])
    expect(days[0].items.map((r) => r.id)).toEqual([3, 2])
  })

  it('空历史不分组', () => {
    expect(groupRuns([], NOW)).toEqual([])
  })
})

describe('argSummary', () => {
  it('只念这次运算真正用到的参数', () => {
    expect(argSummary(run(1, { op: 'diff', args: { var: 't', order: 2 } }))).toBe('对 t · 2 阶')
    expect(argSummary(run(1, { op: 'simplify', args: { var: 'x', order: 6 } }))).toBe('')
  })

  it('定积分给上下限，缺失用破折号', () => {
    expect(argSummary(run(1, { op: 'integrate', args: { var: 'x', lower: '0', upper: '+oo' } }))).toBe(
      '对 x · 0 ~ +oo',
    )
    expect(argSummary(run(1, { op: 'integrate', args: { var: 'x', upper: '1' } }))).toBe('对 x · — ~ 1')
  })

  it('极限给趋近点，符号带类型', () => {
    expect(
      argSummary(run(1, { op: 'limit', args: { var: 'x', point: '0', symbols: [{ name: 'a', kind: 'positive' }] } })),
    ).toBe('对 x · 在 0 · a 为正数')
  })
})

describe('runOutcome', () => {
  it('成功行显示结果与近似值', () => {
    expect(runOutcome(run(1, { result_plain: '2*x', approx: '0.693' }))).toEqual({
      text: '2*x ≈ 0.693',
      failed: false,
    })
  })

  it('失败行显示报错', () => {
    expect(runOutcome(run(1, { error: '表达式无法解析', result_plain: '' }))).toEqual({
      text: '表达式无法解析',
      failed: true,
    })
  })

  it('未知符号类型原样显示', () => {
    expect(kindLabel('weird')).toBe('weird')
  })
})
