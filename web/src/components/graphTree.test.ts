import { describe, expect, it } from 'vitest'

import type { GraphEdge, GraphNode } from '../api'
import { fitView, layoutMindMap, moduleOrder } from '../graph/layout'
import {
  DIM_FOCUS,
  DIM_MODULE,
  DIM_MODULE_EDGE,
  DIM_SELECTION,
  MAX_VIEW_MS,
  MAX_VIEW_W,
  MIN_VIEW_MS,
  MIN_VIEW_W,
  buildModuleTree,
  centerViewOnMinimap,
  centerViewOnRect,
  clamp01,
  clampView,
  collapseAll,
  conceptFocus,
  conceptPosition,
  dragViewOnMinimap,
  easeOutCubic,
  edgeOpacity,
  expandAll,
  expandModule,
  filterTree,
  focusIds,
  hiddenCount,
  learningOrder,
  lerpView,
  mapRectToMinimap,
  minimapLayout,
  minimapPointToWorld,
  moduleProblemCount,
  nodeOpacity,
  panByWorldDelta,
  prefersReducedMotion,
  projectRect,
  sanitizeView,
  scrollFractions,
  scrollableAxes,
  setZoomWidth,
  stepConcept,
  toggleModule,
  viewContains,
  viewDistance,
  viewFrame,
  viewTransitionMs,
  visibleNodeIds,
  visibleNodes,
  withScrollFraction,
  zoomedView,
} from './graphTree'

function node(
  id: number,
  name: string,
  module: string,
  order: number,
  description = '',
  problems = 0,
): GraphNode {
  return {
    id,
    name,
    description,
    module,
    order,
    material_id: null,
    material: '',
    page: 0,
    problems: Array.from({ length: problems }, (_, i) => ({
      id: id * 100 + i,
      number: `题${i + 1}`,
      material: '课件',
    })),
  }
}

// 刻意让 id 顺序与学习顺序不一致，用来验证「不按名字/ id 重排」
const NODES = [
  node(7, 'KCL', '电路基础', 1, '基尔霍夫电流定律'),
  node(2, '电阻', '电路基础', 0, '', 2),
  node(5, '戴维南定理', '动态电路', 3, '等效电源'),
  node(9, '一阶电路', '动态电路', 2),
  node(11, '拉普拉斯变换', '复频域分析', 4),
]

const TREE = buildModuleTree(NODES)

describe('buildModuleTree', () => {
  it('模块按学习顺序排列，概念按 order 排列', () => {
    expect(TREE.map((t) => t.module)).toEqual(['电路基础', '动态电路', '复频域分析'])
    expect(TREE[0].concepts.map((c) => c.id)).toEqual([2, 7])
    expect(TREE[1].concepts.map((c) => c.id)).toEqual([9, 5])
  })

  it('不做基于名称的二次排序', () => {
    // 「一阶电路」order=2 在「戴维南定理」order=3 之前，尽管拼音/笔画顺序相反
    expect(TREE[1].concepts.map((c) => c.name)).toEqual(['一阶电路', '戴维南定理'])
  })

  it('记录模块概念总数与每题数', () => {
    expect(TREE[0].count).toBe(2)
    expect(TREE[0].concepts[0].problemCount).toBe(2)
    expect(TREE[1].concepts[0].problemCount).toBe(0)
  })

  it('空图返回空树', () => {
    expect(buildModuleTree([])).toEqual([])
  })

  it('概念携带所属模块，便于侧栏渲染', () => {
    expect(TREE[2].concepts[0].module).toBe('复频域分析')
    expect(TREE[2].concepts[0].description).toBe('')
  })

  it('模块顺序与布局的 moduleOrder 一致（order 相同时也不按 id 重排）', () => {
    const tied = [node(10, 'A1', '模块甲', 5), node(3, 'B1', '模块乙', 5), node(20, 'A2', '模块甲', 6)]
    expect(buildModuleTree(tied).map((t) => t.module)).toEqual(moduleOrder(tied))
    expect(buildModuleTree(tied).map((t) => t.module)).toEqual(['模块甲', '模块乙'])
  })
})

describe('折叠状态', () => {
  it('toggleModule 切换且不修改入参', () => {
    const base = new Set(['电路基础'])
    const added = toggleModule(base, '动态电路')
    expect([...added].sort()).toEqual(['动态电路', '电路基础'])
    const removed = toggleModule(base, '电路基础')
    expect([...removed]).toEqual([])
    expect([...base]).toEqual(['电路基础'])
  })

  it('expandModule 展开指定模块，重复展开是幂等的', () => {
    const base = new Set(['电路基础', '动态电路'])
    expect([...expandModule(base, '电路基础')]).toEqual(['动态电路'])
    expect([...expandModule(base, '不存在的模块')].sort()).toEqual(['动态电路', '电路基础'])
  })

  it('全部收起 / 全部展开', () => {
    expect([...collapseAll(['a', 'b'])]).toEqual(['a', 'b'])
    expect([...expandAll()]).toEqual([])
  })
})

