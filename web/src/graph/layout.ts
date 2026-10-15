import type { GraphEdge, GraphNode } from '../api'

export interface Point {
  x: number
  y: number
}

const ITERATIONS = 300
const REPULSION = 5200
const EDGE_LEN = 130
const SPRING_STRONG = 0.03
const SPRING_SOFT = 0.012
const BAND_PULL = 0.06
const HOME_PULL = 0.012
const PAD = 34

export function moduleOrder(nodes: GraphNode[]): string[] {
  const ordered = [...nodes].sort((a, b) => a.order - b.order)
  const seen: string[] = []
  for (const node of ordered) {
    if (!seen.includes(node.module)) seen.push(node.module)
  }
  return seen
}

/** 确定性力导向布局：模块按学习顺序自上而下分带，节点在带内展开，边做弹簧收紧。 */
export function layoutGraph(
  nodes: GraphNode[],
  edges: GraphEdge[],
  width: number,
  height: number,
): Map<number, Point> {
  const modules = moduleOrder(nodes)
  const bandH = modules.length > 0 ? (height - 2 * PAD) / modules.length : height
  const byModule = new Map<string, GraphNode[]>()
  for (const node of nodes) {
    const list = byModule.get(node.module) ?? []
    list.push(node)
    byModule.set(node.module, list)
  }

  const home = new Map<number, Point>()
  const pos = new Map<number, Point>()
  modules.forEach((module, mi) => {
    const list = (byModule.get(module) ?? []).sort((a, b) => a.order - b.order)
    const cy = PAD + (mi + 0.5) * bandH
    list.forEach((node, i) => {
      const x = (width * (i + 1)) / (list.length + 1)
      const jitter = (i % 2 === 0 ? -1 : 1) * bandH * 0.14
      const y = Math.min(Math.max(PAD, cy + jitter), height - PAD)
      home.set(node.id, { x, y })
      pos.set(node.id, { x, y })
    })
  })

  const at = (id: number): Point => pos.get(id) ?? { x: width / 2, y: height / 2 }
  for (let step = 0; step < ITERATIONS; step++) {
    const force = new Map<number, Point>()
    for (const node of nodes) force.set(node.id, { x: 0, y: 0 })

    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = at(nodes[i].id)
        const b = at(nodes[j].id)
        let dx = a.x - b.x
        let dy = a.y - b.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) {
          dx = i - j === 0 ? 1 : i - j
          dy = 1
          d2 = dx * dx + dy * dy
        }
        const dist = Math.sqrt(d2)
        const f = REPULSION / d2
        const fa = force.get(nodes[i].id)
        const fb = force.get(nodes[j].id)
        if (!fa || !fb) continue
        fa.x += (dx / dist) * f
        fa.y += (dy / dist) * f
        fb.x -= (dx / dist) * f
        fb.y -= (dy / dist) * f
      }
    }

    for (const edge of edges) {
      const fa = force.get(edge.source)
      const fb = force.get(edge.target)
      if (!fa || !fb) continue
      const a = at(edge.source)
      const b = at(edge.target)
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy) || 1
      const k = edge.relation === 'prerequisite' ? SPRING_STRONG : SPRING_SOFT
      const f = (dist - EDGE_LEN) * k
      fa.x += (dx / dist) * f
      fa.y += (dy / dist) * f
      fb.x -= (dx / dist) * f
      fb.y -= (dy / dist) * f
    }

    for (const node of nodes) {
      const f = force.get(node.id)
      const h = home.get(node.id)
      if (!f || !h) continue
      const current = at(node.id)
      f.x += (h.x - current.x) * HOME_PULL
      f.y += (h.y - current.y) * BAND_PULL
      const next = {
        x: Math.min(Math.max(PAD, current.x + f.x), width - PAD),
        y: Math.min(Math.max(PAD, current.y + f.y), height - PAD),
      }
      pos.set(node.id, next)
    }
  }
  return pos
}
