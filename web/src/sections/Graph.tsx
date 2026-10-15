import { useEffect, useMemo, useRef, useState } from 'react'
import type { CourseGraph, GraphNode } from '../api'
import { getCourseGraph, regenerateGraph } from '../api'
import RichText from '../components/RichText'
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
const DEFAULT_VIEW: View = { x: 0, y: 0, w: 900, h: 600 }

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
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [userView, setUserView] = useState<View | null>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const dirRef = useRef<Direction>('vertical')
  const viewRef = useRef<View>(DEFAULT_VIEW)
  const dragRef = useRef<{ x: number; y: number; view: View; moved: boolean } | null>(null)

  useEffect(() => {
    if (courseId === null) return
    getCourseGraph(courseId)
      .then((g) => {
        setGraph(g)
        setSelected(null)
        setNotice('')
        setPanelOpen(false)
        setUserView(null)
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

  useEffect(() => {
    if (!ready) return
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current
      const factor = e.deltaY < 0 ? 0.86 : 1.16
      const w = Math.min(Math.max(v.w * factor, 240), 3200)
      const h = w * (v.h / v.w)
      const px = rect.width ? (e.clientX - rect.left) / rect.width : 0.5
      const py = rect.height ? (e.clientY - rect.top) / rect.height : 0.5
      setUserView({ x: v.x + (v.w - w) * px, y: v.y + (v.h - h) * py, w, h })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [ready])

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

  const modules = useMemo(() => (graph ? moduleOrder(graph.nodes) : []), [graph])
  const moduleIndex = useMemo(() => new Map(modules.map((m, i) => [m, i])), [modules])
  const moduleOf = useMemo(
    () => new Map((graph?.nodes ?? []).map((n) => [n.id, n.module])),
    [graph],
  )
  const direction: Direction = size.w >= HORIZONTAL_MIN_W ? 'horizontal' : 'vertical'
  const mind = useMemo(
    () => (ready && graph ? layoutMindMap(graph.nodes, graph.edges, direction) : null),
    [ready, graph, direction],
  )
  const autoView = useMemo(
    () => (mind && size.w > 0 ? fitView(mind.world, size, direction) : null),
    [mind, size, direction],
  )
  const view = userView ?? autoView ?? DEFAULT_VIEW
  useEffect(() => {
    viewRef.current = view
  })

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

  const filteredNodes = useMemo(() => {
    if (!graph) return []
    const q = query.trim().toLowerCase()
    return graph.nodes.filter(
      (n) =>
        (!moduleFilter || n.module === moduleFilter) &&
        (!q || n.name.toLowerCase().includes(q) || n.description.toLowerCase().includes(q)),
    )
  }, [graph, query, moduleFilter])

  const selectedNode = graph?.nodes.find((n) => n.id === selected) ?? null
  const colorOf = (module: string) => MODULE_COLORS[(moduleIndex.get(module) ?? 0) % MODULE_COLORS.length]

  async function regenerate() {
    if (courseId === null) return
    try {
      await regenerateGraph(courseId)
      setNotice('')
      setSelected(null)
      setPanelOpen(false)
      setGraph((g) => (g ? { ...g, status: 'generating', error: '' } : g))
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  function zoomBy(factor: number) {
    const v = viewRef.current
    const w = Math.min(Math.max(v.w * factor, 240), 3200)
    const h = w * (v.h / v.w)
    setUserView({ x: v.x + (v.w - w) / 2, y: v.y + (v.h - h) / 2, w, h })
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
    setUserView({
      x: drag.view.x - dx,
      y: drag.view.y - dy,
      w: drag.view.w,
      h: drag.view.h,
    })
  }

  function onPointerUp() {
    const drag = dragRef.current
    dragRef.current = null
    if (drag && !drag.moved) {
      setSelected(null)
      setPanelOpen(false)
    }
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程，再上传课件生成知识图谱。</div>
  }

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
            <ul className="graph-concept-list">
              {filteredNodes.map((n) => (
                <li key={n.id}>
                  <button
                    className={selected === n.id ? 'graph-concept active' : 'graph-concept'}
                    onClick={() => {
                      setSelected(n.id)
                      setPanelOpen(false)
                    }}
                  >
                    <span className="legend-dot" style={{ background: colorOf(n.module) }} />
                    <span className="graph-concept-name">{n.name}</span>
                    {n.problems.length > 0 && <span className="graph-concept-count">{n.problems.length} 题</span>}
                  </button>
                </li>
              ))}
              {filteredNodes.length === 0 && (
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
        {!ready ? (
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
              <span className="graph-hint">滚轮缩放 · 拖拽平移 · 点击概念看详情</span>
            </div>
            <svg
              ref={svgRef}
              className="graph-svg"
              viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
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
                {mind?.edges.map((edge) => {
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
                {mind?.chips.map((chip) => {
                  const dimmed = moduleFilter !== '' && chip.module !== moduleFilter
                  return (
                    <g
                      key={chip.module}
                      className="graph-chip"
                      opacity={dimmed ? 0.25 : 1}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() =>
                        setModuleFilter(moduleFilter === chip.module ? '' : chip.module)
                      }
                    >
                      <title>{`${chip.module}：${chip.count} 个概念（点击筛选）`}</title>
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
                        {chip.module.length > 8 ? `${chip.module.slice(0, 8)}…` : chip.module}
                      </text>
                      <text
                        x={chip.x + chip.w - 10}
                        y={chip.y + chip.h / 2}
                        textAnchor="end"
                        dominantBaseline="central"
                        className="graph-chip-count"
                      >
                        {chip.count}
                      </text>
                    </g>
                  )
                })}
              </g>
              <g className="graph-pills">
                {graph.nodes.map((node) => {
                  const p = mind?.pills.get(node.id)
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
                      onClick={() => setSelected(node.id)}
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
                      <button className="link" onClick={() => setSelected(node.id)}>
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
            </p>
          </div>
        ) : null}
      </aside>
    </div>
  )
}
