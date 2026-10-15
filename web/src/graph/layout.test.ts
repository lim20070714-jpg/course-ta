import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '../api'
import { estimatePillWidth, fitView, layoutMindMap, moduleOrder } from './layout'

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

function edge(source: number, target: number, relation = 'prerequisite'): GraphEdge {
  return { source, target, relation, note: '' }
}

const NODES = [
  node(1, '电阻', '电路基础', 0),
  node(2, 'KCL', '电路基础', 1),
  node(3, '戴维南定理', '电路基础', 2),
  node(4, '一阶电路', '动态电路', 3),
  node(5, '二阶电路', '动态电路', 4),
  node(6, '拉普拉斯变换', '动态电路', 5),
]

const EDGES = [
  edge(1, 2),
  edge(2, 3),
  edge(3, 4),
  edge(4, 5),
  edge(5, 6),
  edge(3, 1),
  edge(1, 3, 'related'),
  edge(5, 2, 'related'),
]

function nums(d: string): number[] {
  return (d.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
}

function start(d: string): number[] {
  return nums(d).slice(0, 2)
}

function end(d: string): number[] {
  return nums(d).slice(-2)
}

function at(map: Map<number, { x: number; y: number; w: number; h: number }>, id: number) {
  const box = map.get(id)
  if (!box) throw new Error(`missing pill ${id}`)
  return box
}

describe('moduleOrder', () => {
  it('按 order 得到模块的学习顺序', () => {
    expect(moduleOrder(NODES)).toEqual(['电路基础', '动态电路'])
  })
})

describe('estimatePillWidth', () => {
  it('短名称取最小宽度', () => {
    expect(estimatePillWidth('电阻')).toBe(64)
  })

  it('中文按全宽估算', () => {
    expect(estimatePillWidth('运放与放大器')).toBe(Math.round(6 * 12.8) + 24)
  })

  it('英文按半宽估算', () => {
    expect(estimatePillWidth('ABCDEFGHIJ')).toBe(Math.round(10 * 7.2) + 24)
  })

  it('超长名称封顶', () => {
    expect(estimatePillWidth('一二三四五六七八九十一二三四五六七八九十')).toBe(250)
  })
})

describe('layoutMindMap 水平模式', () => {
  const map = layoutMindMap(NODES, EDGES, 'horizontal')

  it('为每个概念输出胶囊，且在画布范围内', () => {
    expect(map.pills.size).toBe(NODES.length)
    for (const p of map.pills.values()) {
      expect(p.x).toBeGreaterThanOrEqual(0)
      expect(p.x + p.w).toBeLessThanOrEqual(map.world.w)
      expect(p.y).toBeGreaterThanOrEqual(0)
      expect(p.y + p.h).toBeLessThanOrEqual(map.world.h)
    }
  })

  it('同模块胶囊同一行、按顺序排开且不重叠', () => {
    const a = at(map.pills, 1)
    const b = at(map.pills, 2)
    const c = at(map.pills, 3)
    expect(b.y).toBe(a.y)
    expect(c.y).toBe(a.y)
    expect(b.x - (a.x + a.w)).toBeGreaterThanOrEqual(42 - 0.01)
    expect(c.x - (b.x + b.w)).toBeGreaterThanOrEqual(42 - 0.01)
  })

  it('模块按学习顺序自上而下分行', () => {
    expect(at(map.pills, 1).y).toBeLessThan(at(map.pills, 4).y)
  })

  it('每个模块一个模块签，与所在行居中对齐', () => {
    expect(map.chips.map((c) => c.module)).toEqual(['电路基础', '动态电路'])
    const chip = map.chips[0]
    const row = at(map.pills, 1)
    expect(chip.x).toBe(28)
    expect(chip.y + chip.h / 2).toBe(row.y + row.h / 2)
    expect(chip.count).toBe(3)
  })

  it('顺连前置边从左胶囊右缘到右胶囊左缘，向上拱起', () => {
    const e = map.edges.find((x) => x.source === 1 && x.target === 2)
    expect(e).toBeTruthy()
    const a = at(map.pills, 1)
    const b = at(map.pills, 2)
    expect(start(e!.d)).toEqual([a.x + a.w, a.y + a.h / 2])
    expect(end(e!.d)).toEqual([b.x, b.y + b.h / 2])
    expect(nums(e!.d)[3]).toBeLessThan(a.y)
  })

  it('回向前置边向下绕行', () => {
    const e = map.edges.find((x) => x.source === 3 && x.target === 1)
    expect(e).toBeTruthy()
    const a = at(map.pills, 3)
    const b = at(map.pills, 1)
    expect(start(e!.d)).toEqual([a.x, a.y + a.h / 2])
    expect(end(e!.d)).toEqual([b.x + b.w, b.y + b.h / 2])
    expect(nums(e!.d)[3]).toBeGreaterThan(a.y + a.h)
  })

  it('跨模块边以三次曲线连接行间', () => {
    const e = map.edges.find((x) => x.source === 3 && x.target === 4)
    expect(e).toBeTruthy()
    expect(e!.cross).toBe(true)
    const a = at(map.pills, 3)
    const b = at(map.pills, 4)
    expect(start(e!.d)).toEqual([a.x + a.w, a.y + a.h / 2])
    expect(end(e!.d)).toEqual([b.x, b.y + b.h / 2])
  })

  it('引用不存在概念的边被跳过', () => {
    const map2 = layoutMindMap(NODES, [...EDGES, edge(1, 999)], 'horizontal')
    expect(map2.edges.length).toBe(map.edges.length)
  })

  it('结果确定：两次调用一致', () => {
    const again = layoutMindMap(NODES, EDGES, 'horizontal')
    expect(JSON.stringify([...again.pills])).toBe(JSON.stringify([...map.pills]))
    expect(JSON.stringify(again.edges)).toBe(JSON.stringify(map.edges))
    expect(JSON.stringify(again.world)).toBe(JSON.stringify(map.world))
  })
})

describe('layoutMindMap 垂直模式', () => {
  const map = layoutMindMap(NODES, EDGES, 'vertical')

  it('同模块胶囊竖向串联，模块签位于其上方', () => {
    const a = at(map.pills, 1)
    const b = at(map.pills, 2)
    expect(b.x).toBe(a.x)
    expect(b.y - (a.y + a.h)).toBe(22)
    const chip = map.chips[0]
    expect(chip.y + chip.h).toBeLessThan(a.y)
    expect(map.chips[1].y).toBeGreaterThan(at(map.pills, 3).y)
  })

  it('顺连前置边从下缘连到下一胶囊上缘', () => {
    const e = map.edges.find((x) => x.source === 1 && x.target === 2)
    expect(e).toBeTruthy()
    const a = at(map.pills, 1)
    const b = at(map.pills, 2)
    expect(start(e!.d)).toEqual([a.x + a.w / 2, a.y + a.h])
    expect(end(e!.d)).toEqual([b.x + b.w / 2, b.y])
    expect(nums(e!.d)[0]).toBeGreaterThan(0)
  })

  it('跨模块前置边走右侧通道并回到目标右缘', () => {
    const e = map.edges.find((x) => x.source === 3 && x.target === 4)
    expect(e).toBeTruthy()
    const a = at(map.pills, 3)
    const b = at(map.pills, 4)
    expect(start(e!.d)).toEqual([a.x + a.w, a.y + a.h / 2])
    expect(end(e!.d)).toEqual([b.x + b.w, b.y + b.h / 2])
    const maxX = Math.max(...nums(e!.d))
    expect(maxX).toBeGreaterThan(b.x + b.w + 20)
    expect(maxX).toBeLessThanOrEqual(map.world.w)
  })

  it('相关边与前置边使用不同通道', () => {
    const rel = map.edges.find((x) => x.source === 1 && x.target === 3)
    const pre = map.edges.find((x) => x.source === 3 && x.target === 4)
    expect(Math.max(...nums(rel!.d))).toBeLessThan(Math.max(...nums(pre!.d)))
  })

  it('边 key 唯一', () => {
    const keys = new Set(map.edges.map((e) => e.key))
    expect(keys.size).toBe(map.edges.length)
  })

  it('画布包住所有胶囊', () => {
    for (const p of map.pills.values()) {
      expect(p.x + p.w).toBeLessThanOrEqual(map.world.w)
      expect(p.y + p.h).toBeLessThanOrEqual(map.world.h)
    }
  })
})

describe('fitView', () => {
  it('窄屏纵向：按宽适配、顶部对齐', () => {
    const view = fitView({ w: 400, h: 3000 }, { w: 200, h: 600 }, 'vertical')
    expect(view.w).toBeCloseTo(432)
    expect(view.x).toBeCloseTo(-16)
    expect(view.y).toBe(-16)
    expect(view.h).toBeCloseTo((600 * 432) / 200)
  })

  it('宽屏横向：整体适配且居中，不放大超过 1', () => {
    const view = fitView({ w: 1000, h: 400 }, { w: 2000, h: 1200 }, 'horizontal')
    expect(view.w).toBe(2000)
    expect(view.h).toBe(1200)
    expect(view.x).toBeCloseTo(-500)
    expect(view.y).toBeCloseTo(-400)
  })
})
