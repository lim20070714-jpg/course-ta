/**
 * 自由实验台：网格搭建数据模型与网表提取。
 *
 * 坐标单位为「格」，元件放置在整数格点上，导线是沿格线的正交折线。
 * 端子接触（同坐标）、导线端点落在其它线段上（T 型结点）都会合并为同一节点；
 * 两条导线在无端点处交叉不连接（符合电路图约定）。所有接地符号合并为参考节点 "0"。
 */

import { CircuitError, type CircElement, type Circuit } from '../circuit'
import { formatSi } from './labs'

/** 每格的逻辑像素大小（画布 viewBox 用） */
export const GRID = 44
export const COLS = 24
export const ROWS = 13

export type CompKind = 'R' | 'C' | 'L' | 'V' | 'I' | 'OA' | 'GND'
export type Orient = 'h' | 'v'

export interface BComp {
  /** 元件编号，如 R1、OA2 */
  id: string
  kind: CompKind
  /** 左端/后端端子所在的格坐标 */
  x: number
  y: number
  /** h：两端子水平（运放朝右）；v：两端子垂直（运放朝下） */
  orient: Orient
  /** 参数值：R(Ω) C(F) L(H) V(V) I(A)；GND/OA 未使用 */
  value: number
  /** 瞬态分析初始条件：C 为初始电压 v(0端)-v(1端)，L 为沿 0→1 的初始电流 */
  init?: number
}

export interface Pt {
  x: number
  y: number
}

export interface BWire {
  id: string
  /** 折线顶点（格坐标，相邻顶点水平或垂直） */
  pts: Pt[]
}

export interface Build {
  comps: BComp[]
  wires: BWire[]
}

export const KIND_LABEL: Record<CompKind, string> = {
  R: '电阻',
  C: '电容',
  L: '电感',
  V: '电压源',
  I: '电流源',
  OA: '理想运放',
  GND: '接地',
}

export const VALUE_UNIT: Record<CompKind, string> = {
  R: 'Ω',
  C: 'F',
  L: 'H',
  V: 'V',
  I: 'A',
  OA: '',
  GND: '',
}

export const DEFAULT_VALUE: Record<CompKind, number> = {
  R: 1000,
  C: 1e-6,
  L: 1e-3,
  V: 5,
  I: 1e-3,
  OA: 0,
  GND: 0,
}

export const ptKey = (p: Pt): string => `${p.x},${p.y}`

export function nextId(kind: CompKind, comps: BComp[]): string {
  const prefix = kind
  let max = 0
  for (const c of comps) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(c.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `${prefix}${max + 1}`
}

/** 元件端子位置：二元件的 0/1 端；运放为 p/n/out；接地只有一个端子 */
export function terminalsOf(c: BComp): { id: string; pt: Pt }[] {
  const at = (dx: number, dy: number) => ({ x: c.x + dx, y: c.y + dy })
  switch (c.kind) {
    case 'GND':
      return [{ id: '0', pt: at(0, 0) }]
    case 'OA':
      return c.orient === 'h'
        ? [
            { id: 'p', pt: at(0, -1) },
            { id: 'n', pt: at(0, 1) },
            { id: 'out', pt: at(3, 0) },
          ]
        : [
            { id: 'p', pt: at(-1, 0) },
            { id: 'n', pt: at(1, 0) },
            { id: 'out', pt: at(0, 3) },
          ]
    default:
      return c.orient === 'h'
        ? [
            { id: '0', pt: at(0, 0) },
            { id: '1', pt: at(2, 0) },
          ]
        : [
            { id: '0', pt: at(0, 0) },
            { id: '1', pt: at(0, 2) },
          ]
  }
}

/** 元件占用的格点集合（用于重叠检查与命中测试） */
export function occupiedCells(c: BComp): Pt[] {
  const out: Pt[] = []
  const push = (x0: number, y0: number, x1: number, y1: number) => {
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) out.push({ x, y })
  }
  switch (c.kind) {
    case 'GND':
      push(c.x, c.y, c.x, c.y + 1)
      break
    case 'OA':
      if (c.orient === 'h') push(c.x, c.y - 2, c.x + 3, c.y + 2)
      else push(c.x - 2, c.y, c.x + 2, c.y + 3)
      break
    default:
      if (c.orient === 'h') push(c.x, c.y, c.x + 2, c.y)
      else push(c.x, c.y, c.x, c.y + 2)
  }
  return out
}

