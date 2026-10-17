import { describe, expect, it } from 'vitest'

import { OP_GROUPS, opNeeds } from './ops'
import { clampOrder, liveFields, liveMath, liveSlots } from './liveMath'

/** 界面上能选到的操作，加上只从历史里回来的两个 id（partial / series）。 */
const ALL_OPS = [...OP_GROUPS.flatMap((g) => g.ops.map((o) => o.id)), 'partial', 'series']

/** 预览里的槽位必须正好等于后端真正会收的入参。 */
function expectedFields(op: string): string[] {
  const needs = opNeeds(op)
  const fields: string[] = []
  if (needs.variable) fields.push('variable')
  if (needs.point) fields.push('point')
  if (needs.bounds) fields.push('lower', 'upper')
  if (needs.order) fields.push('order')
  return fields.sort()
}

const actualFields = (op: string) => [...liveFields(liveMath(op))].sort()

describe('liveMath 的槽位与 opNeeds 对齐', () => {
  it('每个操作的预览槽位都等于后端真正吃的参数', () => {
    for (const op of ALL_OPS) expect(actualFields(op), op).toEqual(expectedFields(op))
  })

  it('化简 / 矩阵 / 复数类只有表达式本体', () => {
    for (const op of ['simplify', 'expand', 'factor', 'trigsimp', 'det', 'eigen', 'conjugate', 'abs']) {
      expect(liveFields(liveMath(op))).toEqual([])
      expect(liveMath(op)).toEqual([{ k: 'expr' }])
    }
  })

  it('逆傅里叶不吃变量，所以不给变量槽', () => {
    expect(liveFields(liveMath('inverse_fourier'))).toEqual([])
    expect(liveFields(liveMath('laplace'))).toEqual(['variable'])
  })
})

describe('预览的排版结构', () => {
  it('定积分把上下限挂在 ∫ 的角标上，变量跟在 d 后面', () => {
    const [integral, expr, d, variable] = liveMath('integrate')
    expect(integral.k).toBe('scripts')
    expect(expr.k).toBe('expr')
    expect(d).toEqual({ k: 'tex', tex: 'd' })
    expect(variable).toMatchObject({ k: 'slot', field: 'variable' })
    if (integral.k !== 'scripts') throw new Error('积分首项应是带角标的 ∫')
    expect(integral.base).toEqual([{ k: 'tex', tex: '\\int' }])
    expect(integral.sub?.[0]).toMatchObject({ field: 'lower' })
    expect(integral.sup?.[0]).toMatchObject({ field: 'upper' })
  })

  it('求导一阶时也留着阶数槽，免得想升阶却没有入口', () => {
    const fields = liveFields(liveMath('diff'))
    expect(fields).toContain('order')
    expect(fields).toContain('variable')
    const order = liveMath('diff').find((n) => n.k === 'slot' && n.field === 'order')
    expect(order).toMatchObject({ numeric: true, hint: '1' })
  })

  it('极限把变量与趋近值排在 lim 下方，并各自有说法', () => {
    const head = liveMath('limit')[0]
    if (head.k !== 'scripts' || !head.sub) throw new Error('极限应渲染 lim 下条件')
    expect(head.base).toEqual([{ k: 'tex', tex: '\\lim' }])
    expect(head.sub.map((n) => (n.k === 'slot' ? n.field : n.k))).toEqual(['variable', 'tex', 'point'])
    const point = head.sub[2]
    expect(point.k === 'slot' && point.label).toBe('趋近值')
  })

  it('留数的 point 槽叫奇点，极限的叫趋近值，泰勒的叫展开点', () => {
    const pointLabel = (op: string) =>
      liveSlots(liveMath(op)).find((s) => s.field === 'point')?.label
    expect(pointLabel('residue')).toBe('奇点')
    expect(pointLabel('limit')).toBe('趋近值')
    expect(pointLabel('taylor')).toBe('展开点')
  })

  it('泰勒把表达式放在最前，参数说明跟在后面', () => {
    const nodes = liveMath('taylor')
    expect(nodes[0]).toEqual({ k: 'expr' })
    expect(nodes.filter((n) => n.k === 'text').map((n) => (n.k === 'text' ? n.t : ''))).toEqual([
      '在',
      '处展到',
      '阶',
    ])
  })
})

describe('数字槽与字段收集', () => {
  it('阶数只认数字并限幅 1..20', () => {
    expect(clampOrder('6')).toBe(6)
    expect(clampOrder('0')).toBe(1)
    expect(clampOrder('99')).toBe(20)
    expect(clampOrder('')).toBe(1)
    expect(clampOrder('x3')).toBe(3)
  })

  it('同一个字段只收集一次，嵌套结构也要走到', () => {
    const fields = liveFields(liveMath('integrate'))
    expect(fields).toEqual(['lower', 'upper', 'variable'])
  })

  it('槽位嵌在角标 / 分数线里也找得到', () => {
    const labels = (op: string) => liveSlots(liveMath(op)).map((s) => `${s.field}:${s.label}`)
    expect(labels('limit')).toEqual(['variable:变量', 'point:趋近值'])
    expect(labels('diff')).toEqual(['variable:变量', 'order:阶数'])
    expect(labels('inverse_laplace')).toEqual(['variable:变量'])
  })
})
