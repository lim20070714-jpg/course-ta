import { describe, expect, it } from 'vitest'
import {
  axisTicks,
  cursorRead,
  easeOutCubic,
  fmtTick,
  lerp,
  logTicks,
  nearestIndex,
  niceStep,
  plotDomain,
  pxAt,
  pyAt,
  resampleOnto,
  timeToHz,
  toCsv,
  trimNum,
} from './instruments'

describe('niceStep / fmtTick / trimNum', () => {
  it('取 1/2/5×10ⁿ 的“好看”步长', () => {
    expect(niceStep(1)).toBe(1)
    expect(niceStep(3)).toBe(2)
    expect(niceStep(7)).toBe(5)
    expect(niceStep(9)).toBe(10)
    expect(niceStep(0.7)).toBe(0.5)
    expect(niceStep(250)).toBe(200)
  })

  it('非法输入回退为 1，避免除零', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-3)).toBe(1)
    expect(niceStep(Number.NaN)).toBe(1)
    expect(niceStep(Infinity)).toBe(1)
  })

  it('刻度文字带工程前缀', () => {
    expect(fmtTick(0)).toBe('0')
    expect(fmtTick(1500)).toBe('1.5k')
    expect(fmtTick(-2000)).toBe('-2k')
    expect(fmtTick(1e-4)).toBe('100µ')
    expect(fmtTick(2.5e6)).toBe('2.5M')
    expect(fmtTick(1e-12)).toBe('1e-12')
    expect(fmtTick(Number.NaN)).toBe('—')
  })

  it('trimNum 保留三位有效数字', () => {
    expect(trimNum(1.23456)).toBe('1.23')
    expect(trimNum(1000)).toBe('1000')
    expect(trimNum(0.001234)).toBe('0.00123')
  })
})

describe('plotDomain', () => {
  it('线性轴留出 2% / 8% 余量', () => {
    const d = plotDomain([{ x: [0, 10], y: [0, 100] }], false)
    expect(d.xMin).toBeCloseTo(-0.2, 10)
    expect(d.xMax).toBeCloseTo(10.2, 10)
    expect(d.yMin).toBeCloseTo(-8, 10)
    expect(d.yMax).toBeCloseTo(108, 10)
  })

  it('xLog 在 log10 空间计算横轴', () => {
    const d = plotDomain([{ x: [1, 10], y: [0, 1] }], true)
    expect(d.xMin).toBeCloseTo(-0.02, 10)
    expect(d.xMax).toBeCloseTo(1.02, 10)
  })

  it('跳过非有限采样点', () => {
    const d = plotDomain([{ x: [0, 1, 2], y: [0, Number.NaN, 2] }], false)
    expect(d.yMin).toBeCloseTo(-0.16, 10)
    expect(d.yMax).toBeCloseTo(2.16, 10)
  })

  it('退化输入给出可用区间', () => {
    const single = plotDomain([{ x: [5], y: [3] }], false)
    expect(single.xMax).toBeGreaterThan(single.xMin)
    expect(single.yMin).toBeLessThan(3)
    expect(single.yMax).toBeGreaterThan(3)
    expect(plotDomain([], false)).toEqual({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 })
    expect(plotDomain([{ x: [], y: [] }], true)).toEqual({ xMin: 0, xMax: 1, yMin: 0, yMax: 1 })
  })
})

describe('pxAt / pyAt', () => {
  const dom = { xMin: 0, xMax: 10, yMin: 0, yMax: 100 }

  it('线性映射到像素', () => {
    expect(pxAt(0, dom, false, 0, 100)).toBe(0)
    expect(pxAt(5, dom, false, 0, 100)).toBe(50)
    expect(pxAt(10, dom, false, 0, 100)).toBe(100)
    expect(pyAt(0, dom, 0, 100)).toBe(100)
    expect(pyAt(50, dom, 0, 100)).toBe(50)
    expect(pyAt(100, dom, 0, 100)).toBe(0)
  })

  it('xLog 用对数坐标', () => {
    expect(pxAt(10, { ...dom, xMin: 0, xMax: 2 }, true, 0, 100)).toBe(50)
    expect(pxAt(1, { ...dom, xMin: 0, xMax: 2 }, true, 0, 100)).toBe(0)
  })

  it('零跨度不产生 NaN', () => {
    const flat = { xMin: 1, xMax: 1, yMin: 2, yMax: 2 }
    expect(Number.isFinite(pxAt(1, flat, false, 0, 100))).toBe(true)
    expect(Number.isFinite(pyAt(2, flat, 0, 100))).toBe(true)
  })
})

