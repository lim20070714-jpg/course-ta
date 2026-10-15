import { describe, expect, it } from 'vitest'
import { CircuitError, solveDC, solveTransient } from '../circuit'
import {
  canPlace,
  buildCircuit,
  COLS,
  dcValueOf,
  formatCompValue,
  nextId,
  parseSi,
  ptKey,
  ROWS,
  rotateComp,
  routeWire,
  sampleBuild,
  squareRcBuild,
  terminalsOf,
  waveOf,
  type BComp,
} from './builder'

describe('parseSi 参数文本解析', () => {
  it('识别国际单位制前后缀', () => {
    expect(parseSi('4.7k')).toBe(4700)
    expect(parseSi('10µ')).toBeCloseTo(1e-5, 12)
    expect(parseSi('10u')).toBeCloseTo(1e-5, 12)
    expect(parseSi('1e-6')).toBeCloseTo(1e-6, 15)
    expect(parseSi('5')).toBe(5)
    expect(parseSi('1m')).toBeCloseTo(1e-3, 12)
    expect(parseSi('2.2M')).toBeCloseTo(2.2e6, 6)
    expect(parseSi('-2')).toBe(-2)
  })

  it('容忍带单位与空格的输入', () => {
    expect(parseSi('1kΩ')).toBe(1000)
    expect(parseSi('4.7 V')).toBe(4.7)
    expect(parseSi('3.3 k')).toBe(3300)
  })

  it('非法输入返回 null', () => {
    expect(parseSi('abc')).toBeNull()
    expect(parseSi('')).toBeNull()
    expect(parseSi('1kk')).toBeNull()
  })
})

describe('nextId 编号分配', () => {
  it('按同前缀最大编号加一', () => {
    const comps: BComp[] = [
      { id: 'R1', kind: 'R', x: 0, y: 0, orient: 'h', value: 1 },
      { id: 'R3', kind: 'R', x: 0, y: 2, orient: 'h', value: 1 },
      { id: 'V1', kind: 'V', x: 0, y: 4, orient: 'h', value: 1 },
    ]
    expect(nextId('R', comps)).toBe('R4')
    expect(nextId('C', comps)).toBe('C1')
    expect(nextId('OA', comps)).toBe('OA1')
  })
})

describe('放置与旋转', () => {
  it('rotateComp 交换方向并保持起点端子不动', () => {
    const r: BComp = { id: 'R1', kind: 'R', x: 3, y: 3, orient: 'h', value: 1000 }
    const rot = rotateComp(r, [r])
    expect(rot?.orient).toBe('v')
    expect(terminalsOf(rot!).map((t) => ptKey(t.pt))).toEqual(['3,3', '3,5'])
  })

  it('旋转后越界或与其它元件重叠时返回 null', () => {
    const edge: BComp = { id: 'R1', kind: 'R', x: COLS - 2, y: ROWS - 2, orient: 'h', value: 1000 }
    expect(canPlace(edge, [edge])).toBe(false)
    expect(rotateComp(edge, [edge])).toBeNull()

    const a: BComp = { id: 'R1', kind: 'R', x: 5, y: 1, orient: 'v', value: 1000 }
    const b: BComp = { id: 'R2', kind: 'R', x: 5, y: 0, orient: 'h', value: 1000 }
    expect(rotateComp(b, [a, b])).toBeNull()
    expect(canPlace({ ...b, orient: 'v' }, [b])).toBe(true)
    expect(COLS).toBeGreaterThan(0)
  })
})

describe('routeWire 正交走线', () => {
  it('共线直线，否则按主方向折一次', () => {
    expect(routeWire({ x: 0, y: 0 }, { x: 4, y: 0 })).toEqual([
      { x: 0, y: 0 },
      { x: 4, y: 0 },
    ])
    expect(routeWire({ x: 2, y: 4 }, { x: 5, y: 9 })).toEqual([
      { x: 2, y: 4 },
      { x: 2, y: 9 },
      { x: 5, y: 9 },
    ])
    expect(routeWire({ x: 0, y: 0 }, { x: 6, y: 2 })).toEqual([
      { x: 0, y: 0 },
      { x: 6, y: 0 },
      { x: 6, y: 2 },
    ])
  })
})

