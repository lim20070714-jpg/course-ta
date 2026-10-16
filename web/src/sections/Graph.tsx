import { useEffect, useMemo, useRef, useState } from 'react'
import type { CourseGraph, GraphNode } from '../api'
import { getCourseGraph, regenerateGraph } from '../api'
import RichText from '../components/RichText'
import {
  DEFAULT_VIEW,
  MAX_VIEW_W,
  MIN_VIEW_W,
  buildModuleTree,
  centerViewOnMinimap,
  clampView,
  collapseAll,
  dragViewOnMinimap,
  expandAll,
  expandModule,
  filterTree,
  mapRectToMinimap,
  minimapLayout,
  panByWorldDelta,
  scrollFractions,
  scrollableAxes,
  setZoomWidth,
  toggleModule,
  visibleNodes,
  withScrollFraction,
  zoomedView,
  type MinimapLayout,
  type Point,
  type Rect,
} from '../components/graphTree'
import { fitView, layoutMindMap, moduleOrder, type Direction, type View } from '../graph/layout'

const MODULE_COLORS = [
  '#2f5bd8',
  '#0f9d76',
  '#c2410c',
  '#7c3aed',
  '#b91c1c',
  '#0e7490',
  '#a16207',
  '#4338ca',
]

const HORIZONTAL_MIN_W = 1080
const MINIMAP = { w: 180, h: 126 }
const PAN_STEP = 0.14

function miniRect(r: Rect): { x: number; y: number; width: number; height: number } {
  return { x: r.x, y: r.y, width: Math.max(0, r.w), height: Math.max(0, r.h) }
}