describe('axisTicks / logTicks', () => {
  it('线性刻度落在域内且步长整齐', () => {
    const ticks = axisTicks(0, 10, 5, 7)
    expect(ticks.map((t) => t.value)).toEqual([0, 2, 4, 6, 8, 10])
    expect(ticks[0].ratio).toBe(0)
    expect(ticks[ticks.length - 1].ratio).toBeCloseTo(1, 10)
  })

  it('超出上限时按间隔抽稀', () => {
    const ticks = axisTicks(0, 100, 5, 3)
    expect(ticks.length).toBeLessThanOrEqual(3)
    expect(ticks.map((t) => t.value)).toEqual([0, 40, 80])
  })

  it('负区间同样整齐', () => {
    const ticks = axisTicks(-5, 5, 5, 7)
    expect(ticks.length).toBeGreaterThan(2)
    for (const t of ticks) {
      expect(t.value).toBeGreaterThanOrEqual(-5)
      expect(t.value).toBeLessThanOrEqual(5)
      expect(t.ratio).toBeGreaterThanOrEqual(0)
      expect(t.ratio).toBeLessThanOrEqual(1)
    }
    expect(ticks.some((t) => t.value === 0)).toBe(true)
  })

  it('非法范围返回空', () => {
    expect(axisTicks(5, 5, 5, 7)).toEqual([])
    expect(axisTicks(0, 10, 5, 0)).toEqual([])
    expect(axisTicks(Number.NaN, 10, 5, 7)).toEqual([])
  })

  it('对数刻度取整数指数', () => {
    const ticks = logTicks(0, 3, 9)
    expect(ticks.map((t) => t.value)).toEqual([0, 1, 2, 3])
    expect(ticks[1].ratio).toBeCloseTo(1 / 3, 10)
    const dense = logTicks(0, 20, 5)
    expect(dense.map((t) => t.value)).toEqual([0, 5, 10, 15, 20])
    expect(logTicks(0, 20, 0)).toEqual([])
    expect(logTicks(3, 3, 5)).toEqual([])
  })
})

describe('lerp / easeOutCubic', () => {
  it('线性插值', () => {
    expect(lerp(0, 10, 0.5)).toBe(5)
    expect(lerp(-2, 2, 0.25)).toBe(-1)
    expect(lerp(4, 4, 0.7)).toBe(4)
  })

  it('缓动曲线端点与单调性', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(-1)).toBe(0)
    expect(easeOutCubic(2)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 10)
    expect(easeOutCubic(0.25)).toBeGreaterThan(0.25)
  })
})

describe('resampleOnto', () => {
  it('线性重采样到目标网格', () => {
    expect(resampleOnto([0, 1, 2], [0, 10, 20], [0, 0.5, 1.5, 2])).toEqual([0, 5, 15, 20])
  })

  it('越界点标记为 NaN（图表留空档）', () => {
    const out = resampleOnto([0, 1], [1, 2], [-1, 0.5, 3])
    expect(Number.isNaN(out[0])).toBe(true)
    expect(out[1]).toBe(1.5)
    expect(Number.isNaN(out[2])).toBe(true)
  })

  it('单点 / 空数据源', () => {
    const one = resampleOnto([1], [7], [1, 2])
    expect(one[0]).toBe(7)
    expect(Number.isNaN(one[1])).toBe(true)
    expect(resampleOnto([], [], [0, 1]).every((v) => Number.isNaN(v))).toBe(true)
  })

  it('源数据含 NaN：命中点保留，区间内给 NaN', () => {
    const ys = [0, Number.NaN, 2]
    expect(resampleOnto([0, 1, 2], ys, [0])[0]).toBe(0)
    expect(Number.isNaN(resampleOnto([0, 1, 2], ys, [0.5])[0])).toBe(true)
  })

  it('重复 x 不产生除零', () => {
    expect(resampleOnto([0, 0], [1, 2], [0])[0]).toBe(1)
  })
})

