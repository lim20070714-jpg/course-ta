import { describe, expect, it } from 'vitest'
import { CircuitError, solveTransient, sourceValue, type Circuit } from './index'

const RC_CHARGE: Circuit = {
  elements: [
    { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
    { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
    { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: 1e-6 },
  ],
}

describe('solveTransient 瞬态分析（后向欧拉）', () => {
  it('RC 充电：τ=1ms，τ 时刻电容电压约 3.16V', () => {
    const res = solveTransient(RC_CHARGE, { dt: 1e-6, duration: 5e-3 })
    expect(res.t[0]).toBe(0)
    expect(res.t).toHaveLength(5001)
    expect(res.t[1000]).toBeCloseTo(1e-3, 9)

    const vc = res.nodes['2']
    expect(vc[0]).toBe(0)
    expect(vc[1000]).toBeGreaterThan(3.15)
    expect(vc[1000]).toBeLessThan(3.17)
    // 5·(1-e^-1) ≈ 3.1606，即 τ 时刻充到 63.2%
    expect(Math.abs(vc[1000] - 5 * (1 - Math.exp(-1)))).toBeLessThan(0.01)
    // 5τ 后应接近稳态 5V
    expect(vc[5000]).toBeCloseTo(5 * (1 - Math.exp(-5)), 2)

    // 充电电流从节点 2 流入电容，初始约 5mA 后逐渐衰减
    const ic = res.currents['C1']
    expect(ic[1]).toBeGreaterThan(0.0049)
    expect(ic[1]).toBeLessThan(0.005)
    expect(Math.abs(ic[5000])).toBeLessThan(5e-5)
  })

  it('RC 放电：初始 5V 经 1kΩ 放电，τ 时刻约 1.84V', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'C', id: 'C1', a: '1', b: '0', capacitance: 1e-6, initialVoltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 1000 },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 5e-3 })
    const v = res.nodes['1']
    expect(v[0]).toBeCloseTo(5, 9)
    expect(v[1000]).toBeCloseTo(5 * Math.exp(-1), 2)
    expect(v[5000]).toBeLessThan(0.04)
  })

  it('RL 电流上升：τ=L/R=1ms，t=0 时电阻压降为 0、电感承压 5V', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'L', id: 'L1', a: '2', b: '0', inductance: 1 },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 5e-3 })
    // t=0+ 电感电流仍为 0 → 电阻电流为 0 → 中点电位等于电源电压
    expect(res.nodes['2'][0]).toBeCloseTo(5, 9)
    const iL = res.currents['L1']
    expect(iL[0]).toBe(0)
    expect(iL[1000]).toBeGreaterThan(0.00315)
    expect(iL[1000]).toBeLessThan(0.00317)
    expect(iL[5000]).toBeCloseTo(0.005, 3)
  })

  it('步数超限报 CircuitError', () => {
    expect(() => solveTransient(RC_CHARGE, { dt: 1e-9, duration: 1 })).toThrow(CircuitError)
  })

  it('非法 dt/duration 报 CircuitError', () => {
    expect(() => solveTransient(RC_CHARGE, { dt: 0, duration: 1e-3 })).toThrow(CircuitError)
    expect(() => solveTransient(RC_CHARGE, { dt: 1e-6, duration: -1 })).toThrow(CircuitError)
  })
})

describe('sourceValue 电源波形', () => {
  it('无波形时为恒定直流', () => {
    expect(sourceValue(5, undefined, 0.123)).toBe(5)
  })

  it('正弦：base + 幅值·sin(2πft)', () => {
    const wave = { shape: 'sin' as const, amplitude: 2, frequency: 1000 }
    expect(sourceValue(1, wave, 0)).toBeCloseTo(1, 12)
    expect(sourceValue(1, wave, 0.25e-3)).toBeCloseTo(3, 9) // T/4 峰值
    expect(sourceValue(1, wave, 0.75e-3)).toBeCloseTo(-1, 9) // 3T/4 谷值
    expect(sourceValue(1, wave, 1e-3)).toBeCloseTo(1, 6) // 整周期回到 base
  })

  it('方波：半周期在 ±幅值间跳变，t=0 起为正', () => {
    const wave = { shape: 'square' as const, amplitude: 2.5, frequency: 200 }
    expect(sourceValue(2.5, wave, 0)).toBe(5)
    expect(sourceValue(2.5, wave, 2.4e-3)).toBe(5)
    expect(sourceValue(2.5, wave, 2.6e-3)).toBe(0)
    expect(sourceValue(2.5, wave, 5.1e-3)).toBe(5)
  })
})

