/** 交流相量分析与对数扫频（波特图数据）。 */

import { cx, div, type Cx } from './linalg'
import { solveStamps, validateCircuit, type Stamp } from './solver'
import { CircuitError, type Circuit } from './types'

export interface ACResult {
  /** 节点电压相量（含地节点，值为 0） */
  nodes: Record<string, Cx>
}

export function solveAC(circuit: Circuit, f: number): ACResult {
  validateCircuit(circuit)
  if (!(Number.isFinite(f) && f > 0)) throw new CircuitError('频率必须为有限正数')
  const w = 2 * Math.PI * f

  const stamps: Stamp[] = []
  for (const el of circuit.elements) {
    switch (el.kind) {
      case 'R':
        stamps.push({ kind: 'G', a: el.a, b: el.b, y: cx(1 / el.resistance) })
        break
      case 'C':
        // 容抗导纳：jωC
        stamps.push({ kind: 'G', a: el.a, b: el.b, y: cx(0, w * el.capacitance) })
        break
      case 'L':
        // 感抗导纳：1/(jωL)
        stamps.push({ kind: 'G', a: el.a, b: el.b, y: div(cx(1), cx(0, w * el.inductance)) })
        break
      case 'V':
        stamps.push({ kind: 'V', id: el.id, a: el.a, b: el.b, v: cx(el.voltage) })
        break
      case 'I':
        stamps.push({ kind: 'I', a: el.a, b: el.b, i: cx(el.current) })
        break
    }
  }

  return { nodes: solveStamps(circuit, stamps).nodes }
}

export interface SweepOptions {
  fStart: number
  fStop: number
  /** 对数等间隔采样点数，默认 60 */
  points?: number
}

export interface SweepResult {
  f: number[]
  /** 各节点在每个频点的电压相量 */
  nodes: Record<string, Cx[]>
}

export function sweep(circuit: Circuit, opts: SweepOptions): SweepResult {
  const { fStart, fStop } = opts
  const points = opts.points ?? 60
  if (!(Number.isFinite(fStart) && fStart > 0) || !(Number.isFinite(fStop) && fStop > fStart)) {
    throw new CircuitError('扫频范围需要满足 0 < fStart < fStop')
  }
  if (!(Number.isInteger(points) && points >= 2 && points <= 1000)) {
    throw new CircuitError('扫频点数需要为 2–1000 之间的整数')
  }

  const f: number[] = []
  const nodes: Record<string, Cx[]> = {}
  for (let i = 0; i < points; i++) {
    const fi = fStart * Math.pow(fStop / fStart, i / (points - 1))
    f.push(fi)
    const sol = solveAC(circuit, fi)
    for (const [label, val] of Object.entries(sol.nodes)) {
      ;(nodes[label] ??= []).push(val)
    }
  }
  return { f, nodes }
}

export const magnitude = (x: Cx): number => Math.hypot(x.re, x.im)

export const phaseDeg = (x: Cx): number => (Math.atan2(x.im, x.re) * 180) / Math.PI

/** 幅值的分贝表示：20·log10(|x|)，注意 |x|=0 时为 -Infinity */
export const toDb = (x: Cx): number => 20 * Math.log10(magnitude(x))
