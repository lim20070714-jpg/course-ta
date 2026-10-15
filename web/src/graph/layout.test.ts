import { describe, expect, it } from 'vitest'

import type { GraphNode } from '../api'
import { layoutGraph, moduleOrder } from './layout'

function node(id: number, name: string, module: string, order: number): GraphNode {
  return {
    id,
    name,
    description: '',
    module,
    order,
    material_id: null,
    material: '',
    page: 0,
    problems: [],
  }
}

const NODES = [
  node(1, '电阻', '电路基础', 0),
  node(2, 'KCL', '电路基础', 1),
  node(3, '戴维南定理', '网络定理', 2),
  node(4, '一阶电路', '动态电路', 3),
]

const EDGES = [
  { source: 2, target: 3, relation: 'prerequisite', note: '' },
  { source: 3, target: 4, relation: 'related', note: '' },
]

describe('moduleOrder', () => {
  it('按 order 得到模块的学习顺序', () => {
    expect(moduleOrder(NODES)).toEqual(['电路基础', '网络定理', '动态电路'])
  })
})

describe('layoutGraph', () => {
  it('为每个节点输出坐标', () => {
    const positions = layoutGraph(NODES, EDGES, 1000, 700)
    expect(positions.size).toBe(NODES.length)
  })

  it('结果确定：两次调用一致', () => {
    const a = layoutGraph(NODES, EDGES, 1000, 700)
    const b = layoutGraph(NODES, EDGES, 1000, 700)
    for (const id of a.keys()) {
      expect(b.get(id)).toEqual(a.get(id))
    }
  })

  it('模块分带：先学模块的节点整体在上方', () => {
    const positions = layoutGraph(NODES, EDGES, 1000, 700)
    const avg = (ids: number[]) =>
      ids.reduce((s, id) => s + (positions.get(id)?.y ?? 0), 0) / ids.length
    expect(avg([1, 2])).toBeLessThan(avg([3]))
    expect(avg([3])).toBeLessThan(avg([4]))
  })

  it('所有坐标在画布范围内', () => {
    const positions = layoutGraph(NODES, EDGES, 1000, 700)
    for (const p of positions.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x).toBeLessThanOrEqual(1000)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y).toBeLessThanOrEqual(700)
    }
  })

  it('边引用不存在节点时不受影响', () => {
    const positions = layoutGraph(
      NODES,
      [{ source: 1, target: 999, relation: 'related', note: '' }],
      1000,
      700,
    )
    expect(positions.size).toBe(NODES.length)
  })
})
