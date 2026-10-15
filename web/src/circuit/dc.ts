/** 直流工作点分析。电容视为开路，电感视为短路。 */

import { cx } from './linalg'
import { solveStamps, validateCircuit, type Stamp } from './solver'
import type { Circuit } from './types'

export interface DCResult {
  /** 节点电压，单位 V（含地节点，值为 0） */
  nodes: Record<string, number>
  /** 各元件电流，单位 A，沿 a→b 方向为正 */
  currents: Record<string, number>
}

export function solveDC(circuit: Circuit): DCResult {
  validateCircuit(circuit)

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
      case 'L':
        // 直流稳态：电感等效为 0V 电压源（短路），支路电流为未知量
        stamps.push({ kind: 'V', id: el.id, a: el.a, b: el.b, v: cx(0) })
        break
      case 'C':
        // 直流稳态：电容开路，电流为 0
        break
    }
  }

  const sol = solveStamps(circuit, stamps)
  const v = (label: string): number => sol.nodes[label].re

  const nodes: Record<string, number> = {}
  for (const [label, val] of Object.entries(sol.nodes)) nodes[label] = val.re

  const currents: Record<string, number> = {}
  for (const el of circuit.elements) {
    switch (el.kind) {
      case 'R':
        currents[el.id] = (v(el.a) - v(el.b)) / el.resistance
        break
      case 'V':
      case 'L':
        currents[el.id] = sol.branchCurrents[el.id].re
        break
      case 'I':
        // 电流沿 a→b 穿过元件与源内部泵流方向相反
        currents[el.id] = -el.current
        break
      case 'C':
        currents[el.id] = 0
        break
    }
  }

  return { nodes, currents }
}
