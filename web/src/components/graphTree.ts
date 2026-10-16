/**
 * 知识图谱导航的纯函数集合：模块层级树、折叠状态、视窗夹取、缩略图映射。
 *
 * 这里的函数不依赖 React，也不产生副作用，便于单元测试；
 * 视窗坐标与 `graph/layout` 的 Size/View 结构兼容（同为 { x, y, w, h }）。
 */
import type { GraphNode } from '../api'

export interface Dims {
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface Rect extends Dims {
  x: number
  y: number
}

/** 折叠的模块名集合。 */
export type CollapsedSet = ReadonlySet<string>

export interface TreeConcept {
  id: number
  name: string
  description: string
  module: string
  order: number
  problemCount: number
}

export interface TreeModule {
  module: string
  /** 该模块下的概念总数（不受搜索影响）。 */
  count: number
  concepts: TreeConcept[]
}

export interface TreeRow extends TreeModule {
  /** 当前搜索命中的概念数。 */
  matches: number
  /** 侧栏中该模块是否展开。 */
  open: boolean
}

export interface MinimapLayout {
  /** 缩略图是否可用于交互（画布尺寸与内容均有效）。 */
  ready: boolean
  /** 世界坐标 → 缩略图坐标的比例。 */
  scale: number
  /** 缩略图覆盖的世界区域（世界范围 ∪ 当前视窗）。 */
  content: Rect
  /** 内容区域左上角在缩略图中的位置。 */
  offset: Point
  /** 缩略图自身的尺寸。 */
  box: Dims
  worldRect: Rect
  viewRect: Rect
}

/** 视窗最小/最大宽度（世界单位），用于限制缩放。 */
export const MIN_VIEW_W = 240
export const MAX_VIEW_W = 3200
/** 视窗在世界之外允许保留的留白，保证不再无限漂移。 */
export const VIEW_MARGIN = 16
export const DEFAULT_VIEW: Rect = { x: 0, y: 0, w: 900, h: 600 }

const EPS = 1e-6
const EMPTY_COLLAPSED: CollapsedSet = new Set<string>()

function finite(n: number, fallback = 0): number {
  return Number.isFinite(n) ? n : fallback
}

function positive(n: number, fallback: number): number {
  return Number.isFinite(n) && n > EPS ? n : fallback
}

function clampNum(n: number, min: number, max: number): number {
  if (max <= min) return (min + max) / 2
  return Math.min(max, Math.max(min, n))
}

// ---------------------------------------------------------------------------
// 模块层级树
// ---------------------------------------------------------------------------

/**
 * 按课程的既定学习顺序（order，其次 id）构建 模块 → 概念 的树。
 * 模块顺序与 `graph/layout` 的 moduleOrder、模块内顺序与 groupByModule 完全一致，
 * 不做基于名称/id 的二次排序，保证课程内容的学习次序不被破坏。
 */
export function buildModuleTree(nodes: GraphNode[]): TreeModule[] {
  const order: string[] = []
  const byModule = new Map<string, GraphNode[]>()
  for (const node of [...nodes].sort((a, b) => a.order - b.order)) {
    let list = byModule.get(node.module)
    if (!list) {
      list = []
      byModule.set(node.module, list)
      order.push(node.module)
    }
    list.push(node)
  }
  for (const list of byModule.values()) {
    list.sort((a, b) => a.order - b.order || a.id - b.id)
  }
  return order.map((module) => {
    const list = byModule.get(module) ?? []
    return {
      module,
      count: list.length,
      concepts: list.map((node) => ({
        id: node.id,
        name: node.name,
        description: node.description,
        module: node.module,
        order: node.order,
        problemCount: node.problems.length,
      })),
    }
  })
}

/** 切换某个模块的折叠状态，返回新集合（不修改入参）。 */
export function toggleModule(collapsed: CollapsedSet, module: string): Set<string> {
  const next = new Set(collapsed)
  if (next.has(module)) next.delete(module)
  else next.add(module)
  return next
}

/** 展开某个模块（选中折叠模块内的概念时使用），返回新集合。 */
export function expandModule(collapsed: CollapsedSet, module: string): Set<string> {
  const next = new Set(collapsed)
  next.delete(module)
  return next
}

/** 全部收起。 */
export function collapseAll(modules: readonly string[]): Set<string> {
  return new Set(modules)
}

/** 全部展开。 */
export function expandAll(): Set<string> {
  return new Set<string>()
}

/** 当前可见（未被折叠）的概念 id 集合。 */
export function visibleNodeIds(nodes: GraphNode[], collapsed: CollapsedSet): Set<number> {
  const ids = new Set<number>()
  for (const node of nodes) {
    if (!collapsed.has(node.module)) ids.add(node.id)
  }
  return ids
}

/** 当前可见的概念（顺序与入参一致，不重排）。 */
export function visibleNodes(nodes: GraphNode[], collapsed: CollapsedSet): GraphNode[] {
  return collapsed.size === 0 ? [...nodes] : nodes.filter((n) => !collapsed.has(n.module))
}

/** 折叠后某个模块隐藏了多少个概念；未折叠时为 0。 */
export function hiddenCount(nodes: GraphNode[], collapsed: CollapsedSet, module: string): number {
  if (!collapsed.has(module)) return 0
  let count = 0
  for (const node of nodes) {
    if (node.module === module) count += 1
  }
  return count
}

/**
 * 按搜索词与模块筛选生成侧栏行。
 * - 搜索命中名称或描述（忽略大小写）；命中为空的概念不显示，模块也无行。
 * - 搜索期间命中的折叠模块会自动展开显示（不修改折叠状态本身）。
 */
export function filterTree(
  tree: TreeModule[],
  query: string,
  moduleFilter: string,
  collapsed: CollapsedSet = EMPTY_COLLAPSED,
): TreeRow[] {
  const q = query.trim().toLowerCase()
  const rows: TreeRow[] = []
  for (const item of tree) {
    if (moduleFilter !== '' && item.module !== moduleFilter) continue
    const concepts = q
      ? item.concepts.filter(
          (c) => c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
        )
      : item.concepts
    if (q !== '' && concepts.length === 0) continue
    // 搜索期间自动展开命中的模块（只影响显示，不改折叠状态）
    rows.push({
      module: item.module,
      count: item.count,
      concepts,
      matches: concepts.length,
      open: !collapsed.has(item.module) || q !== '',
    })
  }
  return rows
}

// ---------------------------------------------------------------------------
// 视窗变换
// ---------------------------------------------------------------------------

/** 修正非法视窗：宽高任何情况下都为正数。 */
export function sanitizeView(view: Rect, fallback: Rect = DEFAULT_VIEW): Rect {
  const fw = positive(fallback.w, 1)
  const fh = positive(fallback.h, 1)
  return {
    x: finite(view.x, 0),
    y: finite(view.y, 0),
    w: positive(view.w, fw),
    h: positive(view.h, fh),
  }
}

function clampAxis(pos: number, size: number, world: number, margin: number): number {
  const span = Number.isFinite(world) && world > 0 ? world : 0
  const min = -margin
  const max = span + margin - size
  return clampNum(pos, min, max)
}

/** 把视窗限制在世界范围内（两侧各留 margin 留白），保证不会漂到看不见的地方。 */
export function clampView(view: Rect, world: Dims, margin = VIEW_MARGIN): Rect {
  const v = sanitizeView(view)
  const ww = Number.isFinite(world.w) && world.w > 0 ? world.w : 0
  const wh = Number.isFinite(world.h) && world.h > 0 ? world.h : 0
  return {
    x: clampAxis(v.x, v.w, ww, margin),
    y: clampAxis(v.y, v.h, wh, margin),
    w: v.w,
    h: v.h,
  }
}

/** 平移视窗（世界单位），并夹取到世界范围。 */
export function panByWorldDelta(
  view: Rect,
  world: Dims,
  dx: number,
  dy: number,
  margin = VIEW_MARGIN,
): Rect {
  const v = sanitizeView(view)
  return clampView({ x: v.x + finite(dx), y: v.y + finite(dy), w: v.w, h: v.h }, world, margin)
}

/**
 * 缩放视窗：保持宽高比，宽度夹取在 [MIN_VIEW_W, MAX_VIEW_W]，
 * anchor 为 0~1 的视窗内相对位置（滚轮缩放时取鼠标位置）。
 */
export function zoomedView(
  view: Rect,
  factor: number,
  anchor: Point = { x: 0.5, y: 0.5 },
  world?: Dims,
  margin = VIEW_MARGIN,
): Rect {
  const v = sanitizeView(view)
  const f = Number.isFinite(factor) && factor > 0 ? factor : 1
  const w = clampNum(v.w * f, MIN_VIEW_W, MAX_VIEW_W)
  const h = Math.max(EPS, v.h * (w / v.w))
  const ax = clampNum(finite(anchor.x, 0.5), 0, 1)
  const ay = clampNum(finite(anchor.y, 0.5), 0, 1)
  const next = { x: v.x + (v.w - w) * ax, y: v.y + (v.h - h) * ay, w, h }
  return world ? clampView(next, world, margin) : next
}

/** 直接设定视窗宽度（缩放下拉/滑块用），以视窗中心为锚点。 */
export function setZoomWidth(view: Rect, width: number, world?: Dims, margin = VIEW_MARGIN): Rect {
  const v = sanitizeView(view)
  const target = Number.isFinite(width) && width > EPS ? width : v.w
  return zoomedView(v, target / v.w, { x: 0.5, y: 0.5 }, world, margin)
}

function axisRange(worldSize: number, viewSize: number, margin: number): { min: number; max: number } {
  const span = Number.isFinite(worldSize) && worldSize > 0 ? worldSize : 0
  return { min: -margin, max: span + margin - viewSize }
}

/** 视窗偏移归一化到 0~1，用于滚动条滑块位置。 */
export function scrollFractions(view: Rect, world: Dims, margin = VIEW_MARGIN): Point {
  const v = clampView(view, world, margin)
  return {
    x: fractionOf(v.x, axisRange(world.w, v.w, margin)),
    y: fractionOf(v.y, axisRange(world.h, v.h, margin)),
  }
}

function fractionOf(pos: number, range: { min: number; max: number }): number {
  if (range.max - range.min <= EPS) return 0
  return clampNum((pos - range.min) / (range.max - range.min), 0, 1)
}

/** 按 0~1 的滑块值设置某个轴向的视窗偏移。 */
export function withScrollFraction(
  view: Rect,
  world: Dims,
  axis: 'x' | 'y',
  fraction: number,
  margin = VIEW_MARGIN,
): Rect {
  const v = sanitizeView(view)
  const f = clampNum(finite(fraction, 0), 0, 1)
  const size = axis === 'x' ? v.w : v.h
  const worldSize = axis === 'x' ? world.w : world.h
  const range = axisRange(worldSize, size, margin)
  const pos = range.max - range.min <= EPS ? (range.min + range.max) / 2 : range.min + f * (range.max - range.min)
  return axis === 'x' ? { ...v, x: pos } : { ...v, y: pos }
}

/** 某个轴向是否还有可滚动的余量（视窗比世界小）。 */
export function scrollableAxes(view: Rect, world: Dims): { x: boolean; y: boolean } {
  const v = sanitizeView(view)
  const ww = Number.isFinite(world.w) && world.w > 0 ? world.w : 0
  const wh = Number.isFinite(world.h) && world.h > 0 ? world.h : 0
  return { x: ww > v.w + EPS, y: wh > v.h + EPS }
}

// ---------------------------------------------------------------------------
// 缩略图
// ---------------------------------------------------------------------------

function clampRectToBox(rect: Rect, box: Dims): Rect {
  const bw = Math.max(0, finite(box.w, 0))
  const bh = Math.max(0, finite(box.h, 0))
  const x = clampNum(finite(rect.x, 0), 0, bw)
  const y = clampNum(finite(rect.y, 0), 0, bh)
  const w = clampNum(finite(rect.w, 0), 0, Math.max(0, bw - x))
  const h = clampNum(finite(rect.h, 0), 0, Math.max(0, bh - y))
  return { x, y, w, h }
}

/**
 * 计算缩略图布局：内容为「世界范围 ∪ 当前视窗」，等比缩放后居中。
 * 世界比视窗小、世界为空、缩略图为 0 尺寸等退化情况都返回有限数值。
 */
export function minimapLayout(world: Dims, view: Rect, size: Dims): MinimapLayout {
  const v = sanitizeView(view)
  const ww = Math.max(0, finite(world.w, 0))
  const wh = Math.max(0, finite(world.h, 0))
  const box: Dims = { w: Math.max(0, finite(size.w, 0)), h: Math.max(0, finite(size.h, 0)) }
  const x0 = Math.min(0, v.x)
  const y0 = Math.min(0, v.y)
  const x1 = Math.max(ww, v.x + v.w)
  const y1 = Math.max(wh, v.y + v.h)
  const content: Rect = {
    x: x0,
    y: y0,
    w: Math.max(EPS, x1 - x0),
    h: Math.max(EPS, y1 - y0),
  }
  const scale =
    box.w > EPS && box.h > EPS ? Math.min(box.w / content.w, box.h / content.h) : 0
  const ready = Number.isFinite(scale) && scale > EPS
  const offset: Point = ready
    ? { x: (box.w - content.w * scale) / 2, y: (box.h - content.h * scale) / 2 }
    : { x: 0, y: 0 }
  const map = (rect: Rect): Rect =>
    ready
      ? clampRectToBox(
          {
            x: offset.x + (rect.x - content.x) * scale,
            y: offset.y + (rect.y - content.y) * scale,
            w: Math.max(0, finite(rect.w, 0)) * scale,
            h: Math.max(0, finite(rect.h, 0)) * scale,
          },
          box,
        )
      : { x: 0, y: 0, w: 0, h: 0 }
  return {
    ready,
    scale: ready ? scale : 0,
    content,
    offset,
    box,
    worldRect: map({ x: 0, y: 0, w: ww, h: wh }),
    viewRect: map({ x: v.x, y: v.y, w: v.w, h: v.h }),
  }
}

/** 世界坐标矩形 → 缩略图坐标矩形（夹取在缩略图内）。 */
export function mapRectToMinimap(layout: MinimapLayout, rect: Rect): Rect {
  if (!layout.ready) return { x: 0, y: 0, w: 0, h: 0 }
  const scale = layout.scale
  return clampRectToBox(
    {
      x: layout.offset.x + (rect.x - layout.content.x) * scale,
      y: layout.offset.y + (rect.y - layout.content.y) * scale,
      w: Math.max(0, finite(rect.w, 0)) * scale,
      h: Math.max(0, finite(rect.h, 0)) * scale,
    },
    layout.box,
  )
}

/** 缩略图坐标点 → 世界坐标点（点与结果都夹取在有效范围内，不会失控）。 */
export function minimapPointToWorld(layout: MinimapLayout, point: Point): Point {
  if (!layout.ready) return { x: layout.content.x, y: layout.content.y }
  const px = clampNum(finite(point.x, 0), 0, layout.box.w)
  const py = clampNum(finite(point.y, 0), 0, layout.box.h)
  // 缩略图等比居中会留出空白边，落在空白处时取最近的内容边缘
  return {
    x: clampNum(
      layout.content.x + (px - layout.offset.x) / layout.scale,
      layout.content.x,
      layout.content.x + layout.content.w,
    ),
    y: clampNum(
      layout.content.y + (py - layout.offset.y) / layout.scale,
      layout.content.y,
      layout.content.y + layout.content.h,
    ),
  }
}

/** 点击缩略图：把视窗中心移到该点（视窗尺寸不变）。 */
export function centerViewOnMinimap(
  layout: MinimapLayout,
  world: Dims,
  view: Rect,
  point: Point,
  margin = VIEW_MARGIN,
): Rect {
  const v = sanitizeView(view)
  if (!layout.ready) return clampView(v, world, margin)
  const p = minimapPointToWorld(layout, point)
  return clampView({ x: p.x - v.w / 2, y: p.y - v.h / 2, w: v.w, h: v.h }, world, margin)
}

/** 在缩略图内拖动：按比例把位移换算成世界坐标平移。 */
export function dragViewOnMinimap(
  layout: MinimapLayout,
  world: Dims,
  startView: Rect,
  from: Point,
  to: Point,
  margin = VIEW_MARGIN,
): Rect {
  if (!layout.ready) return clampView(startView, world, margin)
  const dx = (finite(to.x, 0) - finite(from.x, 0)) / layout.scale
  const dy = (finite(to.y, 0) - finite(from.y, 0)) / layout.scale
  return panByWorldDelta(startView, world, dx, dy, margin)
}