describe('可见概念', () => {
  it('折叠模块的概念不可见', () => {
    const collapsed = new Set(['电路基础'])
    expect([...visibleNodeIds(NODES, collapsed)].sort((a, b) => a - b)).toEqual([5, 9, 11])
    expect(visibleNodeIds(NODES, new Set()).size).toBe(NODES.length)
  })

  it('visibleNodes 保持原顺序且不改动入参', () => {
    const collapsed = new Set(['动态电路'])
    expect(visibleNodes(NODES, collapsed).map((n) => n.id)).toEqual([7, 2, 11])
    expect(visibleNodes(NODES, new Set()).map((n) => n.id)).toEqual(NODES.map((n) => n.id))
    expect(NODES.map((n) => n.id)).toEqual([7, 2, 5, 9, 11])
  })

  it('hiddenCount 只统计已折叠模块，未折叠时为 0', () => {
    const collapsed = new Set(['电路基础'])
    expect(hiddenCount(NODES, collapsed, '电路基础')).toBe(2)
    expect(hiddenCount(NODES, collapsed, '动态电路')).toBe(0)
    expect(hiddenCount(NODES, new Set(), '电路基础')).toBe(0)
  })
})

describe('filterTree', () => {
  it('无搜索无筛选时返回全部模块与概念', () => {
    const rows = filterTree(TREE, '', '', new Set())
    expect(rows.map((r) => r.module)).toEqual(['电路基础', '动态电路', '复频域分析'])
    expect(rows.map((r) => r.matches)).toEqual([2, 2, 1])
    expect(rows.every((r) => r.open)).toBe(true)
  })

  it('折叠状态反映在 open 上', () => {
    const rows = filterTree(TREE, '', '', new Set(['动态电路']))
    expect(rows.map((r) => r.open)).toEqual([true, false, true])
    expect(rows[1].concepts).toHaveLength(2)
  })

  it('搜索命中概念名（忽略大小写）', () => {
    const rows = filterTree(TREE, 'kcl', '', new Set())
    expect(rows.map((r) => r.module)).toEqual(['电路基础'])
    expect(rows[0].concepts.map((c) => c.name)).toEqual(['KCL'])
    expect(rows[0].matches).toBe(1)
    expect(rows[0].count).toBe(2)
  })

  it('搜索命中描述', () => {
    const rows = filterTree(TREE, '等效电源', '', new Set())
    expect(rows.map((r) => r.module)).toEqual(['动态电路'])
  })

  it('搜索时命中概念的折叠模块自动展开显示，但不修改折叠状态', () => {
    const collapsed = new Set(['电路基础'])
    const rows = filterTree(TREE, 'KCL', '', collapsed)
    expect(rows[0].open).toBe(true)
    expect([...collapsed]).toEqual(['电路基础'])
  })

  it('搜索无结果时返回空行', () => {
    expect(filterTree(TREE, 'zzz', '', new Set())).toEqual([])
  })

  it('模块筛选只保留该模块，可与搜索叠加', () => {
    expect(filterTree(TREE, '', '动态电路', new Set()).map((r) => r.module)).toEqual(['动态电路'])
    expect(filterTree(TREE, 'KCL', '动态电路', new Set())).toEqual([])
    expect(filterTree(TREE, 'KCL', '电路基础', new Set())[0].matches).toBe(1)
  })
})

describe('sanitizeView / clampView', () => {
  it('视窗宽高永远为正', () => {
    const v = sanitizeView({ x: Number.NaN, y: Number.NaN, w: 0, h: -5 })
    expect(Number.isFinite(v.x)).toBe(true)
    expect(Number.isFinite(v.y)).toBe(true)
    expect(v.w).toBeGreaterThan(0)
    expect(v.h).toBeGreaterThan(0)
  })

  it('视窗被夹取在世界范围内', () => {
    const world = { w: 1000, h: 500 }
    expect(clampView({ x: 0, y: 0, w: 400, h: 300 }, world)).toEqual({ x: 0, y: 0, w: 400, h: 300 })
    expect(clampView({ x: -500, y: 9999, w: 400, h: 300 }, world)).toEqual({
      x: -16,
      y: 216,
      w: 400,
      h: 300,
    })
  })

  it('视窗比世界大时居中，不产生失控坐标', () => {
    expect(clampView({ x: 0, y: 0, w: 2000, h: 1200 }, { w: 1000, h: 500 })).toEqual({
      x: -500,
      y: -350,
      w: 2000,
      h: 1200,
    })
  })

  it('世界为空（0×0）时仍返回有限数值', () => {
    const v = clampView({ x: 0, y: 0, w: 300, h: 200 }, { w: 0, h: 0 })
    expect(Number.isFinite(v.x)).toBe(true)
    expect(Number.isFinite(v.y)).toBe(true)
    expect(v.x).toBe(-150)
    expect(v.y).toBe(-100)
  })
})