describe('solveTransient 含波形电源', () => {
  it('正弦电压源驱动电阻分压：各时刻与解析瞬时值一致', () => {
    const wave = { shape: 'sin' as const, amplitude: 2, frequency: 1000 }
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1, wave },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'R', id: 'R2', a: '2', b: '0', resistance: 1000 },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 1e-3 })
    for (const k of [0, 100, 250, 500, 750, 1000]) {
      expect(res.nodes['1'][k]).toBeCloseTo(sourceValue(1, wave, res.t[k]), 9)
      expect(res.nodes['2'][k]).toBeCloseTo(sourceValue(1, wave, res.t[k]) / 2, 9)
    }
  })

  it('RC 方波充放电：τ=1ms、半周期 2.5ms，电压在两电平间指数过渡', () => {
    const circuit: Circuit = {
      elements: [
        {
          kind: 'V',
          id: 'V1',
          a: '1',
          b: '0',
          voltage: 2.5,
          wave: { shape: 'square', amplitude: 2.5, frequency: 200 },
        },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: 1e-6 },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 5e-3 })
    const vc = res.nodes['2']
    expect(vc[0]).toBe(0)
    // 第一个半周期源为 5V，2.5τ 时刻充电至约 5(1-e^-2.5)=4.59V
    expect(vc[2500]).toBeGreaterThan(4.5)
    expect(vc[2500]).toBeLessThan(4.65)
    // 第二个半周期源为 0V，反向放电至约 4.59·e^-2.5=0.38V
    expect(vc[5000]).toBeGreaterThan(0.3)
    expect(vc[5000]).toBeLessThan(0.45)
  })

  it('非法波形参数报 CircuitError', () => {
    const bad = (wave: object): Circuit => ({
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 0, wave: wave as never },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 100 },
      ],
    })
    expect(() => solveTransient(bad({ shape: 'sin', amplitude: 0, frequency: 1 }), { dt: 1e-6, duration: 1e-3 })).toThrow(
      /幅值/,
    )
    expect(() =>
      solveTransient(bad({ shape: 'sin', amplitude: 1, frequency: 0 }), { dt: 1e-6, duration: 1e-3 }),
    ).toThrow(/频率/)
    expect(() =>
      solveTransient(bad({ shape: 'tri', amplitude: 1, frequency: 1 }), { dt: 1e-6, duration: 1e-3 }),
    ).toThrow(/波形类型/)
  })
})

describe('solveTransient 含理想运放的电路', () => {
  it('反相积分器：v_out(t) = -(v_in/RC)·t，线性下降', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 10000 },
        { kind: 'C', id: 'C1', a: '2', b: '3', capacitance: 1e-6 },
        { kind: 'OA', id: 'OA1', p: '0', n: '2', out: '3' },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 1e-3 })
    const vo = res.nodes['3']
    expect(vo[0]).toBeCloseTo(0, 9)
    // 1ms 时理论输出：-(1/(10k·1µ))·1ms = -0.1V（后向欧拉对斜坡输入无误差）
    expect(vo[1000]).toBeCloseTo(-0.1, 6)
    expect(vo[500]).toBeCloseTo(-0.05, 6)
  })

  it('RC 充电 + 电压跟随器：输出跟随电容电压', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: 1e-6 },
        { kind: 'OA', id: 'OA1', p: '2', n: '3', out: '3' },
      ],
    }
    const res = solveTransient(circuit, { dt: 1e-6, duration: 5e-3 })
    const vo = res.nodes['3']
    const vc = res.nodes['2']
    for (let k = 0; k <= 5000; k += 500) expect(vo[k]).toBeCloseTo(vc[k], 9)
    expect(vo[5000]).toBeCloseTo(5 * (1 - Math.exp(-5)), 2)
  })
})