/** 元件是否在画布范围内且不与其它元件重叠 */
export function canPlace(c: BComp, comps: BComp[], ignoreId?: string): boolean {
  const cells = occupiedCells(c)
  for (const p of cells) {
    if (p.x < 0 || p.y < 0 || p.x >= COLS || p.y >= ROWS) return false
  }
  const mine = new Set(cells.map(ptKey))
  for (const other of comps) {
    if (other.id === c.id || other.id === ignoreId) continue
    for (const p of occupiedCells(other)) {
      if (mine.has(ptKey(p))) return false
    }
  }
  return true
}

/** 元件选中框（格坐标，含边距） */
export function compBBox(c: BComp): { x0: number; y0: number; x1: number; y1: number } {
  switch (c.kind) {
    case 'GND':
      return { x0: c.x - 0.5, y0: c.y - 0.4, x1: c.x + 0.5, y1: c.y + 0.9 }
    case 'OA':
      return c.orient === 'h'
        ? { x0: c.x - 0.6, y0: c.y - 2.5, x1: c.x + 3.7, y1: c.y + 2.5 }
        : { x0: c.x - 2.5, y0: c.y - 0.6, x1: c.x + 2.5, y1: c.y + 3.7 }
    default:
      return c.orient === 'h'
        ? { x0: c.x - 0.5, y0: c.y - 0.6, x1: c.x + 2.5, y1: c.y + 0.6 }
        : { x0: c.x - 0.5, y0: c.y - 0.5, x1: c.x + 0.5, y1: c.y + 2.6 }
  }
}

/** 旋转元件（保持起点不变）；无法放置时返回 null */
export function rotateComp(c: BComp, comps: BComp[]): BComp | null {
  const next: BComp = { ...c, orient: c.orient === 'h' ? 'v' : 'h' }
  return canPlace(next, comps) ? next : null
}

/** 正交走线：共线时直线；否则按主方向先折一次（L 形） */
export function routeWire(from: Pt, to: Pt): Pt[] {
  if (from.x === to.x || from.y === to.y) return [from, to]
  const dx = Math.abs(to.x - from.x)
  const dy = Math.abs(to.y - from.y)
  const bend = dx >= dy ? { x: to.x, y: from.y } : { x: from.x, y: to.y }
  return [from, bend, to]
}

/** 数值文本框："4.7k" → 4700、"10µ" → 1e-5；非法输入返回 null */
export function parseSi(text: string): number | null {
  const t = text.trim().replace(/Ω$|[FHVA]$/, '')
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(p|n|µ|u|m|k|K|M|G)?$/.exec(t)
  if (!m) return null
  const scale: Record<string, number> = {
    p: 1e-12,
    n: 1e-9,
    µ: 1e-6,
    u: 1e-6,
    m: 1e-3,
    k: 1e3,
    K: 1e3,
    M: 1e6,
    G: 1e9,
  }
  const v = parseFloat(m[1]) * (m[2] ? scale[m[2]] : 1)
  return Number.isFinite(v) ? v : null
}

/** 元件值显示文本，如 "1 kΩ"、"10 µF" */
export function formatCompValue(c: BComp): string {
  if (c.kind === 'GND' || c.kind === 'OA') return ''
  return formatSi(c.value, VALUE_UNIT[c.kind])
}

interface NetInfo {
  name: string
  terminals: { compId: string; termId: string; pt: Pt }[]
  points: Pt[]
  ground: boolean
}

export interface BuildResult {
  circuit: Circuit
  /** 端子 → 节点名（键 `${compId}:${termId}`） */
  netOfTerminal: Map<string, string>
  /** 格点坐标 → 节点名（仅含被命名的节点，悬空导线簇不含在内） */
  netNameAtPoint: Map<string, string>
  /** 需要画结点圆点的位置（3 条及以上连线交汇处） */
  junctions: Set<string>
}

class Dsu {
  private parent = new Map<string, string>()

  find(k: string): string {
    const p = this.parent.get(k)
    if (p === undefined) {
      this.parent.set(k, k)
      return k
    }
    if (p === k) return k
    const root = this.find(p)
    this.parent.set(k, root)
    return root
  }