describe('平移与缩放', () => {
  const world = { w: 1000, h: 500 }

  it('panByWorldDelta 平移并夹取', () => {
    expect(panByWorldDelta({ x: 100, y: 50, w: 400, h: 300 }, world, 100, 100)).toEqual({
      x: 200,
      y: 150,
      w: 400,
      h: 300,
    })
    expect(panByWorldDelta({ x: 100, y: 50, w: 400, h: 300 }, world, 99999, 99999)).toEqual({
      x: 616,
      y: 216,
      w: 400,
      h: 300,
    })
    expect(panByWorldDelta({ x: 100, y: 50, w: 400, h: 300 }, world, Number.NaN, Number.NaN)).toEqual({
      x: 100,
      y: 50,
      w: 400,
      h: 300,
    })
  })

  it('zoomedView 保持宽高比与锚点位置', () => {
    const v = zoomedView({ x: 0, y: 0, w: 800, h: 600 }, 1.25, { x: 0, y: 0 })
    expect(v).toEqual({ x: 0, y: 0, w: 1000, h: 750 })
    const centered = zoomedView({ x: 0, y: 0, w: 800, h: 600 }, 1.25)
    expect(centered.x).toBeCloseTo(-100, 6)
    expect(centered.y).toBeCloseTo(-75, 6)
    expect(centered.h / centered.w).toBeCloseTo(0.75, 6)
  })

  it('缩放被夹取在合理范围，非法倍率不生效', () => {
    expect(zoomedView({ x: 0, y: 0, w: 800, h: 600 }, 100).w).toBe(MAX_VIEW_W)
    const tiny = zoomedView({ x: 0, y: 0, w: 800, h: 600 }, 0.0001)
    expect(tiny.w).toBe(MIN_VIEW_W)
    expect(tiny.h).toBeGreaterThan(0)
    expect(zoomedView({ x: 0, y: 0, w: 800, h: 600 }, 0).w).toBe(800)
    expect(zoomedView({ x: 0, y: 0, w: 0, h: 0 }, 2).w).toBeGreaterThan(0)
  })

  it('传入世界时缩放结果也被夹取', () => {
    const v = zoomedView({ x: 0, y: 0, w: 400, h: 300 }, 0.5, { x: 0.5, y: 0.5 }, { w: 400, h: 300 })
    expect(v).toEqual({ x: 80, y: 60, w: 240, h: 180 })
  })

  it('setZoomWidth 按绝对宽度缩放并保持宽高比', () => {
    const v = setZoomWidth({ x: 100, y: 100, w: 800, h: 600 }, 1600)
    expect(v).toEqual({ x: -300, y: -200, w: 1600, h: 1200 })
    const capped = setZoomWidth({ x: 100, y: 100, w: 800, h: 600 }, 10000)
    expect(capped.w).toBe(MAX_VIEW_W)
    expect(capped.h / capped.w).toBeCloseTo(0.75, 6)
    expect(setZoomWidth({ x: 100, y: 100, w: 800, h: 600 }, Number.NaN).w).toBe(800)
  })
})

describe('滚动条滑块', () => {
  const world = { w: 1000, h: 2000 }

  it('归一化偏移落在 0~1', () => {
    const f = scrollFractions({ x: 0, y: 0, w: 1000, h: 500 }, world)
    expect(f.x).toBeCloseTo(0.5, 6)
    expect(f.y).toBeCloseTo(16 / 1532, 6)
    const atMax = scrollFractions({ x: 16, y: 1516, w: 1000, h: 500 }, world)
    expect(atMax.x).toBeCloseTo(1, 6)
    expect(atMax.y).toBeCloseTo(1, 6)
  })

  it('世界比视窗小时不产生 NaN 或越界', () => {
    const f = scrollFractions({ x: 0, y: 0, w: 2000, h: 2000 }, { w: 100, h: 100 })
    expect(f).toEqual({ x: 0, y: 0 })
  })

  it('withScrollFraction 与 scrollFractions 互为逆运算', () => {
    const start = { x: 0, y: 0, w: 1000, h: 500 }
    const mid = withScrollFraction(start, world, 'y', 0.4)
    expect(scrollFractions(mid, world).y).toBeCloseTo(0.4, 6)
    expect(withScrollFraction(start, world, 'x', 0)).toEqual({ x: -16, y: 0, w: 1000, h: 500 })
    expect(withScrollFraction(start, world, 'x', 1).x).toBe(16)
    expect(withScrollFraction(start, world, 'y', 5).y).toBe(1516)
    expect(withScrollFraction(start, world, 'y', -5).y).toBe(-16)
    expect(withScrollFraction(start, world, 'y', Number.NaN).y).toBe(-16)
  })

  it('无可滚动余量时轴向被标记为不可滚动', () => {
    expect(scrollableAxes({ x: 0, y: 0, w: 1000, h: 500 }, world)).toEqual({ x: false, y: true })
    expect(scrollableAxes({ x: 0, y: 0, w: 400, h: 300 }, world)).toEqual({ x: true, y: true })
  })
})

