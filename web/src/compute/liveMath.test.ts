import { describe, expect, it } from 'vitest'

import { OP_GROUPS, opNeeds } from './ops'
import katex from 'katex'

import { clampOrder, liveFields, liveMath, liveNotes, liveSlots, slotTex, type LiveNode } from './liveMath'

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
    expect(d).toEqual({ k: 'tex', tex: '\\,d' })
    expect(variable).toMatchObject({ k: 'slot', field: 'variable' })
    if (integral.k !== 'scripts') throw new Error('积分首项应是带角标的 ∫')
    expect(integral.base).toEqual([{ k: 'tex', tex: '\\int' }])
    expect(integral.sub?.[0]).toMatchObject({ field: 'lower' })
    expect(integral.sup?.[0]).toMatchObject({ field: 'upper' })
  })

  it('求导把阶数写成 d 的上标，分子分母各一个槽，随时能升阶', () => {
    const fields = liveFields(liveMath('diff'))
    expect(fields).toContain('order')
    expect(fields).toContain('variable')
    const order = liveSlots(liveMath('diff')).find((s) => s.field === 'order')
    expect(order).toMatchObject({ numeric: true, hint: '1' })
    const head = liveMath('diff')[0]
    if (head.k !== 'frac') throw new Error('求导应渲染成分数线')
    // 分子 d^n 与分母 d[x]^n 用的是同一个 order 字段：改哪一处都写回同一个值
    expect(liveSlots(head.num).map((s) => s.field)).toEqual(['order'])
    expect(liveSlots(head.den).map((s) => s.field)).toEqual(['variable', 'order'])
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
    const labels = (op: string) =>
      liveSlots(liveMath(op))
        .map((s) => `${s.field}:${s.label}`)
        .sort()
    expect(labels('limit')).toEqual(['point:趋近值', 'variable:变量'])
    expect(labels('diff')).toEqual(['order:阶数', 'variable:变量'])
    expect(labels('inverse_laplace')).toEqual(['variable:变量'])
  })
})

describe('槽位的数学体显示', () => {
  it('空值的显示与后端默认值一致：变量是 x、点是 0、阶是 1', () => {
    expect(slotTex('variable', '')).toBe('x')
    expect(slotTex('point', '')).toBe('0')
    expect(slotTex('order', '')).toBe('1')
    expect(slotTex('variable', 't')).toBe('t')
    expect(slotTex('point', 'pi/2')).toBe('pi/2')
  })

  it('上下限空着不假装是无穷——空着就是不定积分', () => {
    expect(slotTex('lower', '')).toBe('')
    expect(slotTex('upper', '')).toBe('')
    expect(liveNotes(liveMath('integrate'), { variable: 'x', point: '0', lower: '', upper: '', order: '1' })).toEqual(
      ['上下限不填就是不定积分'],
    )
    expect(
      liveNotes(liveMath('integrate'), { variable: 'x', point: '0', lower: '0', upper: '1', order: '1' }),
    ).toEqual([])
    // 只填了一个也一样不按定积分算
    expect(liveNotes(liveMath('integrate'), { variable: 'x', point: '0', lower: '0', upper: '', order: '1' })).toEqual(
      ['上下限不填就是不定积分'],
    )
  })

  it('oo 认成无穷，中文按文本排版而不是让 KaTeX 报红', () => {
    expect(slotTex('upper', '+oo')).toBe('+\\infty')
    expect(slotTex('upper', '-OO')).toBe('-\\infty')
    expect(slotTex('variable', '角频率ω')).toBe('\\text{角频率ω}')
  })

  it('花括号会被摘掉，免得 \\text{} 提前闭合', () => {
    expect(slotTex('variable', '温度{t}')).toBe('\\text{温度t}')
  })
})

describe('模板里的每一段都能被 KaTeX 解析', () => {
  const texNodes = (nodes: LiveNode[]): string[] =>
    nodes.flatMap((n) =>
      n.k === 'tex'
        ? [n.tex]
        : n.k === 'scripts'
          ? [...texNodes(n.base), ...(n.sub ? texNodes(n.sub) : []), ...(n.sup ? texNodes(n.sup) : [])]
          : n.k === 'frac'
            ? [...texNodes(n.num), ...texNodes(n.den)]
            : [],
    )

  it('不允许出现 \\left( 与 \\right) 分家这种各自解析失败的碎片', () => {
    for (const op of ALL_OPS) {
      for (const tex of texNodes(liveMath(op))) {
        expect(() => katex.renderToString(tex, { throwOnError: true }), `${op}: ${tex}`).not.toThrow()
      }
    }
  })
})