describe('buildCircuit 网表提取', () => {
  it('示例分压器：节点命名、结点圆点与直流结果正确', () => {
    const res = buildCircuit(sampleBuild())
    const net = (k: string) => res.netOfTerminal.get(k)
    expect(net('V1:0')).toBe('0')
    expect(net('GND1:0')).toBe('0')
    expect(net('R2:1')).toBe('0')
    expect(net('V1:1')).toBe('v1')
    expect(net('R1:0')).toBe('v1')
    expect(net('R1:1')).toBe('v2')
    expect(net('R2:0')).toBe('v2')

    // GND 接地点落在导线拐角上（3 路交汇）→ 画结点圆点
    expect(res.junctions.has('2,9')).toBe(true)
    expect(res.junctions.size).toBe(1)

    expect(res.circuit.elements).toHaveLength(3)
    const { nodes, currents } = solveDC(res.circuit)
    expect(nodes['v1']).toBeCloseTo(12, 9)
    expect(nodes['v2']).toBeCloseTo(8, 9)
    expect(currents['R1']).toBeCloseTo(4e-3, 9)
  })

  it('端子落在导线中部形成 T 型结点', () => {
    const res = buildCircuit({
      comps: [
        { id: 'R1', kind: 'R', x: 2, y: 0, orient: 'v', value: 1000 },
        { id: 'R2', kind: 'R', x: 4, y: 0, orient: 'h', value: 1000 },
        { id: 'GND1', kind: 'GND', x: 2, y: 4, orient: 'v', value: 0 },
        { id: 'GND2', kind: 'GND', x: 6, y: 4, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
        { id: 'W2', pts: [{ x: 2, y: 2 }, { x: 2, y: 4 }] },
        { id: 'W3', pts: [{ x: 6, y: 0 }, { x: 6, y: 4 }] },
      ],
    })
    expect(res.netOfTerminal.get('R1:0')).toBe('v1')
    expect(res.netOfTerminal.get('R2:0')).toBe('v1')
    expect(res.netOfTerminal.get('R1:1')).toBe('0')
    expect(res.netOfTerminal.get('R2:1')).toBe('0')
    // R1 上端子（2,0）落在 W1 中部：端子 + 贯穿的两段 = 3 路交汇
    expect(res.junctions.has('2,0')).toBe(true)
    // W1 端点 (4,0) 对接 R2 端子只是 2 路相接，不画圆点
    expect(res.junctions.has('4,0')).toBe(false)
    expect(res.netNameAtPoint.get('2,0')).toBe('v1')
  })

  it('两条导线在无端点处交叉不连通、也不画圆点', () => {
    const res = buildCircuit({
      comps: [
        { id: 'R1', kind: 'R', x: 0, y: 5, orient: 'v', value: 1000 },
        { id: 'R3', kind: 'R', x: 4, y: 5, orient: 'v', value: 1000 },
        { id: 'R2', kind: 'R', x: 2, y: 3, orient: 'h', value: 1000 },
        { id: 'R4', kind: 'R', x: 2, y: 7, orient: 'v', value: 1000 },
        { id: 'GND1', kind: 'GND', x: 0, y: 7, orient: 'v', value: 0 },
        { id: 'GND2', kind: 'GND', x: 4, y: 7, orient: 'v', value: 0 },
        { id: 'GND3', kind: 'GND', x: 2, y: 9, orient: 'v', value: 0 },
        { id: 'GND4', kind: 'GND', x: 6, y: 9, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 0, y: 5 }, { x: 4, y: 5 }] },
        { id: 'W2', pts: [{ x: 2, y: 3 }, { x: 2, y: 7 }] },
        { id: 'W4', pts: [{ x: 4, y: 3 }, { x: 6, y: 3 }, { x: 6, y: 9 }] },
      ],
    })
    const a = res.netOfTerminal.get('R1:0')
    const b = res.netOfTerminal.get('R2:0')
    expect(a).toBe(res.netOfTerminal.get('R3:0'))
    expect(b).toBe(res.netOfTerminal.get('R4:0'))
    expect(a).not.toBe(b)
    // (2,5) 是 W1 与 W2 的交叉点：不连通、无端子也无顶点 → 不画圆点
    expect(res.junctions.has('2,5')).toBe(false)
    expect(res.junctions.size).toBe(0)
  })

  it('多个接地符号合并为同一节点 "0"', () => {
    const res = buildCircuit({
      comps: [
        { id: 'V1', kind: 'V', x: 2, y: 2, orient: 'h', value: 5 },
        { id: 'R1', kind: 'R', x: 5, y: 2, orient: 'v', value: 1000 },
        { id: 'GND1', kind: 'GND', x: 2, y: 5, orient: 'v', value: 0 },
        { id: 'GND2', kind: 'GND', x: 7, y: 5, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 2, y: 2 }, { x: 2, y: 5 }] },
        { id: 'W2', pts: [{ x: 4, y: 2 }, { x: 5, y: 2 }] },
        { id: 'W3', pts: [{ x: 5, y: 4 }, { x: 7, y: 4 }, { x: 7, y: 5 }] },
      ],
    })
    expect(res.netOfTerminal.get('V1:0')).toBe('0')
    expect(res.netOfTerminal.get('R1:1')).toBe('0')
    expect(res.netOfTerminal.get('GND1:0')).toBe('0')
    expect(res.netOfTerminal.get('GND2:0')).toBe('0')

    const { nodes, currents } = solveDC(res.circuit)
    expect(nodes['v1']).toBeCloseTo(5, 9)
    expect(currents['R1']).toBeCloseTo(5e-3, 9)
    expect(currents['V1']).toBeCloseTo(-5e-3, 9)
  })

  it('理想运放电压跟随器：p/n/out 端子各归其位', () => {
    const res = buildCircuit({
      comps: [
        { id: 'V1', kind: 'V', x: 1, y: 4, orient: 'h', value: 3 },
        { id: 'OA1', kind: 'OA', x: 5, y: 5, orient: 'h', value: 0 },
        { id: 'GND1', kind: 'GND', x: 1, y: 7, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 3, y: 4 }, { x: 5, y: 4 }] },
        { id: 'W2', pts: [{ x: 8, y: 5 }, { x: 8, y: 6 }, { x: 5, y: 6 }] },
        { id: 'W3', pts: [{ x: 1, y: 4 }, { x: 1, y: 7 }] },
      ],
    })
    expect(res.netOfTerminal.get('V1:1')).toBe('v1')
    expect(res.netOfTerminal.get('OA1:p')).toBe('v1')
    expect(res.netOfTerminal.get('OA1:n')).toBe('v2')
    expect(res.netOfTerminal.get('OA1:out')).toBe('v2')
    expect(res.netOfTerminal.get('V1:0')).toBe('0')

    const { nodes, currents } = solveDC(res.circuit)
    expect(nodes['v1']).toBeCloseTo(3, 9)
    expect(nodes['v2']).toBeCloseTo(3, 9)
    expect(currents['OA1']).toBeCloseTo(0, 12)
  })

  it('电容器与电感器携带瞬态初始条件', () => {
    const res = buildCircuit({
      comps: [
        { id: 'C1', kind: 'C', x: 0, y: 0, orient: 'v', value: 1e-6, init: 5 },
        { id: 'L1', kind: 'L', x: 4, y: 0, orient: 'h', value: 0.1, init: 0.2 },
        { id: 'GND1', kind: 'GND', x: 0, y: 2, orient: 'v', value: 0 },
        { id: 'GND2', kind: 'GND', x: 6, y: 4, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 0, y: 0 }, { x: 4, y: 0 }] },
        { id: 'W2', pts: [{ x: 6, y: 0 }, { x: 6, y: 4 }] },
      ],
    })
    const cap = res.circuit.elements.find((el) => el.id === 'C1')
    const ind = res.circuit.elements.find((el) => el.id === 'L1')
    expect(cap?.kind === 'C' && cap.initialVoltage).toBe(5)
    expect(ind?.kind === 'L' && ind.initialCurrent).toBeCloseTo(0.2, 12)
  })

  it('悬空端子报错并指出端子名', () => {
    expect(() =>
      buildCircuit({
        comps: [
          { id: 'R1', kind: 'R', x: 2, y: 0, orient: 'v', value: 1000 },
          { id: 'GND1', kind: 'GND', x: 5, y: 0, orient: 'v', value: 0 },
        ],
        wires: [],
      }),
    ).toThrow(/悬空端子/)
  })

  it('缺少接地或画布为空时报错', () => {
    expect(() =>
      buildCircuit({
        comps: [{ id: 'R1', kind: 'R', x: 2, y: 0, orient: 'v', value: 1000 }],
        wires: [],
      }),
    ).toThrow(/接地/)
    expect(() => buildCircuit({ comps: [], wires: [] })).toThrow(CircuitError)
    expect(() => buildCircuit({ comps: [], wires: [] })).toThrow(/没有元件/)
  })
})