  union(a: string, b: string): void {
    const ra = this.find(a)
    const rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

const onSegmentStrict = (p: Pt, a: Pt, b: Pt): boolean => {
  if (a.x === b.x) return p.x === a.x && p.y > Math.min(a.y, b.y) && p.y < Math.max(a.y, b.y)
  return p.y === a.y && p.x > Math.min(a.x, b.x) && p.x < Math.max(a.x, b.x)
}

/**
 * 从搭建内容提取电路网表。
 * 节点命名：接地点为 "0"，其余按位置（自上而下、自左而右）编号 v1、v2…
 */
export function buildCircuit(build: Build): BuildResult {
  const { comps, wires } = build
  if (comps.length === 0) throw new CircuitError('画布上还没有元件')
  if (!comps.some((c) => c.kind === 'GND')) {
    throw new CircuitError('请先放置接地符号（GND），以确定参考节点')
  }

  const dsu = new Dsu()
  const coordOf = new Map<string, Pt>()

  const termKeys: { key: string; comp: BComp; termId: string; pt: Pt }[] = []
  for (const c of comps) {
    for (const t of terminalsOf(c)) {
      const key = `t:${c.id}:${t.id}`
      termKeys.push({ key, comp: c, termId: t.id, pt: t.pt })
      coordOf.set(key, t.pt)
    }
  }
  const vertexKeys: { key: string; pt: Pt }[] = []
  for (const w of wires) {
    w.pts.forEach((pt, i) => {
      const key = `w:${w.id}:${i}`
      vertexKeys.push({ key, pt })
      coordOf.set(key, pt)
      if (i > 0) dsu.union(key, `w:${w.id}:0`)
    })
  }

  // 同坐标的点互相连通（端子直接接触、导线端点相接）
  const byCoord = new Map<string, string[]>()
  for (const { key, pt } of [...termKeys, ...vertexKeys]) {
    const ck = ptKey(pt)
    const list = byCoord.get(ck) ?? []
    list.push(key)
    byCoord.set(ck, list)
  }
  for (const list of byCoord.values()) {
    for (let i = 1; i < list.length; i++) dsu.union(list[0], list[i])
  }

  // 端子/顶点落在其它线段内部 → T 型结点，合并节点
  for (const { key, pt } of [...termKeys, ...vertexKeys]) {
    for (const w of wires) {
      for (let i = 1; i < w.pts.length; i++) {
        if (onSegmentStrict(pt, w.pts[i - 1], w.pts[i])) dsu.union(key, `w:${w.id}:0`)
      }
    }
  }

  // 所有接地合并为同一参考节点
  const gndKeys = termKeys.filter((t) => t.comp.kind === 'GND').map((t) => t.key)
  for (let i = 1; i < gndKeys.length; i++) dsu.union(gndKeys[0], gndKeys[i])

  // 汇总每个连通分量
  const nets = new Map<string, NetInfo>()
  const netOf = (key: string): NetInfo => {
    const root = dsu.find(key)
    let info = nets.get(root)
    if (!info) {
      info = { name: '', terminals: [], points: [], ground: false }
      nets.set(root, info)
    }
    return info
  }
  for (const t of termKeys) {
    const info = netOf(t.key)
    info.terminals.push({ compId: t.comp.id, termId: t.termId, pt: t.pt })
    info.points.push(t.pt)
    if (t.comp.kind === 'GND') info.ground = true
  }
  for (const v of vertexKeys) netOf(v.key).points.push(v.pt)

  // 悬空端子检查（接地点除外）
  const floating: string[] = []
  for (const info of nets.values()) {
    if (info.ground || info.terminals.length !== 1) continue
    const t = info.terminals[0]
    floating.push(`${t.compId}-${t.termId}`)
  }
  if (floating.length > 0) {
    throw new CircuitError(`存在悬空端子：${floating.join('、')}。请用导线把端子接入电路，或删除多余元件`)
  }

  // 命名：接地为 "0"，其余含端子的节点按位置排序编号；纯导线簇不命名
  const sorted = [...nets.values()].sort((a, b) => {
    const ka = a.points.reduce((m, p) => (p.y < m.y || (p.y === m.y && p.x < m.x) ? p : m))
    const kb = b.points.reduce((m, p) => (p.y < m.y || (p.y === m.y && p.x < m.x) ? p : m))
    return ka.y - kb.y || ka.x - kb.x
  })
  let seq = 0
  const netNameAtPoint = new Map<string, string>()
  for (const info of sorted) {
    if (info.ground) info.name = '0'
    else if (info.terminals.length > 0) info.name = `v${++seq}`
    else continue
    for (const p of info.points) netNameAtPoint.set(ptKey(p), info.name)
  }

  // 结点圆点：端点/端子交汇 ≥3 条连线处才画点；
  // 两条导线在无端点处交叉不连通，因此也不画点（符合电路图约定）
  const degree = new Map<string, number>()
  const hasItem = new Set<string>()
  const bump = (p: Pt, n: number) => degree.set(ptKey(p), (degree.get(ptKey(p)) ?? 0) + n)
  for (const t of termKeys) {
    bump(t.pt, 1)
    hasItem.add(ptKey(t.pt))
  }
  for (const v of vertexKeys) hasItem.add(ptKey(v.pt))
  for (const w of wires) {
    w.pts.forEach((p, i) => {
      const ends = (i > 0 ? 1 : 0) + (i < w.pts.length - 1 ? 1 : 0)
      bump(p, ends)
    })
    for (let i = 1; i < w.pts.length; i++) {
      const a = w.pts[i - 1]
      const b = w.pts[i]
      for (const { pt } of [...termKeys, ...vertexKeys]) {
        if (onSegmentStrict(pt, a, b)) bump(pt, 2)
      }
    }
  }
  const junctions = new Set<string>()
  for (const [k, n] of degree) if (n >= 3 && hasItem.has(k)) junctions.add(k)

  // 生成元件
  const nameOf = (compId: string, termId: string): string => {
    const info = netOf(`t:${compId}:${termId}`)
    return info.name
  }
  const elements: CircElement[] = []
  const netOfTerminal = new Map<string, string>()
  for (const c of comps) {
    for (const t of terminalsOf(c)) netOfTerminal.set(`${c.id}:${t.id}`, nameOf(c.id, t.id))
    switch (c.kind) {
      case 'GND':
        break
      case 'R':
        elements.push({ kind: 'R', id: c.id, a: nameOf(c.id, '0'), b: nameOf(c.id, '1'), resistance: c.value })
        break
      case 'C':
        elements.push({
          kind: 'C',
          id: c.id,
          a: nameOf(c.id, '0'),
          b: nameOf(c.id, '1'),
          capacitance: c.value,
          initialVoltage: c.init ?? 0,
        })
        break
      case 'L':
        elements.push({
          kind: 'L',
          id: c.id,
          a: nameOf(c.id, '0'),
          b: nameOf(c.id, '1'),
          inductance: c.value,
          initialCurrent: c.init ?? 0,
        })
        break
      case 'V':
        elements.push({ kind: 'V', id: c.id, a: nameOf(c.id, '1'), b: nameOf(c.id, '0'), voltage: c.value })
        break
      case 'I':
        elements.push({ kind: 'I', id: c.id, a: nameOf(c.id, '1'), b: nameOf(c.id, '0'), current: c.value })
        break
      case 'OA':
        elements.push({
          kind: 'OA',
          id: c.id,
          p: nameOf(c.id, 'p'),
          n: nameOf(c.id, 'n'),
          out: nameOf(c.id, 'out'),
        })
        break
    }
  }

  return { circuit: { elements }, netOfTerminal, netNameAtPoint, junctions }
}

/** 示例：12V 分压器（8V 输出），供「放入示例」按钮使用 */
export function sampleBuild(): Build {
  return {
    comps: [
      { id: 'V1', kind: 'V', x: 2, y: 4, orient: 'h', value: 12 },
      { id: 'R1', kind: 'R', x: 5, y: 4, orient: 'v', value: 1000 },
      { id: 'R2', kind: 'R', x: 5, y: 7, orient: 'v', value: 2000 },
      { id: 'GND1', kind: 'GND', x: 2, y: 9, orient: 'v', value: 0 },
    ],
    wires: [
      { id: 'W1', pts: [{ x: 2, y: 4 }, { x: 2, y: 9 }, { x: 5, y: 9 }] },
      { id: 'W2', pts: [{ x: 4, y: 4 }, { x: 5, y: 4 }] },
      { id: 'W3', pts: [{ x: 5, y: 6 }, { x: 5, y: 7 }] },
    ],
  }
}
