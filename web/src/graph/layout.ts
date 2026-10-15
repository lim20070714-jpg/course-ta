import type { GraphEdge, GraphNode } from '../api'

export type Direction = 'horizontal' | 'vertical'

export interface Size {
  w: number
  h: number
}

export interface View extends Size {
  x: number
  y: number
}

export interface PillBox {
  x: number
  y: number
  w: number
  h: number
}

export interface ChipBox {
  module: string
  count: number
  x: number
  y: number
  w: number
  h: number
}

export interface EdgePath {
  key: string
  source: number
  target: number
  relation: string
  cross: boolean
  d: string
}

export interface MindMap {
  world: Size
  pills: Map<number, PillBox>
  chips: ChipBox[]
  edges: EdgePath[]
}

const PAD = 28
const PILL_H = 34
const CHIP_W = 150
const CHIP_H = 30

// 水平（宽屏）：模块成行，左侧模块签，概念胶囊按学习顺序横向串联
const H_PILL_X = 204
const H_GAP = 42
const H_PITCH = 62

// 垂直（窄屏）：模块签在上、概念胶囊竖向串联，跨模块/跳级关系走右侧通道
const V_CHIP_X = 28
const V_PILL_X = 54
const V_GAP = 22
const V_MODULE_GAP = 30
const V_LANE_GAP = 30
const V_LANE_STEP = 64

export function moduleOrder(nodes: GraphNode[]): string[] {
  const ordered = [...nodes].sort((a, b) => a.order - b.order)
  const seen: string[] = []
  for (const node of ordered) {
    if (!seen.includes(node.module)) seen.push(node.module)
  }
  return seen
}

/** 估算胶囊宽度：CJK/全角字符按全宽计，其余按半宽计。 */
export function estimatePillWidth(name: string): number {
  let w = 0
  for (const ch of name) {
    w += /[\u2e80-\u9fff\uac00-\ud7af\uff01-\uff60]/.test(ch) ? 12.8 : 7.2
  }
  return Math.min(250, Math.max(64, Math.round(w) + 24))
}

function groupByModule(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const byModule = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const list = byModule.get(node.module) ?? []
    list.push(node)
    byModule.set(node.module, list)
  }
  for (const list of byModule.values()) {
    list.sort((a, b) => a.order - b.order || a.id - b.id)
  }
  return byModule
}

interface EdgeInput {
  edge: GraphEdge
  index: number
  a: PillBox
  b: PillBox
}

/** 确定性思维导图布局：模块为分支，概念胶囊按学习顺序串联，前置箭头、相关虚线。 */
export function layoutMindMap(
  nodes: GraphNode[],
  edges: GraphEdge[],
  direction: Direction,
): MindMap {
  return direction === 'horizontal'
    ? layoutHorizontal(nodes, edges)
    : layoutVertical(nodes, edges)
}

function layoutHorizontal(nodes: GraphNode[], edges: GraphEdge[]): MindMap {
  const modules = moduleOrder(nodes)
  const byModule = groupByModule(nodes)
  const pills = new Map<number, PillBox>()
  const chips: ChipBox[] = []
  const info = new Map<number, { row: number; idx: number; cy: number }>()

  let maxRight = H_PILL_X
  modules.forEach((module, row) => {
    const list = byModule.get(module) ?? []
    const cy = PAD + row * H_PITCH + PILL_H / 2
    chips.push({ module, count: list.length, x: PAD, y: cy - CHIP_H / 2, w: CHIP_W, h: CHIP_H })
    let x = H_PILL_X
    list.forEach((node, idx) => {
      const w = estimatePillWidth(node.name)
      pills.set(node.id, { x, y: cy - PILL_H / 2, w, h: PILL_H })
      info.set(node.id, { row, idx, cy })
      x += w + H_GAP
    })
    maxRight = Math.max(maxRight, x - H_GAP)
  })

  const world: Size = {
    w: maxRight + PAD,
    h: PAD + Math.max(0, modules.length - 1) * H_PITCH + PILL_H + PAD,
  }

  const out: EdgePath[] = []
  edges.forEach((edge, i) => {
    const a = pills.get(edge.source)
    const b = pills.get(edge.target)
    const ia = info.get(edge.source)
    const ib = info.get(edge.target)
    if (!a || !b || !ia || !ib) return
    const cross = ia.row !== ib.row
    const key = `${edge.source}-${edge.target}-${i}`
    let d: string
    if (!cross) {
      const forward = ib.idx > ia.idx
      const span = Math.abs(ib.idx - ia.idx)
      const sx = forward ? a.x + a.w : a.x
      const ex = forward ? b.x : b.x + b.w
      const cy = ia.cy
      const mid = (sx + ex) / 2
      const prereq = edge.relation === 'prerequisite'
      const down = prereq ? !forward : true
      const off = prereq
        ? span <= 1
          ? 18
          : span <= 2
            ? 40
            : 56
        : span <= 1
          ? 22
          : span <= 2
            ? 34
            : span <= 3
              ? 46
              : 58
      d = `M ${sx} ${cy} Q ${mid} ${cy + (down ? off : -off)} ${ex} ${cy}`
    } else {
      const sx = a.x + a.w
      const sy = ia.cy
      const ex = b.x
      const ey = ib.cy
      const inset = edge.relation === 'prerequisite' ? 40 : 30
      d = `M ${sx} ${sy} C ${sx + inset} ${sy}, ${ex - inset} ${ey}, ${ex} ${ey}`
    }
    out.push({ key, source: edge.source, target: edge.target, relation: edge.relation, cross, d })
  })

  return { world, pills, chips, edges: out }
}