describe('缩略图布局', () => {
  const world = { w: 1000, h: 400 }
  const view = { x: 0, y: 0, w: 500, h: 200 }
  const size = { w: 200, h: 200 }

  it('世界与视窗按同一比例映射', () => {
    const mm = minimapLayout(world, view, size)
    expect(mm.ready).toBe(true)
    expect(mm.scale).toBeCloseTo(0.2, 6)
    expect(mm.worldRect).toEqual({ x: 0, y: 60, w: 200, h: 80 })
    expect(mm.viewRect).toEqual({ x: 0, y: 60, w: 100, h: 40 })
    const pill = mapRectToMinimap(mm, { x: 500, y: 100, w: 100, h: 34 })
    expect(pill.x).toBeCloseTo(100, 6)
    expect(pill.y).toBeCloseTo(80, 6)
    expect(pill.w).toBeCloseTo(20, 6)
    expect(pill.h).toBeCloseTo(6.8, 6)
  })

  it('世界比视窗小时视窗矩形与内容都在缩略图内', () => {
    const mm = minimapLayout({ w: 200, h: 100 }, { x: -16, y: -16, w: 900, h: 600 }, size)
    expect(mm.ready).toBe(true)
    for (const r of [mm.worldRect, mm.viewRect]) {
      for (const n of [r.x, r.y, r.w, r.h]) expect(Number.isFinite(n)).toBe(true)
      expect(r.x).toBeGreaterThanOrEqual(0)
      expect(r.y).toBeGreaterThanOrEqual(0)
      expect(r.x + r.w).toBeLessThanOrEqual(size.w + 1e-6)
      expect(r.y + r.h).toBeLessThanOrEqual(size.h + 1e-6)
    }
    expect(mm.worldRect.w).toBeGreaterThan(0)
  })

  it('空世界（0×0）不产生 NaN', () => {
    const mm = minimapLayout({ w: 0, h: 0 }, { x: 0, y: 0, w: 900, h: 600 }, { w: 180, h: 120 })
    expect(mm.ready).toBe(true)
    expect(mm.worldRect.w).toBe(0)
    expect(Number.isFinite(mm.worldRect.x)).toBe(true)
    expect(Number.isFinite(mm.viewRect.w)).toBe(true)
    expect(mm.viewRect.w).toBeGreaterThan(0)
  })

  it('缩略图尺寸为 0 时不可交互且全为 0', () => {
    const mm = minimapLayout(world, view, { w: 0, h: 0 })
    expect(mm.ready).toBe(false)
    expect(mm.scale).toBe(0)
    expect(mm.worldRect).toEqual({ x: 0, y: 0, w: 0, h: 0 })
    expect(mm.viewRect).toEqual({ x: 0, y: 0, w: 0, h: 0 })
  })

  it('极端长宽比与非法输入下所有坐标有限', () => {
    const mm = minimapLayout({ w: 100000, h: 10 }, view, { w: 180, h: 120 })
    expect(Number.isFinite(mm.worldRect.h)).toBe(true)
    expect(mm.worldRect.w).toBeCloseTo(180, 6)
    const nan = minimapLayout(
      { w: Number.NaN, h: Number.NaN },
      { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
      { w: 180, h: 120 },
    )
    expect(nan.ready).toBe(true)
    for (const n of [nan.scale, nan.viewRect.x, nan.viewRect.w, nan.worldRect.y, nan.offset.y]) {
      expect(Number.isFinite(n)).toBe(true)
    }
  })

  it('坐标互转：缩略图点 → 世界点被夹取在内容范围内', () => {
    const mm = minimapLayout(world, view, size)
    const p = minimapPointToWorld(mm, { x: 100, y: 100 })
    expect(p.x).toBeCloseTo(500, 6)
    expect(p.y).toBeCloseTo(200, 6)
    // 落在等比缩放的空白边上 → 取最近的内容边缘，而不是失控坐标
    expect(minimapPointToWorld(mm, { x: -50, y: -50 })).toEqual({ x: 0, y: 0 })
    const far = minimapPointToWorld(mm, { x: 500, y: 500 })
    expect(far.x).toBeCloseTo(1000, 6)
    expect(far.y).toBeCloseTo(400, 6)
  })

  it('不可交互时坐标互转返回内容原点', () => {
    const mm = minimapLayout(world, view, { w: 0, h: 0 })
    const p = minimapPointToWorld(mm, { x: 50, y: 50 })
    expect(p).toEqual({ x: mm.content.x, y: mm.content.y })
    expect(Number.isFinite(p.x)).toBe(true)
  })
})

describe('缩略图交互', () => {
  const world = { w: 1000, h: 400 }
  const view = { x: 0, y: 0, w: 500, h: 200 }
  const size = { w: 200, h: 200 }
  const mm = minimapLayout(world, view, size)

  it('点击把视窗中心移到该点', () => {
    const next = centerViewOnMinimap(mm, world, view, { x: 150, y: 100 })
    expect(next).toEqual({ x: 500, y: 100, w: 500, h: 200 })
  })

  it('点击边缘时视窗被夹取在世界内', () => {
    expect(centerViewOnMinimap(mm, world, view, { x: 0, y: 0 })).toEqual({
      x: -16,
      y: -16,
      w: 500,
      h: 200,
    })
    const right = centerViewOnMinimap(mm, world, view, { x: 200, y: 200 })
    expect(right.x).toBe(516)
    expect(right.y).toBe(216)
  })

  it('拖动按比例换算为世界平移', () => {
    const next = dragViewOnMinimap(mm, world, { x: 100, y: 50, w: 500, h: 200 }, { x: 100, y: 100 }, { x: 120, y: 100 })
    expect(next).toEqual({ x: 200, y: 50, w: 500, h: 200 })
    const clamped = dragViewOnMinimap(mm, world, { x: 100, y: 50, w: 500, h: 200 }, { x: 100, y: 100 }, { x: 0, y: 100 })
    expect(clamped.x).toBe(-16)
  })

  it('不可交互时不改变视窗（仅夹取、保持有限）', () => {
    const dead = minimapLayout(world, view, { w: 0, h: 0 })
    expect(centerViewOnMinimap(dead, world, view, { x: 60, y: 60 })).toEqual(view)
    expect(dragViewOnMinimap(dead, world, view, { x: 0, y: 0 }, { x: 60, y: 60 })).toEqual(view)
  })

  it('任意极端输入都不会产生 NaN 或非正宽高', () => {
    const cases = [
      { w: 0, h: 0 },
      { w: 100000, h: 1 },
      { w: 1, h: 100000 },
    ]
    for (const shape of cases) {
      const layout = minimapLayout(shape, { x: -9999, y: -9999, w: 1, h: 1 }, size)
      const next = centerViewOnMinimap(layout, shape, { x: 0, y: 0, w: 1, h: 1 }, { x: 199, y: 199 })
      for (const n of [next.x, next.y, next.w, next.h]) expect(Number.isFinite(n)).toBe(true)
      expect(next.w).toBeGreaterThan(0)
      expect(next.h).toBeGreaterThan(0)
    }
  })
})

describe('集成：长图谱折叠后确实变短', () => {
  const N = 12
  const PER_MODULE = 20
  const MANY: GraphNode[] = []
  let order = 0
  for (let m = 0; m < N; m += 1) {
    for (let c = 0; c < PER_MODULE; c += 1) {
      MANY.push(node(m * 100 + c, `概念${m}-${c}`, `模块${m}`, order))
      order += 1
    }
  }
  const MANY_EDGES: GraphEdge[] = []
  for (let i = 0; i + 1 < MANY.length; i += 1) {
    if (MANY[i].module === MANY[i + 1].module) {
      MANY_EDGES.push({ source: MANY[i].id, target: MANY[i + 1].id, relation: 'prerequisite', note: '' })
    }
  }
  const manyTree = buildModuleTree(MANY)
  const allCollapsed = collapseAll(manyTree.map((t) => t.module))
  const full = layoutMindMap(MANY, MANY_EDGES, 'vertical')
  const packed = layoutMindMap(MANY, MANY_EDGES, 'vertical', { collapsedModules: allCollapsed })

  it('目录按学习顺序给出 12 个模块 × 20 个概念', () => {
    expect(manyTree).toHaveLength(N)
    expect(manyTree.map((t) => t.module)).toEqual(moduleOrder(MANY))
    expect(manyTree.every((t) => t.count === PER_MODULE)).toBe(true)
    expect(manyTree[3].concepts.map((c) => c.name)).toEqual(
      Array.from({ length: PER_MODULE }, (_, i) => `概念3-${i}`),
    )
  })

  it('全部收起只剩 12 个模块签，高度大幅下降且没有悬挂边', () => {
    expect(full.pills.size).toBe(N * PER_MODULE)
    expect(full.edges).toHaveLength(MANY_EDGES.length)
    expect(packed.pills.size).toBe(0)
    expect(packed.edges).toEqual([])
    expect(packed.chips).toHaveLength(N)
    expect(packed.chips.every((c) => c.collapsed === true && c.count === PER_MODULE)).toBe(true)
    expect(packed.world.h).toBeLessThan(full.world.h / 5)
  })

  it('逐个展开 12 个模块，每一步布局都有限且边不悬挂', () => {
    let current = allCollapsed
    for (const module of manyTree.map((t) => t.module)) {
      current = toggleModule(current, module)
      const map = layoutMindMap(MANY, MANY_EDGES, 'vertical', { collapsedModules: current })
      expect(map.world.w).toBeGreaterThan(0)
      expect(Number.isFinite(map.world.h)).toBe(true)
      expect(map.edges.every((e) => map.pills.has(e.source) && map.pills.has(e.target))).toBe(true)
    }
    expect(current.size).toBe(0)
    expect(layoutMindMap(MANY, MANY_EDGES, 'vertical', { collapsedModules: current }).pills.size).toBe(
      N * PER_MODULE,
    )
  })

  it('收起状态下缩略图仍然可用且矩形不越界', () => {
    const view = fitView(packed.world, { w: 900, h: 600 }, 'vertical')
    const mm = minimapLayout(packed.world, view, { w: 180, h: 126 })
    expect(mm.ready).toBe(true)
    for (const n of [mm.viewRect.x, mm.viewRect.y, mm.viewRect.w, mm.viewRect.h]) {
      expect(Number.isFinite(n)).toBe(true)
    }
    expect(mm.viewRect.x + mm.viewRect.w).toBeLessThanOrEqual(180 + 1e-6)
    expect(mm.viewRect.y + mm.viewRect.h).toBeLessThanOrEqual(126 + 1e-6)
    const rows = filterTree(manyTree, '', '', allCollapsed)
    expect(rows.every((r) => !r.open)).toBe(true)
    expect(filterTree(manyTree, '概念7-', '', allCollapsed)[0].module).toBe('模块7')
  })
})

// ---------------------------------------------------------------------------
// v0.11 图谱精修
// ---------------------------------------------------------------------------

function edge(source: number, target: number, relation = 'prerequisite'): GraphEdge {
  return { source, target, relation, note: '' }
}

describe('视窗动画', () => {
  const from = { x: 0, y: 0, w: 400, h: 300 }
  const far = { x: 600, y: 400, w: 400, h: 300 }
  const near = { x: 20, y: 0, w: 400, h: 300 }

  it('easeOutCubic 端点正确、单调且夹取到 0~1', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 6)
    expect(easeOutCubic(-3)).toBe(0)
    expect(easeOutCubic(9)).toBe(1)
    expect(easeOutCubic(0.25)).toBeLessThan(easeOutCubic(0.5))
    expect(clamp01(Number.NaN)).toBe(0)
    expect(clamp01(2)).toBe(1)
  })

  it('viewDistance：相同为 0，位移/缩放越大越接近 1', () => {
    expect(viewDistance(from, { ...from })).toBe(0)
    expect(viewDistance(from, near)).toBeGreaterThan(0)
    expect(viewDistance(from, far)).toBeGreaterThan(viewDistance(from, near))
    expect(viewDistance(from, far)).toBeLessThanOrEqual(1)
    // 仅缩放也会产生距离
    expect(viewDistance(from, { x: 0, y: 0, w: 4000, h: 3000 })).toBeGreaterThan(0)
    // 非法输入不产生 NaN
    const nan = viewDistance(
      { x: Number.NaN, y: Number.NaN, w: 0, h: 0 },
      { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
    )
    expect(Number.isFinite(nan)).toBe(true)
    expect(nan).toBeGreaterThanOrEqual(0)
  })

  it('viewTransitionMs：减少动效或无需移动时为 0，否则落在 [MIN, MAX]', () => {
    expect(viewTransitionMs(from, { ...from })).toBe(0)
    expect(viewTransitionMs(from, far, true)).toBe(0)
    const small = viewTransitionMs(from, near)
    const big = viewTransitionMs(from, far)
    expect(small).toBeGreaterThanOrEqual(MIN_VIEW_MS)
    expect(small).toBeLessThanOrEqual(MAX_VIEW_MS)
    expect(big).toBe(MAX_VIEW_MS)
    expect(big).toBeGreaterThan(small)
  })

  it('lerpView 端点精确、中点按缓出曲线、结果夹取在世界内', () => {
    expect(lerpView(from, far, 0)).toEqual(from)
    expect(lerpView(from, far, 1)).toEqual(far)
    expect(lerpView(from, far, 0.5).x).toBeCloseTo(600 * 0.875, 6)
    const clamped = lerpView(from, far, 0.5, { w: 400, h: 300 })
    expect(clamped).toEqual({ x: 16, y: 16, w: 400, h: 300 })
  })

  it('viewFrame 按时长推进并标记结束', () => {
    const start = viewFrame(from, far, 0, 320)
    expect(start.progress).toBe(0)
    expect(start.done).toBe(false)
    expect(start.view).toEqual(from)
    const mid = viewFrame(from, far, 160, 320)
    expect(mid.progress).toBeCloseTo(0.5, 6)
    expect(mid.done).toBe(false)
    expect(mid.view.x).toBeGreaterThan(from.x)
    expect(mid.view.x).toBeLessThan(far.x)
    const end = viewFrame(from, far, 5000, 320)
    expect(end.done).toBe(true)
    expect(end.progress).toBe(1)
    expect(end.view).toEqual(far)
    // 负时间按起点处理
    expect(viewFrame(from, far, -50, 320).view).toEqual(from)
  })

  it('viewFrame 在无动画（时长 0 / 非法时长）时直接给出目标', () => {
    for (const duration of [0, -10, Number.NaN]) {
      const frame = viewFrame(from, far, 0, duration)
      expect(frame.done).toBe(true)
      expect(frame.progress).toBe(1)
      expect(frame.view).toEqual(far)
    }
  })

  it('prefersReducedMotion 在没有 window 的环境下安全返回 false', () => {
    expect(prefersReducedMotion()).toBe(false)
  })
})