describe('nearestIndex', () => {
  it('就近定位（升序用二分）', () => {
    const xs = [0, 1, 2, 3]
    expect(nearestIndex(xs, 1.4)).toBe(1)
    expect(nearestIndex(xs, 2.6)).toBe(3)
    expect(nearestIndex(xs, -5)).toBe(0)
    expect(nearestIndex(xs, 99)).toBe(3)
    expect(nearestIndex(xs, 2)).toBe(2)
  })

  it('降序与退化输入', () => {
    expect(nearestIndex([3, 2, 1, 0], 2.1)).toBe(1)
    expect(nearestIndex([5], 100)).toBe(0)
    expect(nearestIndex([], 1)).toBe(-1)
  })
})

describe('cursorRead', () => {
  const xs = [0, 1, 2, 3]

  it('给出 Δx、1/Δx 与各曲线 Δy', () => {
    const read = cursorRead(xs, [{ label: 'V(C)', y: [0, 1, 4, 9] }], 0.1, 2.9)
    expect(read).not.toBeNull()
    expect(read?.xa).toBe(0)
    expect(read?.xb).toBe(3)
    expect(read?.dx).toBe(3)
    expect(read?.invDx).toBeCloseTo(1 / 3, 12)
    expect(read?.rows).toHaveLength(1)
    expect(read?.rows[0]).toMatchObject({ label: 'V(C)', y0: 0, y1: 9, dy: 9 })
  })

  it('游标重合时 1/Δx 为空但读数仍有效', () => {
    const read = cursorRead(xs, [{ label: 'V', y: [0, 1, 2, 3] }], 2, 2.1)
    expect(read?.dx).toBe(0)
    expect(read?.invDx).toBeNull()
    expect(read?.rows[0].dy).toBe(0)
  })

  it('数据不可用时返回 null', () => {
    expect(cursorRead([], [{ label: 'V', y: [] }], 0, 1)).toBeNull()
    expect(
      cursorRead(xs, [{ label: 'V', y: [Number.NaN, Number.NaN, Number.NaN, Number.NaN] }], 0, 3),
    ).toBeNull()
  })

  it('曲线只在游标命中点无值时跳过该曲线', () => {
    const read = cursorRead(
      xs,
      [
        { label: 'ok', y: [0, 1, 2, 3] },
        { label: 'bad', y: [Number.NaN, 1, 2, Number.NaN] },
      ],
      0,
      3,
    )
    expect(read?.rows.map((r) => r.label)).toEqual(['ok'])
    const interior = cursorRead(
      xs,
      [
        { label: 'ok', y: [0, 1, 2, 3] },
        { label: 'gap', y: [2, Number.NaN, Number.NaN, 5] },
      ],
      0,
      3,
    )
    // 中间断档不影响两端读数
    expect(interior?.rows.map((r) => r.label)).toEqual(['ok', 'gap'])
    expect(interior?.rows[1].dy).toBe(3)
  })
})

describe('toCsv', () => {
  it('以采样点最多的曲线为基准列，其余重采样对齐', () => {
    const csv = toCsv('t', [
      { label: 'v_C', x: [0, 1], y: [0, 1] },
      { label: 'v_R', x: [0, 1, 2], y: [10, 20, 30] },
    ])
    expect(csv.split('\n')).toEqual(['t,v_C,v_R', '0,0,10', '1,1,20', '2,,30'])
  })

  it('转义逗号与引号', () => {
    const csv = toCsv('t, s', [{ label: 'a"b', x: [0], y: [1] }])
    expect(csv).toBe('"t, s","a""b"\n0,1')
  })

  it('无数据返回空串', () => {
    expect(toCsv('t', [])).toBe('')
  })
})

describe('timeToHz', () => {
  it('时间跨度换成频率', () => {
    expect(timeToHz(0.00257, 's')).toBeCloseTo(389.105, 3)
    expect(timeToHz(2.57, 'ms')).toBeCloseTo(389.105, 3)
    expect(timeToHz(2570, 'µs')).toBeCloseTo(389.105, 3)
    expect(timeToHz(389, 'us')).toBeCloseTo(2570.694, 3)
    expect(timeToHz(1, 'ns')).toBe(1e9)
  })

  it('非时间单位 / 非法入参返回 null', () => {
    expect(timeToHz(10, 'Ω')).toBeNull()
    expect(timeToHz(10, 'Hz')).toBeNull()
    expect(timeToHz(10, '')).toBeNull()
    expect(timeToHz(0, 's')).toBeNull()
    expect(timeToHz(Number.NaN, 's')).toBeNull()
  })
})