function layoutVertical(nodes: GraphNode[], edges: GraphEdge[]): MindMap {
  const modules = moduleOrder(nodes)
  const byModule = groupByModule(nodes)
  const pills = new Map<number, PillBox>()
  const chips: ChipBox[] = []
  const info = new Map<number, { idx: number; module: string }>()

  let y = PAD
  let contentBottom = PAD + PILL_H
  let maxPillW = 0
  for (const module of modules) {
    const list = byModule.get(module) ?? []
    chips.push({ module, count: list.length, x: V_CHIP_X, y, w: CHIP_W, h: CHIP_H })
    y += CHIP_H + 14
    list.forEach((node, idx) => {
      const w = estimatePillWidth(node.name)
      maxPillW = Math.max(maxPillW, w)
      pills.set(node.id, { x: V_PILL_X, y, w, h: PILL_H })
      info.set(node.id, { idx, module })
      y += PILL_H + V_GAP
    })
    contentBottom = y - V_GAP
    y += V_MODULE_GAP - V_GAP
  }

  // 右侧通道：相关虚线走内道，前置箭头走外道（仅在有跨段连线时占位）
  let laneBase = 0
  let relatedLane = 0
  let prereqLane = 0
  let worldRight = Math.max(V_PILL_X + maxPillW, V_CHIP_X + CHIP_W)
  const laneEdges: EdgeInput[] = []
  const directEdges: EdgeInput[] = []
  const pruneLane = { related: false, prereq: false }
  edges.forEach((edge, index) => {
    const a = pills.get(edge.source)
    const b = pills.get(edge.target)
    if (!a || !b) return
    const sa = info.get(edge.source)
    const sb = info.get(edge.target)
    const consecutive =
      sa !== undefined && sb !== undefined && sa.module === sb.module && sb.idx === sa.idx + 1
    const down = b.y > a.y
    if (edge.relation === 'prerequisite' && consecutive && down) {
      directEdges.push({ edge, index, a, b })
    } else {
      laneEdges.push({ edge, index, a, b })
      if (edge.relation === 'prerequisite') pruneLane.prereq = true
      else pruneLane.related = true
    }
  })

  if (laneEdges.length > 0) {
    laneBase = worldRight + V_LANE_GAP
    relatedLane = laneBase
    prereqLane = laneBase + (pruneLane.related ? V_LANE_STEP : 0)
    worldRight = pruneLane.prereq ? prereqLane : relatedLane
  }
  const world: Size = { w: worldRight + PAD + 12, h: contentBottom + PAD }

  const out: EdgePath[] = []
  for (const { edge, index, a, b } of directEdges) {
    const c = V_GAP * 0.6
    const d =
      `M ${a.x + a.w / 2} ${a.y + a.h} ` +
      `C ${a.x + a.w / 2} ${a.y + a.h + c}, ${b.x + b.w / 2} ${b.y - c}, ${b.x + b.w / 2} ${b.y}`
    out.push({
      key: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      cross: false,
      d,
    })
  }
  for (const { edge, index, a, b } of laneEdges) {
    const lane = edge.relation === 'prerequisite' ? prereqLane : relatedLane
    const sx = a.x + a.w
    const sy = a.y + a.h / 2
    const tx = b.x + b.w
    const ty = b.y + b.h / 2
    const dirY = ty > sy ? 1 : -1
    const r = Math.min(8, Math.abs(ty - sy) / 2)
    const d =
      `M ${sx} ${sy} ` +
      `L ${lane - r} ${sy} Q ${lane} ${sy} ${lane} ${sy + r * dirY} ` +
      `L ${lane} ${ty - r * dirY} Q ${lane} ${ty} ${lane - r} ${ty} ` +
      `L ${tx} ${ty}`
    out.push({
      key: `${edge.source}-${edge.target}-${index}`,
      source: edge.source,
      target: edge.target,
      relation: edge.relation,
      cross: info.get(edge.source)?.module !== info.get(edge.target)?.module,
      d,
    })
  }

  return { world, pills, chips, edges: out }
}

/** 自适应视窗：窄屏纵向按宽适配、顶部对齐；宽屏横向整体适配（不放大超过 1）。 */
export function fitView(world: Size, size: Size, direction: Direction): View {
  const pad = 16
  const ww = world.w + 2 * pad
  const wh = world.h + 2 * pad
  const scale =
    direction === 'vertical'
      ? Math.min(size.w / ww, 1)
      : Math.min(size.w / ww, size.h / wh, 1)
  const vw = size.w / scale
  const vh = size.h / scale
  const x = -pad + (ww - vw) / 2
  const y = direction === 'vertical' ? -pad : -pad + (wh - vh) / 2
  return { x, y, w: vw, h: vh }
}
