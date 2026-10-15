import { describe, expect, it } from 'vitest'
import {
  CircuitError,
  magnitude,
  phaseDeg,
  solveAC,
  sweep,
  type Circuit,
} from './index'

const RC_LOWPASS: Circuit = {
  elements: [
    { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
    { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
    { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: 1e-6 },
  ],
}

const FC = 1 / (2 * Math.PI * 1000 * 1e-6) // ≈ 159.1549 Hz

describe('solveAC 交流相量分析', () => {
  it('RC 低通：截止频率处 |H|=0.707，相位 -45°', () => {
    const { nodes } = solveAC(RC_LOWPASS, FC)
    expect(magnitude(nodes['2'])).toBeCloseTo(Math.SQRT1_2, 6)
    expect(phaseDeg(nodes['2'])).toBeCloseTo(-45, 6)
  })

  it('RC 低通：低频近乎无衰减，高频强衰减', () => {
    const lo = solveAC(RC_LOWPASS, 10)
    expect(magnitude(lo.nodes['2'])).toBeCloseTo(
      1 / Math.sqrt(1 + (10 / FC) ** 2),
      6,
    )
    const hi = solveAC(RC_LOWPASS, 100000)
    expect(magnitude(hi.nodes['2'])).toBeCloseTo(
      1 / Math.sqrt(1 + (100000 / FC) ** 2),
      6,
    )
  })

  it('RL 高通：L 两端在 ωL=R 处 |H|=0.707，相位 +45°', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'L', id: 'L1', a: '2', b: '0', inductance: 1 },
      ],
    }
    const f0 = 1000 / (2 * Math.PI) // ωL=R
    const { nodes } = solveAC(circuit, f0)
    expect(magnitude(nodes['2'])).toBeCloseTo(Math.SQRT1_2, 6)
    expect(phaseDeg(nodes['2'])).toBeCloseTo(45, 6)
  })

  it('带波形的电源在相量分析中按幅值激励（频率由扫频参数决定）', () => {
    const circuit: Circuit = {
      elements: [
        {
          kind: 'V',
          id: 'V1',
          a: '1',
          b: '0',
          voltage: 0,
          wave: { shape: 'sin', amplitude: 3, frequency: 500 },
        },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'R', id: 'R2', a: '2', b: '0', resistance: 2000 },
      ],
    }
    const { nodes } = solveAC(circuit, 1000)
    expect(magnitude(nodes['2'])).toBeCloseTo(2, 9) // 3 × 2/3
    expect(phaseDeg(nodes['2'])).toBeCloseTo(0, 9)
  })

  it('非法频率报 CircuitError', () => {
    expect(() => solveAC(RC_LOWPASS, 0)).toThrow(CircuitError)
    expect(() => solveAC(RC_LOWPASS, -10)).toThrow(CircuitError)
  })
})

describe('sweep 对数扫频', () => {
  it('RC 低通幅频：对数等间隔、首尾正确、单调下降', () => {
    const { f, nodes } = sweep(RC_LOWPASS, { fStart: 10, fStop: 100000, points: 61 })
    expect(f).toHaveLength(61)
    expect(f[0]).toBeCloseTo(10, 9)
    expect(f[60]).toBeCloseTo(100000, 3)
    // 对数等间隔：相邻比值恒定
    const ratio = f[1] / f[0]
    expect(f[10] / f[9]).toBeCloseTo(ratio, 9)

    const mags = nodes['2'].map(magnitude)
    for (let i = 1; i < mags.length; i++) {
      expect(mags[i]).toBeLessThan(mags[i - 1])
    }
  })

  it('非法扫频参数报 CircuitError', () => {
    expect(() => sweep(RC_LOWPASS, { fStart: 0, fStop: 100 })).toThrow(CircuitError)
    expect(() => sweep(RC_LOWPASS, { fStart: 100, fStop: 100 })).toThrow(CircuitError)
    expect(() => sweep(RC_LOWPASS, { fStart: 1, fStop: 100, points: 1 })).toThrow(CircuitError)
  })
})