describe('概念聚焦与强调', () => {
  const EDGES = [
    edge(1, 2),
    edge(1, 3, 'related'),
    edge(4, 1),
    edge(1, 1),
    edge(2, 3, 'related'),
  ]

  it('conceptFocus 分出前置 / 后续 / 相关，忽略自环', () => {
    const focus = conceptFocus(EDGES, 1)
    expect(focus.id).toBe(1)
    expect(focus.next).toEqual([2])
    expect(focus.prerequisites).toEqual([4])
    expect(focus.related).toEqual([3])
    expect(focus.neighbors).toEqual([2, 3, 4])
  })

  it('conceptFocus 双向合并相关边并在邻居里去重', () => {
    const focus = conceptFocus([...EDGES, edge(3, 1, 'related'), edge(2, 1, 'related')], 1)
    expect(focus.next).toEqual([2])
    expect(focus.related).toEqual([2, 3])
    expect(focus.prerequisites).toEqual([4])
    expect(focus.neighbors).toEqual([2, 3, 4])
  })

  it('conceptFocus 对孤立概念与非 prerequisite 关系都成立', () => {
    expect(conceptFocus(EDGES, 999)).toEqual({
      id: 999,
      prerequisites: [],
      next: [],
      related: [],
      neighbors: [],
    })
    const onlyRelated = conceptFocus([edge(7, 8, 'related')], 7)
    expect(onlyRelated.related).toEqual([8])
    expect(onlyRelated.next).toEqual([])
  })

  it('focusIds 包含焦点与一圈邻居', () => {
    const ids = focusIds(conceptFocus(EDGES, 1))
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4])
  })

  it('nodeOpacity：模块筛选 > 聚焦模式 > 仅选中的轻微压暗', () => {
    const self = { moduleMatch: true, selected: true, neighbor: false }
    const neighbor = { moduleMatch: true, selected: false, neighbor: true }
    const other = { moduleMatch: true, selected: false, neighbor: false }
    const filtered = { moduleMatch: false, selected: true, neighbor: false }

    expect(nodeOpacity(other, false, false)).toBe(1)
    expect(nodeOpacity(other, false, true)).toBe(DIM_SELECTION)
    expect(nodeOpacity(self, false, true)).toBe(1)
    expect(nodeOpacity(neighbor, false, true)).toBe(1)
    expect(nodeOpacity(other, true, true)).toBe(DIM_FOCUS)
    expect(nodeOpacity(self, true, true)).toBe(1)
    expect(nodeOpacity(neighbor, true, true)).toBe(1)
    expect(nodeOpacity(filtered, false, false)).toBe(DIM_MODULE)
    expect(nodeOpacity(filtered, true, true)).toBe(DIM_MODULE)
  })

  it('edgeOpacity：模块筛选优先，聚焦时圈内保留、圈外压到最低', () => {
    const active = { moduleMatch: true, active: true, inFocus: true }
    const idle = { moduleMatch: true, active: false, inFocus: false }
    const inside = { moduleMatch: true, active: false, inFocus: true }
    const filtered = { moduleMatch: false, active: true, inFocus: true }

    expect(edgeOpacity(idle, false, false)).toBe(1)
    expect(edgeOpacity(active, false, true)).toBe(1)
    expect(edgeOpacity(idle, false, true)).toBe(0.3)
    expect(edgeOpacity(inside, true, true)).toBe(1)
    expect(edgeOpacity(idle, true, true)).toBe(0.08)
    expect(edgeOpacity(filtered, false, false)).toBe(DIM_MODULE_EDGE)
    expect(edgeOpacity(filtered, true, true)).toBe(DIM_MODULE_EDGE)
  })
})