export default function Graph({
  courseId,
  onJumpMaterial,
  onOpenProblem,
}: {
  courseId: number | null
  onJumpMaterial: (materialId: number, page: number, filename: string) => void
  onOpenProblem: (problemId: number) => void
}) {
  const [graph, setGraph] = useState<CourseGraph | null>(null)
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [moduleFilter, setModuleFilter] = useState('')
  const [panelOpen, setPanelOpen] = useState(false)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set<string>())
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [userView, setUserView] = useState<View | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dirRef = useRef<Direction>('vertical')
  const viewRef = useRef<View>(DEFAULT_VIEW)
  const dragRef = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null)
  const miniRef = useRef<{ layout: MinimapLayout; view: View; point: Point } | null>(null)

  useEffect(() => {
    if (courseId === null) return
    getCourseGraph(courseId)
      .then((g) => {
        setGraph(g)
        setSelected(null)
        setNotice('')
        setPanelOpen(false)
        setUserView(null)
        setCollapsed(new Set<string>())
      })
      .catch((e: Error) => setNotice(e.message))
  }, [courseId])

  useEffect(() => {
    if (courseId === null || graph?.status !== 'generating') return
    const timer = setInterval(() => {
      getCourseGraph(courseId)
        .then(setGraph)
        .catch(() => undefined)
    }, 4000)
    return () => clearInterval(timer)
  }, [courseId, graph?.status])

  const ready = graph?.status === 'ready' && graph.nodes.length > 0
  const modules = useMemo(() => (graph ? moduleOrder(graph.nodes) : []), [graph])
  const moduleIndex = useMemo(() => new Map(modules.map((m, i) => [m, i])), [modules])
  const moduleOf = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n.module])),
    [graph],
  )
  const direction: Direction = size.w >= HORIZONTAL_MIN_W ? 'horizontal' : 'vertical'

  // 折叠状态直接进入布局：收起的模块只留模块签，图形真的变短
  const mind = useMemo(
    () =>
      ready && graph
        ? layoutMindMap(graph.nodes, graph.edges, direction, { collapsedModules: collapsed })
        : null,
    [ready, graph, direction, collapsed],
  )
  const autoView = useMemo(
    () => (mind && size.w > 0 ? fitView(mind.world, size, direction) : null),
    [mind, size, direction],
  )
  const world = mind?.world
  const rawView = userView ?? autoView ?? DEFAULT_VIEW
  const view = useMemo(() => (mind ? clampView(rawView, mind.world) : rawView), [rawView, mind])
  const frac = useMemo(
    () => (mind ? scrollFractions(view, mind.world) : { x: 0, y: 0 }),
    [mind, view],
  )
  const scrollable = useMemo(
    () => (mind ? scrollableAxes(view, mind.world) : { x: false, y: false }),
    [mind, view],
  )
  const mini = useMemo(() => (mind ? minimapLayout(mind.world, view, MINIMAP) : null), [mind, view])

  useEffect(() => {
    viewRef.current = view
  })

  useEffect(() => {
    if (!ready) return
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current
      const factor = e.deltaY < 0 ? 0.86 : 1.16
      const px = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      const py = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
      setUserView(zoomedView(v, factor, { x: px, y: py }, world))
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [ready, world])

  useEffect(() => {
    if (!ready) return
    const svg = svgRef.current
    if (!svg) return
    // 宽屏横向思维导图 / 窄屏竖向大纲自动切换；切换时回到自适应视窗
    const measure = () => {
      const rect = svg.getBoundingClientRect()
      if (rect.width < 40 || rect.height < 40) return
      const w = Math.round(rect.width)
      const h = Math.round(rect.height)
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
      const nextDir: Direction = w >= HORIZONTAL_MIN_W ? 'horizontal' : 'vertical'
      if (nextDir !== dirRef.current) {
        dirRef.current = nextDir
        setUserView(null)
      }
    }
    const timer = setTimeout(measure, 0)
    window.addEventListener('resize', measure)
    return () => {
      clearTimeout(timer)
      window.removeEventListener('resize', measure)
    }
  }, [ready])

  const related = useMemo(() => {
    if (!graph || selected === null) return []
    const byId = new Map(graph.nodes.map((n) => [n.id, n]))
    const rows: { node: GraphNode; relation: string; direction: 'in' | 'out' }[] = []
    for (const edge of graph.edges) {
      if (edge.source === selected) {
        const node = byId.get(edge.target)
        if (node) rows.push({ node, relation: edge.relation, direction: 'out' })
      } else if (edge.target === selected) {
        const node = byId.get(edge.source)
        if (node) rows.push({ node, relation: edge.relation, direction: 'in' })
      }
    }
    return rows
  }, [graph, selected])

  const tree = useMemo(() => (graph ? buildModuleTree(graph.nodes) : []), [graph])
  const rows = useMemo(
    () => filterTree(tree, query, moduleFilter, collapsed),
    [tree, query, moduleFilter, collapsed],
  )
  const visibleCount = useMemo(
    () => (graph ? visibleNodes(graph.nodes, collapsed).length : 0),
    [graph, collapsed],
  )

  const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null
  const colorOf = (module: string) => MODULE_COLORS[(moduleIndex.get(module) ?? 0) % MODULE_COLORS.length]

  async function regenerate() {
    if (courseId === null) return
    try {
      await regenerateGraph(courseId)
      setNotice('')
      setSelected(null)
      setPanelOpen(false)
      setCollapsed(new Set<string>())
      setGraph((g) => (g ? { ...g, status: 'generating', error: '' } : g))
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  /** 选中概念：若它所在的模块已收起，先自动展开，再显示详情。 */
  function selectNode(id: number) {
    const module = moduleOf.get(id)
    if (module !== undefined) setCollapsed((prev) => expandModule(prev, module))
    setSelected(id)
    setPanelOpen(false)
  }

  function toggleModuleCollapsed(module: string) {
    setCollapsed((prev) => toggleModule(prev, module))
  }

  function zoomBy(factor: number) {
    setUserView((prev) => zoomedView(prev ?? view, factor, { x: 0.5, y: 0.5 }, world))
  }

  function onPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (e.button !== 0) return
    dragRef.current = { x: e.clientX, y: e.clientY, view: viewRef.current, moved: false }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = dragRef.current
    const svg = svgRef.current
    if (!drag || !svg) return
    const rect = svg.getBoundingClientRect()
    const dx = ((e.clientX - drag.x) / Math.max(1, rect.width)) * drag.view.w
    const dy = ((e.clientY - drag.y) / Math.max(1, rect.height)) * drag.view.h
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true
    setUserView(
      world
        ? panByWorldDelta(drag.view, world, -dx, -dy)
        : { x: drag.view.x - dx, y: drag.view.y - dy, w: drag.view.w, h: drag.view.h },
    )
  }

  function onPointerUp() {
    const drag = dragRef.current
    dragRef.current = null
    if (drag && !drag.moved) {
      setSelected(null)
      setPanelOpen(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<SVGSVGElement>) {
    const v = viewRef.current
    const box = world
    if (!box) return
    let next: View | null = null
    if (e.key === 'ArrowLeft') next = panByWorldDelta(v, box, -v.w * PAN_STEP, 0)
    else if (e.key === 'ArrowRight') next = panByWorldDelta(v, box, v.w * PAN_STEP, 0)
    else if (e.key === 'ArrowUp') next = panByWorldDelta(v, box, 0, -v.h * PAN_STEP)
    else if (e.key === 'ArrowDown') next = panByWorldDelta(v, box, 0, v.h * PAN_STEP)
    else if (e.key === '+' || e.key === '=') next = zoomedView(v, 0.86, { x: 0.5, y: 0.5 }, box)
    else if (e.key === '-' || e.key === '_') next = zoomedView(v, 1.16, { x: 0.5, y: 0.5 }, box)
    else if (e.key === 'Home') {
      e.preventDefault()
      setUserView(null)
      return
    } else return
    e.preventDefault()
    if (next) setUserView(next)
  }

  function miniPoint(e: React.PointerEvent<SVGSVGElement>): Point {
    const rect = e.currentTarget.getBoundingClientRect()
    const sx = rect.width > 0 ? MINIMAP.w / rect.width : 1
    const sy = rect.height > 0 ? MINIMAP.h / rect.height : 1
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  function onMiniPointerDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!mini || !world) return
    e.preventDefault()
    e.stopPropagation()
    const point = miniPoint(e)
    const inside =
      point.x >= mini.viewRect.x - 2 &&
      point.x <= mini.viewRect.x + mini.viewRect.w + 2 &&
      point.y >= mini.viewRect.y - 2 &&
      point.y <= mini.viewRect.y + mini.viewRect.h + 2
    // 点在视窗框内 → 相对拖动；点在框外 → 先把视窗中心移过去，再继续拖动
    const start = inside ? view : centerViewOnMinimap(mini, world, view, point)
    if (!inside) setUserView(start)
    e.currentTarget.setPointerCapture(e.pointerId)
    miniRef.current = { layout: mini, view: start, point }
  }

  function onMiniPointerMove(e: React.PointerEvent<SVGSVGElement>) {
    const drag = miniRef.current
    if (!drag || !world) return
    setUserView(dragViewOnMinimap(drag.layout, world, drag.view, drag.point, miniPoint(e)))
  }

  function onMiniPointerUp() {
    miniRef.current = null
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程，再上传课件生成知识图谱。</div>
  }

  const zoomValue = Math.round(Math.min(MAX_VIEW_W, Math.max(MIN_VIEW_W, view.w)))
  const zoomMin = Math.min(MIN_VIEW_W, Math.floor(view.w))
  const zoomMax = Math.max(MAX_VIEW_W, Math.ceil(view.w))
  const searching = query.trim() !== ''

  return (
    <div className="lib-page graph-page">
      <aside className={panelOpen ? 'sidebar graph-panel open' : 'sidebar graph-panel'}>
        <div className="section-title">
          课程脉络
          <button className="link" onClick={regenerate} disabled={graph?.status === 'generating'}>
            {graph?.status === 'ready' ? '重新生成' : '生成'}
          </button>
        </div>
        {graph === null && <p className="empty">加载中…</p>}
        {graph?.status === 'generating' && (
          <p className="empty">AI 正在归纳概念与脉络（约 2~4 分钟）…</p>
        )}
        {graph?.status === 'failed' && (
          <p className="summary-error">生成失败：{graph.error || '未知错误'}</p>
        )}
        {ready && (
          <>
            <input
              className="lib-filter"
              placeholder="搜索概念…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="module-legend">
              <button
                className={moduleFilter === '' ? 'legend-item active' : 'legend-item'}
                onClick={() => setModuleFilter('')}
              >
                全部（{graph.nodes.length}）
              </button>
              {modules.map((m) => (
                <button
                  key={m}
                  className={moduleFilter === m ? 'legend-item active' : 'legend-item'}
                  onClick={() => setModuleFilter(moduleFilter === m ? '' : m)}
                >
                  <span className="legend-dot" style={{ background: colorOf(m) }} />
                  {m}
                </button>
              ))}
            </div>
            <div className="graph-tree-tools">
              <span className="graph-tree-summary">
                层级目录 · 显示 {visibleCount}/{graph.nodes.length} 个概念
              </span>
              <button
                className="link"
                onClick={() => setCollapsed(expandAll())}
                disabled={collapsed.size === 0}
              >
                全部展开
              </button>
              <button
                className="link"
                onClick={() => setCollapsed(collapseAll(modules))}
                disabled={collapsed.size === modules.length}
              >
                全部收起
              </button>
            </div>
            <ul className="graph-tree">
              {rows.map((row) => (
                <li key={row.module} className={row.open ? 'graph-tree-module open' : 'graph-tree-module'}>
                  <div className="graph-tree-head">
                    <button
                      className="graph-tree-toggle"
                      onClick={() => toggleModuleCollapsed(row.module)}
                      title={row.open ? `收起「${row.module}」` : `展开「${row.module}」`}
                      aria-expanded={row.open}
                    >
                      {row.open ? '▾' : '▸'}
                    </button>
                    <button
                      className={moduleFilter === row.module ? 'graph-tree-name active' : 'graph-tree-name'}
                      onClick={() => setModuleFilter(moduleFilter === row.module ? '' : row.module)}
                      title={moduleFilter === row.module ? '取消只看该模块' : '只看该模块'}
                    >
                      <span className="legend-dot" style={{ background: colorOf(row.module) }} />
                      <span className="graph-tree-label">{row.module}</span>
                    </button>
                    <span className="graph-tree-count">
                      {searching ? `${row.matches}/${row.count}` : row.count}
                    </span>
                  </div>
                  {row.open && (
                    <ul className="graph-tree-concepts">
                      {row.concepts.map((c) => (
                        <li key={c.id}>
                          <button
                            className={selected === c.id ? 'graph-concept active' : 'graph-concept'}
                            onClick={() => selectNode(c.id)}
                          >
                            <span className="graph-concept-name">{c.name}</span>
                            {c.problemCount > 0 && (
                              <span className="graph-concept-count">{c.problemCount} 题</span>
                            )}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
              {rows.length === 0 && (
                <li className="empty">
                  {moduleFilter ? '当前模块内没有匹配的概念，可切到「全部」查看' : '没有匹配的概念'}
                </li>
              )}
            </ul>
          </>
        )}
      </aside>

      <main className="graph-main">
        {notice && <div className="lib-notice">{notice}</div>}
        {!ready || !mind ? (
          <div className="lib-welcome">
            {graph?.status === 'generating' ? (
              <>
                <h2>正在构建知识图谱</h2>
                <p>AI 会通读这门课的材料总结，归纳核心概念、模块顺序与前置关系，稍后自动刷新。</p>
              </>
            ) : graph?.status === 'failed' ? (
              <>
                <h2>知识图谱生成失败</h2>
                <p>{graph.error || '未知错误'}</p>
                <button className="mini" onClick={regenerate}>
                  重新生成
                </button>
              </>
            ) : graph?.status === 'ready' ? (
              <>
                <h2>还没有可用的概念</h2>
                <p>材料总结里没有抽取出概念，可先在「课程资料」中生成总结后再试。</p>
              </>
            ) : (
              <>
                <h2>知识图谱 · 学科脉络</h2>
                <p>
                  把课程材料总结归纳成核心概念，按模块分支成思维导图，概念沿学习顺序串联，
                  前置用箭头、相关用虚线；点击概念可跳回原课件页码，并查看相关真题。
                </p>
                <button onClick={regenerate}>生成知识图谱</button>
              </>
            )}
          </div>
        ) : (
          <div className="graph-canvas">
            <div className="graph-toolbar">
              <button
                className="mini ghost graph-panel-toggle"
                onClick={() => setPanelOpen((v) => !v)}
                title="显示/隐藏概念列表"
              >
                概念
              </button>
              <button className="mini ghost" onClick={() => zoomBy(0.86)} title="放大">
                ＋
              </button>
              <button className="mini ghost" onClick={() => zoomBy(1.16)} title="缩小">
                －
              </button>
              <button className="mini ghost" onClick={() => setUserView(null)}>
                重置
              </button>
              <button
                className="mini ghost"
                onClick={() => setCollapsed(expandAll())}
                disabled={collapsed.size === 0}
              >
                全部展开
              </button>
              <button
                className="mini ghost"
                onClick={() => setCollapsed(collapseAll(modules))}
                disabled={collapsed.size === modules.length}
              >
                全部收起
              </button>
              <span className="graph-hint">
                滚轮缩放 · 拖拽或方向键平移 · 点击模块签收起/展开 · 缩略图可拖动
              </span>
            </div>
            <div className="graph-nav">
              <label className="graph-nav-item">
                <span className="graph-nav-label">缩放</span>
                <input
                  className="graph-slider"
                  type="range"
                  min={zoomMin}
                  max={zoomMax}
                  step={20}
                  value={zoomValue}
                  onChange={(e) =>
                    setUserView((prev) => setZoomWidth(prev ?? view, Number(e.target.value), world))
                  }
                  aria-label="缩放"
                />
              </label>
              <label className="graph-nav-item">
                <span className="graph-nav-label">横向</span>
                <input
                  className="graph-slider"
                  type="range"
                  min={0}
                  max={1000}
                  step={1}
                  value={Math.round(frac.x * 1000)}
                  disabled={!scrollable.x}
                  onChange={(e) =>
                    setUserView((prev) =>
                      withScrollFraction(prev ?? view, mind.world, 'x', Number(e.target.value) / 1000),
                    )
                  }
                  aria-label="横向位置"
                />
              </label>
              <label className="graph-nav-item">
                <span className="graph-nav-label">纵向</span>
                <input
                  className="graph-slider"
                  type="range"
                  min={0}
                  max={1000}
                  step={1}
                  value={Math.round(frac.y * 1000)}
                  disabled={!scrollable.y}
                  onChange={(e) =>
                    setUserView((prev) =>
                      withScrollFraction(prev ?? view, mind.world, 'y', Number(e.target.value) / 1000),
                    )
                  }
                  aria-label="纵向位置"
                />
              </label>
            </div>
            <svg
              ref={svgRef}
              className="graph-svg"
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onKeyDown={onKeyDown}
              tabIndex={0}
              role="application"
              aria-label="知识图谱画布：方向键平移，加减号缩放，Home 回到自适应视窗"
            >
              <defs>
                <marker
                  id="graph-arrow"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a0bb" />
                </marker>
                <marker
                  id="graph-arrow-active"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill="#2f5bd8" />
                </marker>
              </defs>
              <g className="graph-edges">
                {mind.edges.map((edge) => {
                  const active = selected !== null && (edge.source === selected || edge.target === selected)
                  const dimmed =
                    !active &&
                    moduleFilter !== '' &&
                    !(
                      moduleOf.get(edge.source) === moduleFilter &&
                      moduleOf.get(edge.target) === moduleFilter
                    )
                  const cls = `graph-edge${
                    edge.relation === 'prerequisite' ? ' prereq' : ' related'
                  }${active ? ' active' : ''}`
                  return (
                    <path
                      key={edge.key}
                      d={edge.d}
                      className={cls}
                      opacity={dimmed ? 0.12 : 1}
                      markerEnd={
                        edge.relation === 'prerequisite'
                          ? active
                            ? 'url(#graph-arrow-active)'
                            : 'url(#graph-arrow)'
                          : undefined
                      }
                    />
                  )
                })}
              </g>
              <g className="graph-chips">
                {mind.chips.map((chip) => {
                  const dimmed = moduleFilter !== '' && chip.module !== moduleFilter
                  const isCollapsed = chip.collapsed === true
                  return (
                    <g
                      key={chip.module}
                      className={isCollapsed ? 'graph-chip collapsed' : 'graph-chip'}
                      opacity={dimmed ? 0.25 : 1}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => toggleModuleCollapsed(chip.module)}
                    >
                      <title>
                        {isCollapsed
                          ? `${chip.module}：已收起 ${chip.count} 个概念（点击展开）`
                          : `${chip.module}：${chip.count} 个概念（点击收起）`}
                      </title>
                      <rect
                        x={chip.x}
                        y={chip.y}
                        width={chip.w}
                        height={chip.h}
                        rx={8}
                        fill={colorOf(chip.module)}
                      />
                      <text
                        x={chip.x + 10}
                        y={chip.y + chip.h / 2}
                        dominantBaseline="central"
                        className="graph-chip-label"
                      >
                        {isCollapsed
                          ? `${chip.module} · ${chip.count} 隐藏`
                          : chip.module.length > 8
                            ? `${chip.module.slice(0, 8)}…`
                            : chip.module}
                      </text>
                      {!isCollapsed && (
                        <text
                          x={chip.x + chip.w - 10}
                          y={chip.y + chip.h / 2}
                          textAnchor="end"
                          dominantBaseline="central"
                          className="graph-chip-count"
                        >
                          {chip.count}
                        </text>
                      )}
                      {isCollapsed && (
                        <text
                          x={chip.x + chip.w - 8}
                          y={chip.y + chip.h / 2}
                          textAnchor="end"
                          dominantBaseline="central"
                          className="graph-chip-count"
                        >
                          ▸
                        </text>
                      )}
                    </g>
                  )
                })}
              </g>
              <g className="graph-pills">
                {graph.nodes.map((node) => {
                  const p = mind.pills.get(node.id)
                  if (!p) return null
                  const active = selected === node.id
                  const dimmed = moduleFilter !== '' && node.module !== moduleFilter
                  const color = colorOf(node.module)
                  return (
                    <g
                      key={node.id}
                      className={active ? 'graph-pill active' : 'graph-pill'}
                      opacity={dimmed ? 0.22 : 1}
                      style={{ cursor: 'pointer' }}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => selectNode(node.id)}
                    >
                      <title>{`${node.name}（${node.module}）`}</title>
                      <rect
                        x={p.x}
                        y={p.y}
                        width={p.w}
                        height={p.h}
                        rx={9}
                        fill={active ? `${color}1f` : '#fff'}
                        stroke={color}
                      />
                      {node.problems.length > 0 && (
                        <circle
                          cx={p.x + p.w - 7}
                          cy={p.y + 7}
                          r={4.5}
                          className="graph-problem-dot"
                        />
                      )}
                      <text
                        x={p.x + p.w / 2}
                        y={p.y + p.h / 2}
                        textAnchor="middle"
                        dominantBaseline="central"
                        className="graph-pill-label"
                      >
                        {node.name}
                      </text>
                    </g>
                  )
                })}
              </g>
            </svg>
            {mini && (
              <div className="graph-minimap">
                <svg
                  className="graph-minimap-svg"
                  viewBox={`0 0 ${MINIMAP.w} ${MINIMAP.h}`}
                  preserveAspectRatio="none"
                  onPointerDown={onMiniPointerDown}
                  onPointerMove={onMiniPointerMove}
                  onPointerUp={onMiniPointerUp}
                  onPointerLeave={onMiniPointerUp}
                >
                  <rect
                    className="graph-minimap-world"
                    {...miniRect(mini.worldRect)}
                    rx={6}
                  />
                  {mind.chips.map((chip) => (
                    <rect
                      key={`chip-${chip.module}`}
                      className="graph-minimap-chip"
                      fill={colorOf(chip.module)}
                      {...miniRect(
                        mapRectToMinimap(mini, { x: chip.x, y: chip.y, w: chip.w, h: chip.h }),
                      )}
                    />
                  ))}
                  {[...mind.pills].map(([id, p]) => (
                    <rect key={id} className="graph-minimap-pill" {...miniRect(mapRectToMinimap(mini, p))} />
                  ))}
                  <rect className="graph-minimap-view" {...miniRect(mini.viewRect)} rx={3} />
                </svg>
                <span className="graph-minimap-label">缩略图 · 可拖动</span>
              </div>
            )}
          </div>
        )}
      </main>

      <aside className={selectedNode ? 'graph-side open' : 'graph-side'}>
        {selectedNode ? (
          <div className="graph-detail">
            <div className="graph-detail-head">
              <span className="module-chip" style={{ background: colorOf(selectedNode.module) }}>
                {selectedNode.module}
              </span>
              <button className="link" onClick={() => setSelected(null)}>
                关闭
              </button>
            </div>
            <h3>{selectedNode.name}</h3>
            {selectedNode.description && (
              <div className="md-body">
                <RichText text={selectedNode.description} />
              </div>
            )}
            {selectedNode.material_id != null && (
              <button
                className="graph-source"
                onClick={() =>
                  onJumpMaterial(selectedNode.material_id as number, selectedNode.page, selectedNode.material)
                }
              >
                出处：《{selectedNode.material}》{selectedNode.page > 0 ? ` 第 ${selectedNode.page} 页` : ''}
              </button>
            )}
            {selectedNode.problems.length > 0 && (
              <div className="graph-block">
                <div className="graph-block-title">相关题目（{selectedNode.problems.length}）</div>
                <div className="graph-problems">
                  {selectedNode.problems.map((p) => (
                    <button
                      key={p.id}
                      className="graph-problem"
                      title={p.material ? `《${p.material}》${p.number}` : p.number}
                      onClick={() => onOpenProblem(p.id)}
                    >
                      {p.number || `题目 #${p.id}`}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {related.length > 0 && (
              <div className="graph-block">
                <div className="graph-block-title">关联概念</div>
                <ul className="graph-related">
                  {related.map(({ node, relation, direction }) => (
                    <li key={node.id}>
                      <button className="link" onClick={() => selectNode(node.id)}>
                        {node.name}
                      </button>
                      <span className="graph-rel-tag">
                        {relation === 'prerequisite'
                          ? direction === 'in'
                            ? '前置'
                            : '后续'
                          : '相关'}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        ) : graph?.status === 'ready' ? (
          <div className="graph-overview">
            <div className="section-title">课程脉络总览</div>
            {graph.overview ? (
              <div className="md-body graph-overview-body">
                <RichText text={graph.overview} />
              </div>
            ) : (
              <p className="empty">没有总览文本</p>
            )}
            <p className="graph-tip">
              共 {graph.nodes.length} 个概念、{graph.edges.length} 条关系；点击画布中的概念查看解释、出处页与相关题目。
              模块签可收起/展开，左侧目录与缩略图都能快速定位。
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