describe('波形电源映射', () => {
  it('buildCircuit 把波形源映射为偏置 + 波形定义（缺省频率 1kHz）', () => {
    const vRes = buildCircuit({
      comps: [
        { id: 'V1', kind: 'V', x: 2, y: 2, orient: 'h', value: 2.5, wave: 'sin', offset: 2.5 },
        { id: 'R1', kind: 'R', x: 6, y: 2, orient: 'h', value: 1000 },
        { id: 'GND1', kind: 'GND', x: 2, y: 5, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 4, y: 2 }, { x: 6, y: 2 }] },
        { id: 'W2', pts: [{ x: 2, y: 2 }, { x: 2, y: 5 }] },
        { id: 'W3', pts: [{ x: 8, y: 2 }, { x: 8, y: 5 }, { x: 2, y: 5 }] },
      ],
    })
    const v = vRes.circuit.elements.find((el) => el.id === 'V1')
    expect(v?.kind === 'V' && v.voltage).toBe(2.5)
    expect(v?.kind === 'V' && v.wave).toEqual({ shape: 'sin', amplitude: 2.5, frequency: 1000 })

    const iRes = buildCircuit({
      comps: [
        { id: 'I1', kind: 'I', x: 2, y: 2, orient: 'h', value: 1e-3, wave: 'square', freq: 200, offset: -1 },
        { id: 'R1', kind: 'R', x: 6, y: 2, orient: 'h', value: 1000 },
        { id: 'GND1', kind: 'GND', x: 2, y: 5, orient: 'v', value: 0 },
      ],
      wires: [
        { id: 'W1', pts: [{ x: 4, y: 2 }, { x: 6, y: 2 }] },
        { id: 'W2', pts: [{ x: 2, y: 2 }, { x: 2, y: 5 }] },
        { id: 'W3', pts: [{ x: 8, y: 2 }, { x: 8, y: 5 }, { x: 2, y: 5 }] },
      ],
    })
    const i = iRes.circuit.elements.find((el) => el.id === 'I1')
    expect(i?.kind === 'I' && i.current).toBe(-1)
    expect(i?.kind === 'I' && i.wave).toEqual({ shape: 'square', amplitude: 1e-3, frequency: 200 })
  })

  it('dcValueOf / waveOf：无波形时取恒值本身', () => {
    const plain: BComp = { id: 'V1', kind: 'V', x: 0, y: 0, orient: 'h', value: 5 }
    expect(dcValueOf(plain)).toBe(5)
    expect(waveOf(plain)).toBeUndefined()
    const waved: BComp = { ...plain, wave: 'square', freq: 50, value: 3, offset: 4 }
    expect(dcValueOf(waved)).toBe(4)
    expect(waveOf(waved)).toEqual({ shape: 'square', amplitude: 3, frequency: 50 })
  })

  it('RC 方波示例：网表连通正确，瞬态输出为充放电波形', () => {
    const res = buildCircuit(squareRcBuild())
    const net = (k: string) => res.netOfTerminal.get(k)
    expect(net('V1:0')).toBe('0')
    expect(net('C1:1')).toBe('0')
    expect(net('GND1:0')).toBe('0')
    expect(net('V1:1')).toBe(net('R1:0'))
    expect(net('R1:1')).toBe(net('C1:0'))
    expect(res.junctions.has('5,10')).toBe(true)

    const tr = solveTransient(res.circuit, { dt: 1e-6, duration: 5e-3 })
    const vc = tr.nodes[net('C1:0')!]
    expect(vc[0]).toBe(0)
    expect(vc[2500]).toBeGreaterThan(4.5)
    expect(vc[2500]).toBeLessThan(4.65)
    expect(vc[5000]).toBeGreaterThan(0.3)
    expect(vc[5000]).toBeLessThan(0.45)

    const dc = solveDC(res.circuit)
    expect(dc.nodes[net('C1:0')!]).toBeCloseTo(2.5, 9)
  })
})

describe('formatCompValue 显示文本', () => {
  it('按元件类型追加单位', () => {
    expect(formatCompValue({ id: 'R1', kind: 'R', x: 0, y: 0, orient: 'h', value: 1000 })).toBe('1 kΩ')
    expect(formatCompValue({ id: 'C1', kind: 'C', x: 0, y: 0, orient: 'h', value: 1e-6 })).toBe('1 µF')
    expect(formatCompValue({ id: 'OA1', kind: 'OA', x: 0, y: 0, orient: 'h', value: 0 })).toBe('')
  })

  it('波形源附带波形类型', () => {
    expect(formatCompValue({ id: 'V1', kind: 'V', x: 0, y: 0, orient: 'h', value: 2.5, wave: 'square' })).toBe(
      '2.5 V 方波',
    )
    expect(formatCompValue({ id: 'I1', kind: 'I', x: 0, y: 0, orient: 'h', value: 1e-3, wave: 'sin' })).toBe(
      '1 mA 正弦',
    )
  })
})