describe('视窗定位', () => {
  const view = { x: 0, y: 0, w: 900, h: 600 }
  const world = { w: 2000, h: 1200 }

  it('viewContains 判断目标是否已带舒适边距落在视窗内', () => {
    expect(viewContains(view, { x: 100, y: 100, w: 120, h: 34 })).toBe(true)
    expect(viewContains(view, { x: 850, y: 100, w: 120, h: 34 })).toBe(false)
    expect(viewContains(view, { x: 850, y: 100, w: 20, h: 34 })).toBe(true)
    // pad 是「必须留出的舒适边距」，所以要求更严：贴着边不算舒服
    expect(viewContains(view, { x: 840, y: 200, w: 40, h: 34 })).toBe(true)
    expect(viewContains(view, { x: 840, y: 200, w: 40, h: 34 }, 40)).toBe(false)
    expect(viewContains(view, { x: -40, y: 100, w: 20, h: 34 })).toBe(false)
    expect(viewContains(view, { x: 0, y: 0, w: 0, h: 0 })).toBe(true)
  })

  it('centerViewOnRect 把目标居中并夹取在世界内', () => {
    const next = centerViewOnRect(view, { x: 1000, y: 600, w: 100, h: 34 }, world)
    expect(next).toEqual({ x: 600, y: 317, w: 900, h: 600 })
    const edgeCase = centerViewOnRect(view, { x: 0, y: 0, w: 10, h: 10 }, world)
    expect(edgeCase.x).toBe(-16)
    expect(edgeCase.y).toBe(-16)
    // 世界很大时能把远处的概念拉到正中
    const deep = centerViewOnRect(view, { x: 4000, y: 3000, w: 100, h: 100 }, { w: 5000, h: 5000 })
    expect(deep).toEqual({ x: 3600, y: 2750, w: 900, h: 600 })
  })

  it('centerViewOnRect 对非法输入仍返回有限数值', () => {
    const next = centerViewOnRect(
      { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
      { x: Number.NaN, y: Number.NaN, w: Number.NaN, h: Number.NaN },
      { w: Number.NaN, h: Number.NaN },
    )
    for (const n of [next.x, next.y, next.w, next.h]) expect(Number.isFinite(n)).toBe(true)
  })
})

describe('学习顺序遍历', () => {
  const ordered = learningOrder(NODES)

  it('learningOrder 按 order 再按 id，且不修改入参', () => {
    expect(ordered.map((n) => n.id)).toEqual([2, 7, 9, 5, 11])
    expect(NODES.map((n) => n.id)).toEqual([7, 2, 5, 9, 11])
    expect(learningOrder([])).toEqual([])
  })

  it('conceptPosition 给出一基序号与总数', () => {
    expect(conceptPosition(NODES, 2)).toEqual({ index: 1, total: 5 })
    expect(conceptPosition(NODES, 11)).toEqual({ index: 5, total: 5 })
    expect(conceptPosition(NODES, 999)).toBeNull()
    expect(conceptPosition(NODES, null)).toBeNull()
  })

  it('stepConcept 前后移动并在两端返回 null', () => {
    expect(stepConcept(NODES, 2, 1)).toBe(7)
    expect(stepConcept(NODES, 7, -1)).toBe(2)
    expect(stepConcept(NODES, 11, 1)).toBeNull()
    expect(stepConcept(NODES, 2, -1)).toBeNull()
    expect(stepConcept(NODES, 2, 0)).toBe(7)
    expect(stepConcept(NODES, 7, -3)).toBe(2)
  })

  it('stepConcept 未选中时给出一端，空图返回 null', () => {
    expect(stepConcept(NODES, null, 1)).toBe(2)
    expect(stepConcept(NODES, null, -1)).toBe(11)
    expect(stepConcept(NODES, 999, 1)).toBe(2)
    expect(stepConcept([], null, 1)).toBeNull()
    expect(stepConcept([], 3, -1)).toBeNull()
  })
})

describe('模块题目统计', () => {
  it('moduleProblemCount 汇总每个模块的真题数并按题目 id 去重', () => {
    const dup = node(20, 'D', '电路基础', 2, '', 0)
    dup.problems = [
      { id: 501, number: '题1', material: '课件' },
      { id: 502, number: '题2', material: '课件' },
    ]
    const shared = node(21, 'E', '电路基础', 3, '', 0)
    shared.problems = [{ id: 502, number: '题2', material: '课件' }]
    const counts = moduleProblemCount([...NODES, dup, shared])
    // NODES: 电路基础 2 题（id 200/201），动态电路 0 题；再加上去重后的 501、502
    expect(counts.get('电路基础')).toBe(4)
    expect(counts.has('动态电路')).toBe(false)
    expect(counts.has('复频域分析')).toBe(false)
    expect(moduleProblemCount([]).size).toBe(0)
  })
})

describe('缩略图矩形投影', () => {
  const world = { w: 1000, h: 400 }
  const view = { x: 0, y: 0, w: 500, h: 200 }
  const layout = minimapLayout(world, view, { w: 200, h: 200 })

  it('projectRect 与 mapRectToMinimap 结果一致', () => {
    const rect = { x: 500, y: 100, w: 100, h: 34 }
    expect(projectRect(rect, layout.content, layout.offset, layout.scale, layout.box)).toEqual(
      mapRectToMinimap(layout, rect),
    )
  })

  it('零 / 非法比例返回空矩形，越界矩形被夹取在缩略图内', () => {
    expect(projectRect(view, layout.content, layout.offset, 0, layout.box)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    })
    expect(projectRect(view, layout.content, layout.offset, Number.NaN, layout.box).w).toBe(0)
    const outside = projectRect(
      { x: -99999, y: -99999, w: 999999, h: 999999 },
      layout.content,
      layout.offset,
      layout.scale,
      layout.box,
    )
    expect(outside.x).toBe(0)
    expect(outside.y).toBe(0)
    expect(outside.w).toBeLessThanOrEqual(200)
    expect(outside.h).toBeLessThanOrEqual(200)
  })
})
