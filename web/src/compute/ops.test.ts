import { describe, expect, it } from 'vitest'

import { OP_GROUPS, opNeeds, toPreviewTex } from './ops'

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
