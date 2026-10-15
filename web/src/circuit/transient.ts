/**
 * 瞬态分析：后向欧拉法（Backward Euler）。
 *
 * 电容伴随模型（a、b 之间）：导纳 G = C/dt，并联一个向 a 注入 G·v_prev 的电流源；
 * 电感伴随模型：导纳 G = dt/L，并联一个向 a 注入 -i_prev 的电流源。
 * t=0 时刻按初始条件求解：电容等效为电压源 v_prev，电感等效为电流源 i_prev。
 */

import { cx } from './linalg'
import { solveStamps, validateCircuit, type RawSolution, type Stamp } from './solver'
import { CircuitError, type Capacitor, type Circuit, type Inductor } from './types'

export interface TransientOptions {
  /** 时间步长，单位 s */
  dt: number
  /** 仿真总时长，单位 s */
  duration: number
}

export interface TransientResult {
  t: number[]
  /** 各节点电压随时间变化，单位 V（含地节点，恒为 0） */
  nodes: Record<string, number[]>
  /** 各元件电流随时间变化，单位 A，沿 a→b 方向为正 */
  currents: Record<string, number[]>
}

const MAX_STEPS = 200_000

export function solveTransient(circuit: Circuit, opts: TransientOptions): TransientResult {
  validateCircuit(circuit)
  const { dt, duration } = opts
  if (!(Number.isFinite(dt) && dt > 0) || !(Number.isFinite(duration) && duration > 0)) {
    throw new CircuitError('瞬态分析的 dt 与 duration 必须为正数')
  }
  const steps = Math.max(1, Math.round(duration / dt))
  if (steps > MAX_STEPS) {
    throw new CircuitError(`仿真步数过多（${steps} > ${MAX_STEPS}），请增大步长或缩短时长`)
  }

  const caps = circuit.elements.filter((e): e is Capacitor => e.kind === 'C')
  const inds = circuit.elements.filter((e): e is Inductor => e.kind === 'L')
  const vPrev = new Map(caps.map((c) => [c.id, c.initialVoltage ?? 0] as const))
  const iPrev = new Map(inds.map((l) => [l.id, l.initialCurrent ?? 0] as const))

  const solvePoint = (companion: boolean): RawSolution => {
    const stamps: Stamp[] = []
    for (const el of circuit.elements) {
      switch (el.kind) {
        case 'R':
          stamps.push({ kind: 'G', a: el.a, b: el.b, y: cx(1 / el.resistance) })
          break
        case 'V':
          stamps.push({ kind: 'V', id: el.id, a: el.a, b: el.b, v: cx(el.voltage) })
          break
        case 'I':
          stamps.push({ kind: 'I', a: el.a, b: el.b, i: cx(el.current) })
          break
        case 'C': {
          const g = el.capacitance / dt
          if (companion) {
            stamps.push({ kind: 'G', a: el.a, b: el.b, y: cx(g) })
            stamps.push({ kind: 'I', a: el.a, b: el.b, i: cx(g * (vPrev.get(el.id) ?? 0)) })
          } else {
            stamps.push({ kind: 'V', id: el.id, a: el.a, b: el.b, v: cx(vPrev.get(el.id) ?? 0) })
          }
          break
        }
        case 'L':
          if (companion) stamps.push({ kind: 'G', a: el.a, b: el.b, y: cx(dt / el.inductance) })
          stamps.push({ kind: 'I', a: el.a, b: el.b, i: cx(-(iPrev.get(el.id) ?? 0)) })
          break
        case 'OA':
          stamps.push({ kind: 'O', id: el.id, p: el.p, n: el.n, out: el.out })
          break
      }
    }
    return solveStamps(circuit, stamps)
  }

  const t: number[] = []
  const nodes: Record<string, number[]> = {}
  const currents: Record<string, number[]> = {}

  const record = (time: number, sol: RawSolution, companion: boolean): void => {
    t.push(time)
    for (const [label, val] of Object.entries(sol.nodes)) {
      ;(nodes[label] ??= []).push(val.re)
    }
    const v = (label: string): number => sol.nodes[label].re
    for (const el of circuit.elements) {
      let i: number
      switch (el.kind) {
        case 'R':
          i = (v(el.a) - v(el.b)) / el.resistance
          break
        case 'V':
          i = sol.branchCurrents[el.id].re
          break
        case 'I':
          i = -el.current
          break
        case 'C': {
          if (companion) {
            const g = el.capacitance / dt
            i = g * (v(el.a) - v(el.b)) - g * (vPrev.get(el.id) ?? 0)
          } else {
            i = sol.branchCurrents[el.id].re
          }
          break
        }
        case 'L':
          i = companion
            ? (dt / el.inductance) * (v(el.a) - v(el.b)) + (iPrev.get(el.id) ?? 0)
            : (iPrev.get(el.id) ?? 0)
          break
        case 'OA':
          i = sol.branchCurrents[el.id].re
          break
      }
      ;(currents[el.id] ??= []).push(i)
    }
  }

  record(0, solvePoint(false), false)
  for (let k = 1; k <= steps; k++) {
    const sol = solvePoint(true)
    record(k * dt, sol, true)
    for (const c of caps) vPrev.set(c.id, sol.nodes[c.a].re - sol.nodes[c.b].re)
    for (const l of inds) {
      iPrev.set(
        l.id,
        (dt / l.inductance) * (sol.nodes[l.a].re - sol.nodes[l.b].re) + (iPrev.get(l.id) ?? 0),
      )
    }
  }

  return { t, nodes, currents }
}
