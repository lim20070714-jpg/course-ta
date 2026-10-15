/**
 * 改进节点法（MNA）通用装配与求解。
 *
 * 分析类型（直流/瞬态/交流）各自把元件转换为 Stamp 列表：
 * - G：导纳（复导纳）接在节点 a、b 之间；
 * - I：电流源，将 i 安培沿 b→a 泵过自身（外部电路中电流由 a 流向 b）；
 * - V：理想电压源，约束 v(a) - v(b) = v，各占用一个附加的支路电流未知量；
 * - O：理想运放（nullor），约束 v(p) = v(n)、输入端不取电流，
 *      附加未知量为其输出端电流（流入输出节点为正）。
 *
 * 求解结果中的支路电流均按「沿 a→b 方向穿过元件」为正；理想运放为输出端流出的电流。
 */

import { add, cx, neg, solveLinear, type Cx } from './linalg'
import { CircuitError, type CircElement, type Circuit, type SourceWave } from './types'

export interface GStamp {
  kind: 'G'
  a: string
  b: string
  y: Cx
}

export interface IStamp {
  kind: 'I'
  a: string
  b: string
  i: Cx
}

export interface VStamp {
  kind: 'V'
  id: string
  a: string
  b: string
  v: Cx
}

export interface OStamp {
  kind: 'O'
  id: string
  p: string
  n: string
  out: string
}

export type Stamp = GStamp | IStamp | VStamp | OStamp

export interface RawSolution {
  /** 所有节点电压（含地节点，值为 0） */
  nodes: Record<string, Cx>
  /** 支路电流：电压源按 a→b，理想运放为输出端流出的电流（按元件 id 索引） */
  branchCurrents: Record<string, Cx>
}

/** 元件连接到的节点标签（运放为 p/n/out 三个端子） */
export function elementNodes(el: CircElement): string[] {
  return el.kind === 'OA' ? [el.p, el.n, el.out] : [el.a, el.b]
}

export function validateCircuit(circuit: Circuit): void {
  if (circuit.elements.length === 0) throw new CircuitError('电路中没有元件')
  const checkWave = (id: string, wave: SourceWave | undefined): void => {
    if (!wave) return
    if (wave.shape !== 'sin' && wave.shape !== 'square') throw new CircuitError(`${id}: 波形类型无效`)
    if (!(Number.isFinite(wave.amplitude) && wave.amplitude > 0)) {
      throw new CircuitError(`${id}: 波形幅值必须为有限正数`)
    }
    if (!(Number.isFinite(wave.frequency) && wave.frequency > 0)) {
      throw new CircuitError(`${id}: 波形频率必须为有限正数`)
    }
  }
  const ids = new Set<string>()
  for (const el of circuit.elements) {
    if (ids.has(el.id)) throw new CircuitError(`元件 id 重复：${el.id}`)
    ids.add(el.id)
    switch (el.kind) {
      case 'R':
        if (!(Number.isFinite(el.resistance) && el.resistance > 0)) {
          throw new CircuitError(`${el.id}: 电阻必须为有限正数`)
        }
        break
      case 'C':
        if (!(Number.isFinite(el.capacitance) && el.capacitance > 0)) {
          throw new CircuitError(`${el.id}: 电容必须为有限正数`)
        }
        break
      case 'L':
        if (!(Number.isFinite(el.inductance) && el.inductance > 0)) {
          throw new CircuitError(`${el.id}: 电感必须为有限正数`)
        }
        break
      case 'V':
        if (!Number.isFinite(el.voltage)) throw new CircuitError(`${el.id}: 电压源数值无效`)
        checkWave(el.id, el.wave)
        break
      case 'I':
        if (!Number.isFinite(el.current)) throw new CircuitError(`${el.id}: 电流源数值无效`)
        checkWave(el.id, el.wave)
        break
      case 'OA':
        break
    }
  }
}

/** 按首次出现顺序列出除地节点以外的全部节点标签 */
export function nodeLabels(circuit: Circuit): string[] {
  const ground = circuit.ground ?? '0'
  const seen = new Set<string>()
  const out: string[] = []
  for (const el of circuit.elements) {
    for (const label of elementNodes(el)) {
      if (label === ground || seen.has(label)) continue
      seen.add(label)
      out.push(label)
    }
  }
  return out
}

export function solveStamps(circuit: Circuit, stamps: Stamp[]): RawSolution {
  const ground = circuit.ground ?? '0'
  const labels = nodeLabels(circuit)
  const idx = new Map(labels.map((label, i) => [label, i] as const))
  const vsources = stamps.filter((s): s is VStamp => s.kind === 'V')
  const opamps = stamps.filter((s): s is OStamp => s.kind === 'O')
  const vsRow = new Map(vsources.map((s, i) => [s, labels.length + i] as const))
  const oaRow = new Map(opamps.map((s, i) => [s, labels.length + vsources.length + i] as const))

  const N = labels.length + vsources.length + opamps.length
  const A: Cx[][] = Array.from({ length: N }, () => Array.from({ length: N }, () => cx(0)))
  const rhs: Cx[] = Array.from({ length: N }, () => cx(0))

  const row = (label: string): number | undefined => idx.get(label)
  const bump = (r: number | undefined, c: number | undefined, val: Cx): void => {
    if (r === undefined || c === undefined) return
    A[r][c] = add(A[r][c], val)
  }
  const bumpRhs = (r: number | undefined, val: Cx): void => {
    if (r === undefined) return
    rhs[r] = add(rhs[r], val)
  }

  for (const s of stamps) {
    switch (s.kind) {
      case 'G':
        bump(row(s.a), row(s.a), s.y)
        bump(row(s.a), row(s.b), neg(s.y))
        bump(row(s.b), row(s.a), neg(s.y))
        bump(row(s.b), row(s.b), s.y)
        break
      case 'I':
        bumpRhs(row(s.a), s.i)
        bumpRhs(row(s.b), neg(s.i))
        break
      case 'V': {
        const k = vsRow.get(s)
        if (k === undefined) throw new CircuitError('内部错误：电压源未分配支路未知量')
        bump(row(s.a), k, cx(1))
        bump(row(s.b), k, cx(-1))
        bump(k, row(s.a), cx(1))
        bump(k, row(s.b), cx(-1))
        bumpRhs(k, s.v)
        break
      }
      case 'O': {
        const k = oaRow.get(s)
        if (k === undefined) throw new CircuitError('内部错误：理想运放未分配输出电流未知量')
        // 输出节点 KCL 中含输出电流项（流入节点为正），约束行给出 v(p) - v(n) = 0
        bump(row(s.out), k, cx(-1))
        bump(k, row(s.p), cx(1))
        bump(k, row(s.n), cx(-1))
        break
      }
    }
  }

  const x = solveLinear(A, rhs)
  const nodes: Record<string, Cx> = { [ground]: cx(0) }
  labels.forEach((label, i) => {
    nodes[label] = x[i]
  })
  const branchCurrents: Record<string, Cx> = {}
  for (const s of vsources) {
    const k = vsRow.get(s)
    if (k !== undefined) branchCurrents[s.id] = x[k]
  }
  for (const s of opamps) {
    const k = oaRow.get(s)
    if (k !== undefined) branchCurrents[s.id] = x[k]
  }
  return { nodes, branchCurrents }
}
