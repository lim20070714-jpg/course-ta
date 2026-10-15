import { describe, expect, it } from 'vitest'
import { CircuitError, solveDC, type Circuit } from './index'

describe('solveDC 直流工作点分析', () => {
  it('分压器：12V 经 1kΩ/2kΩ，输出应为 8V，电流 4mA', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 12 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'R', id: 'R2', a: '2', b: '0', resistance: 2000 },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['0']).toBe(0)
    expect(nodes['1']).toBeCloseTo(12, 9)
    expect(nodes['2']).toBeCloseTo(8, 9)
    expect(currents['R1']).toBeCloseTo(0.004, 9)
    expect(currents['R2']).toBeCloseTo(0.004, 9)
    // 沿 a→b 穿过电压源为负，表示电源对外供能
    expect(currents['V1']).toBeCloseTo(-0.004, 9)
  })

  it('电流源 1A 并联 1Ω：节点电压 1V', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'I', id: 'I1', a: '1', b: '0', current: 1 },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 1 },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['1']).toBeCloseTo(1, 9)
    expect(currents['R1']).toBeCloseTo(1, 9)
    expect(currents['I1']).toBeCloseTo(-1, 9)
  })

  it('直流稳态下电感视为短路', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 100 },
        { kind: 'L', id: 'L1', a: '2', b: '0', inductance: 0.001 },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['2']).toBeCloseTo(0, 9)
    expect(currents['R1']).toBeCloseTo(0.05, 9)
    expect(currents['L1']).toBeCloseTo(0.05, 9)
  })

  it('电容直流开路：输出节点经电阻被拉到电源电位，支路电流为 0', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: 1e-6 },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['2']).toBeCloseTo(5, 9)
    expect(currents['R1']).toBeCloseTo(0, 12)
    expect(currents['C1']).toBe(0)
  })

  it('仅经电容连接的节点在直流下悬空，报 CircuitError', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 1000 },
        { kind: 'C', id: 'C1', a: '1', b: '2', capacitance: 1e-6 },
      ],
    }
    expect(() => solveDC(circuit)).toThrow(CircuitError)
  })

  it('悬空节点（无地参考）报 CircuitError', () => {
    const circuit: Circuit = {
      elements: [{ kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 }],
    }
    expect(() => solveDC(circuit)).toThrow(CircuitError)
  })

  it('非法参数报 CircuitError', () => {
    const zeroR: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 5 },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 0 },
      ],
    }
    expect(() => solveDC(zeroR)).toThrow(CircuitError)

    const dupId: Circuit = {
      elements: [
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 100 },
        { kind: 'R', id: 'R1', a: '1', b: '0', resistance: 200 },
      ],
    }
    expect(() => solveDC(dupId)).toThrow(CircuitError)
  })
})

describe('solveDC 理想运放（nullor）', () => {
  it('反相放大器：v_out = -(Rf/R1)·v_in，虚地成立', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 2 },
        { kind: 'R', id: 'R1', a: '1', b: '2', resistance: 1000 },
        { kind: 'R', id: 'Rf', a: '2', b: '3', resistance: 10000 },
        { kind: 'OA', id: 'OA1', p: '0', n: '2', out: '3' },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['2']).toBeCloseTo(0, 9)
    expect(nodes['3']).toBeCloseTo(-20, 9)
    expect(currents['R1']).toBeCloseTo(0.002, 9)
    expect(currents['Rf']).toBeCloseTo(0.002, 9)
    // 输出端电流：流出运放为正，此处运放吸收 2mA
    expect(currents['OA1']).toBeCloseTo(-0.002, 9)
  })

  it('同相放大器：v_out = (1 + Rf/R1)·v_in，输出端向外供流', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
        { kind: 'OA', id: 'OA1', p: '1', n: '2', out: '3' },
        { kind: 'R', id: 'R1', a: '2', b: '0', resistance: 1000 },
        { kind: 'R', id: 'Rf', a: '2', b: '3', resistance: 9000 },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['2']).toBeCloseTo(1, 9)
    expect(nodes['3']).toBeCloseTo(10, 9)
    expect(currents['OA1']).toBeCloseTo(0.001, 9)
  })

  it('电压跟随器：输出等于输入，空载电流为 0', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 3 },
        { kind: 'OA', id: 'OA1', p: '1', n: '2', out: '2' },
      ],
    }
    const { nodes, currents } = solveDC(circuit)
    expect(nodes['2']).toBeCloseTo(3, 9)
    expect(currents['OA1']).toBeCloseTo(0, 12)
  })

  it('无反馈的悬空运放报 CircuitError', () => {
    const circuit: Circuit = {
      elements: [
        { kind: 'OA', id: 'OA1', p: '0', n: '0', out: '3' },
        { kind: 'R', id: 'R1', a: '3', b: '0', resistance: 1000 },
      ],
    }
    expect(() => solveDC(circuit)).toThrow(CircuitError)
  })
})
