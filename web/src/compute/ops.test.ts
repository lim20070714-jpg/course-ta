import { describe, expect, it } from 'vitest'

import katex from 'katex'
import { OP_GROUPS, TEX_HINTS, asInputTex, opNeeds, toPreviewTex } from './ops'

describe('opNeeds', () => {
  it('积分需要变量与上下限', () => {
    const p = opNeeds('integrate')
    expect(p.variable).toBe(true)
    expect(p.bounds).toBe(true)
    expect(p.point).toBe(false)
  })

  it('极限需要变量与趋近点', () => {
    const p = opNeeds('limit')
    expect(p.point).toBe(true)
    expect(p.bounds).toBe(false)
  })

  it('求导需要变量与阶数', () => {
    const p = opNeeds('diff')
    expect(p.order).toBe(true)
    expect(p.point).toBe(false)
  })

  it('留数需要变量与奇点', () => {
    const p = opNeeds('residue')
    expect(p.variable).toBe(true)
    expect(p.point).toBe(true)
  })

  it('泰勒展开需要变量、展开点与阶数', () => {
    const p = opNeeds('taylor')
    expect(p.variable).toBe(true)
    expect(p.point).toBe(true)
    expect(p.order).toBe(true)
  })

  it('傅里叶变换需要变量，逆变换自动识别频率', () => {
    expect(opNeeds('fourier').variable).toBe(true)
    expect(opNeeds('inverse_fourier').variable).toBe(false)
  })

  it('偏导数需要变量与阶数', () => {
    const p = opNeeds('partial')
    expect(p.variable).toBe(true)
    expect(p.order).toBe(true)
  })

  it('矩阵操作被标记', () => {
    expect(opNeeds('det').matrix).toBe(true)
    expect(opNeeds('eigen').matrix).toBe(true)
    expect(opNeeds('simplify').matrix).toBe(false)
  })

  it('化简类不需要任何参数', () => {
    const p = opNeeds('simplify')
    expect(p).toEqual({ variable: false, point: false, bounds: false, order: false, matrix: false })
  })
})

describe('OP_GROUPS', () => {
  it('包含微积分、线性代数、变换与复数分组', () => {
    const labels = OP_GROUPS.map((g) => g.label)
    expect(labels).toContain('微积分')
    expect(labels).toContain('线性代数')
    expect(labels).toContain('变换')
    expect(labels).toContain('复数')
  })

  it('变换分组包含傅里叶变换', () => {
    const transform = OP_GROUPS.find((g) => g.label === '变换')
    const ids = transform?.ops.map((o) => o.id) ?? []
    expect(ids).toContain('fourier')
    expect(ids).toContain('inverse_fourier')
  })

  it('所有操作 id 唯一', () => {
    const ids = OP_GROUPS.flatMap((g) => g.ops.map((o) => o.id))
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('toPreviewTex', () => {
  it('包装为行内公式', () => {
    expect(toPreviewTex('x^2')).toBe('$x^2$')
  })
})

describe('asInputTex：结果导回输入框要读得通', () => {
  it('取 latex 源码而不是 sympy 的 ** 写法', () => {
    const latex = '\\frac{x^{5}}{120} - \\frac{x^{3}}{6}'
    expect(asInputTex({ latex, plain: 'x**5/120 - x**3/6' })).toBe(latex)
  })

  it('\\displaystyle 会被去掉（排版由预览决定，回填的是能再算一遍的源码）', () => {
    expect(asInputTex({ latex: '\\displaystyle\\int x\\,dx', plain: 'Integral(x, x)' })).toBe('\\int x\\,dx')
  })

  it('带中文注记的（特征值重数）回读不了，退回 plain 至少不骗人', () => {
    expect(asInputTex({ latex: '\\lambda_{1} = 2\\;(重数 1)', plain: 'λ_1 = 2 (×1)' })).toBe('λ_1 = 2 (×1)')
  })

  it('latex 为空时不会回填一个空表达式', () => {
    expect(asInputTex({ latex: '   ', plain: '0' })).toBe('0')
  })

  it('回填的 latex 后端能吃回去（含反斜杠即走 parse_latex）', () => {
    for (const latex of ['\\frac{1}{s + a}', 'e^{- x^{2}}', '\\sqrt{2}']) {
      expect(asInputTex({ latex, plain: 'whatever' })).toBe(latex)
    }
  })
})

describe('TEX_HINTS：可折叠提示框里每条都得是真能排版的 LaTeX', () => {
  it('每条示例都能被 KaTeX 解析（throwOnError）', () => {
    for (const h of TEX_HINTS) expect(() => katex.renderToString(h.tex, { throwOnError: true }), h.tex).not.toThrow()
  })

  it('每条都有说明，示例不重复', () => {
    expect(TEX_HINTS.length).toBeGreaterThan(8)
    for (const h of TEX_HINTS) expect(h.meaning.trim().length).toBeGreaterThan(0)
    const texes = TEX_HINTS.map((h) => h.tex)
    expect(new Set(texes).size).toBe(texes.length)
  })

  it('矩阵与纯文本两种写法都在提示里（用户最常用来自检）', () => {
    const texes = TEX_HINTS.map((h) => h.tex)
    expect(texes.some((t) => t.includes('\\begin{pmatrix}'))).toBe(true)
    expect(texes.some((t) => t.startsWith('[['))).toBe(true)
  })
})
