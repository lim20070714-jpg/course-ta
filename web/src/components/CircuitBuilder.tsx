/**
 * 自由搭建实验台：元件面板 + 网格画布编辑器 + 实时分析面板。
 *
 * 交互约定：
 * - 点击面板元件后点击画布放置；拖拽元件本体移动；选中后在属性栏改参数/旋转/删除。
 *   电压源、电流源可选正弦波/方波，带幅值、频率、直流偏置。
 * - 连线（磁吸 + 多段折线）：点端子开始，光标靠近端子/导线折点/导线线段时会吸附并高亮，
 *   点端子或双击空白收尾；中途点击空白可加折点；从端子直接拖到终点松开也可完成；Esc 取消。
 * - 画布：Ctrl + 滚轮以光标为中心缩放，＋/－/整页按钮，拖动空白平移。
 * - 结果实时由 buildCircuit 提取网表交给 MNA 内核（直流 / 瞬态 / 扫频）。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { LabDrawingSummary } from '../api'
import {
  createLabDrawing,
  deleteLabDrawing,
  getLabDrawing,
  listLabDrawings,
  overwriteLabDrawing,
} from '../api'
import {
  magnitude,
  solveDC,
  solveTransient,
  sweep,
  type Cx,
  type CircElement,
  type Circuit,
} from '../circuit'
import { formatSi } from '../labs/labs'
import {
  checkName,
  drawingCounts,
  FREE_LAB_ID,
  isBuildShape,
  normalizeName,
  updatedLabel,
} from '../labs/drawings'
import {
  buildCircuit,
  canPlace,
  COLS,
  compBBox,
  DEFAULT_VALUE,
  formatCompValue,
  GRID,
  KIND_LABEL,
  nextId,
  parseSi,
  ptKey,
  ROWS,
  routeWire,
  rotateComp,
  sampleBuild,
  squareRcBuild,
  terminalsOf,
  type BComp,
  type BWire,
  type Build,
  type BuildResult,
  type CompKind,
  type Pt,
  type WaveShape,
} from '../labs/builder'
import Plot, { type PlotSeries } from './Plot'

const STROKE = 'currentColor'
const LABEL = 'currentColor'
const ACCENT = '#5b82e8'
const DANGER = '#c8483f'
const SAVE_KEY = 'courseta.lab.build.v1'
const PROBE_COLORS = ['#2f5bd8', '#c8483f', '#2e9e5b', '#b07d2b', '#7d4bd8', '#0f9ec0', '#d3548c']

const KINDS: CompKind[] = ['R', 'C', 'L', 'V', 'I', 'OA', 'GND']

const PAD = 30
const VB_X = -PAD
const VB_Y = -PAD
const VB_W = COLS * GRID + 2 * PAD
const VB_H = ROWS * GRID + 2 * PAD
const WORLD_W = COLS * GRID
const WORLD_H = ROWS * GRID

/** 缩放范围与磁吸半径（格） */
const Z_MIN = 0.7
const Z_MAX = 8
const SNAP_R = 0.85

const px = (v: number) => v * GRID

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

const clampCenter = (cx: number, cy: number) => ({
  cx: clamp(cx, VB_X, WORLD_W + PAD),
  cy: clamp(cy, VB_Y, WORLD_H + PAD),
})

function loadSaved(): Build | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const data = JSON.parse(raw) as Build
    if (!Array.isArray(data?.comps) || !Array.isArray(data?.wires)) return null
    return data
  } catch {
    return null
  }
}

function nextWireId(wires: BWire[]): string {
  let max = 0
  for (const w of wires) {
    const m = /^W(\d+)$/.exec(w.id)
    if (m) max = Math.max(max, Number(m[1]))
  }
  return `W${max + 1}`
}

const initUnit = (kind: CompKind) => (kind === 'C' ? 'V' : 'A')

/** 电流正方向统一为「对外输出」的元件（电压源 / 电流源） */
const isOutputCurrent = (kind: CompKind | CircElement['kind']) => kind === 'V' || kind === 'I'

/** 分析面板里统一换算成“输出电流”的显示值 */
const displayCurrent = (kind: CircElement['kind'], i: number) => (isOutputCurrent(kind) ? -i : i)

/** 把 target 接入折线：必要时按正交走线补拐点；target 与末点重合时不改 */
function appendRoute(pts: Pt[], target: Pt): Pt[] {
  const last = pts[pts.length - 1]
  if (target.x === last.x && target.y === last.y) return pts
  return [...pts, ...routeWire(last, target).slice(1)]
}

/** 提交前的整理：去除重复点、合并共线的中间点 */
function simplifyWire(pts: Pt[]): Pt[] {
  const out: Pt[] = []
  for (const p of pts) {
    const last = out[out.length - 1]
    if (last && last.x === p.x && last.y === p.y) continue
    out.push(p)
  }
  for (let i = 1; i < out.length - 1; ) {
    const a = out[i - 1]
    const b = out[i]
    const c = out[i + 1]
    if ((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x) === 0) out.splice(i, 1)
    else i++
  }
  return out
}

interface DragState {
  id: string
  offX: number
  offY: number
  ghost: Pt | null
  moved: boolean
}

type SnapKind = 'term' | 'vertex' | 'segment' | 'grid'

interface SnapInfo {
  pt: Pt
  kind: SnapKind
}

interface WireDraft {
  /** 已确认的折线顶点（pts[0] 为起点端子/导线折点） */
  pts: Pt[]
  /** 当前光标吸附位置（预览终点） */
  to: Pt | null
  snap: SnapInfo | null
  moved: boolean
}

interface PanState {
  start: Pt
  cx: number
  cy: number
  moved: boolean
}

interface ViewState {
  /** 视口缩放：1 = 整页；viewBox 宽 = VB_W / zoom */
  zoom: number
  cx: number
  cy: number
}

export default function CircuitBuilder() {
  const [build, setBuild] = useState<Build>(() => loadSaved() ?? sampleBuild())
  const [armed, setArmed] = useState<CompKind | null>(null)
  const [selComp, setSelComp] = useState<string | null>(null)
  const [selWire, setSelWire] = useState<string | null>(null)
  const [drag, setDrag] = useState<DragState | null>(null)
  const [draft, setDraft] = useState<WireDraft | null>(null)
  const [pan, setPan] = useState<PanState | null>(null)
  const [view, setView] = useState<ViewState>({ zoom: 1, cx: WORLD_W / 2, cy: WORLD_H / 2 })
  const [valueText, setValueText] = useState('')
  const [initText, setInitText] = useState('')
  const [freqText, setFreqText] = useState('')
  const [offsetText, setOffsetText] = useState('')
  const [hint, setHint] = useState('')
  const [drawings, setDrawings] = useState<LabDrawingSummary[]>([])
  const [drawingName, setDrawingName] = useState('')
  const [currentDrawing, setCurrentDrawing] = useState<LabDrawingSummary | null>(null)
  const [drawingsOpen, setDrawingsOpen] = useState(false)
  const [drawingBusy, setDrawingBusy] = useState(false)
  const [drawNotice, setDrawNotice] = useState('')
  const svgRef = useRef<SVGSVGElement | null>(null)
  const pressRef = useRef<Pt | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const draftRef = useRef<WireDraft | null>(null)
  const panRef = useRef<PanState | null>(null)
  const viewRef = useRef<ViewState>(view)

  /** 拖拽/连线/平移状态同步存 ref：连续 pointermove 的渲染可能滞后，pointerup 需要读到最新值 */
  const putDrag = (d: DragState | null) => {
    dragRef.current = d
    setDrag(d)
  }
  const putDraft = (d: WireDraft | null) => {
    draftRef.current = d
    setDraft(d)
  }
  const putPan = (p: PanState | null) => {
    panRef.current = p
    setPan(p)
  }
  const putView = (v: ViewState) => {
    viewRef.current = v
    setView(v)
  }

  useEffect(() => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(build))
    } catch {
      /* 隐私模式等场景下忽略 */
    }
  }, [build])

  /* ---------- 图纸：存到服务端，换浏览器也能继续画（本地暂存只是兜底） ---------- */

  const loadDrawings = () => {
    listLabDrawings(FREE_LAB_ID)
      .then(setDrawings)
      .catch((e: Error) => setDrawNotice(`图纸列表读取失败：${e.message}`))
  }

  useEffect(() => {
    loadDrawings()
  }, [])

  /** 改名/另存时不能撞别人；当前这张图纸自己的名字不算冲突。 */
  const takenNames = useMemo(
    () => drawings.filter((d) => d.id !== currentDrawing?.id).map((d) => d.name),
    [drawings, currentDrawing],
  )

  const saveDrawing = async (asNew: boolean) => {
    const name = normalizeName(drawingName)
    const bad = checkName(name, asNew ? drawings.map((d) => d.name) : takenNames)
    if (bad) {
      setDrawNotice(bad)
      return
    }
    setDrawingBusy(true)
    setDrawNotice('')
    try {
      const payload = { name, lab_id: FREE_LAB_ID, build }
      const saved =
        asNew || currentDrawing === null
          ? await createLabDrawing(payload)
          : await overwriteLabDrawing(currentDrawing.id, payload)
      setCurrentDrawing(saved)
      setDrawingName(saved.name)
      setDrawNotice(
        `已${asNew ? '另存' : '保存'}图纸《${saved.name}》：${drawingCounts(saved)}。换浏览器也能载入。`,
      )
      loadDrawings()
    } catch (e) {
      setDrawNotice((e as Error).message)
    } finally {
      setDrawingBusy(false)
    }
  }

  const openDrawing = async (id: number) => {
    setDrawingBusy(true)
    setDrawNotice('')
    try {
      const d = await getLabDrawing(id)
      if (!isBuildShape(d.build)) {
        setDrawNotice(`图纸《${d.name}》的内容读不出来，可能来自不兼容的旧版本。`)
        return
      }
      setBuild({ comps: d.build.comps, wires: d.build.wires })
      setSelComp(null)
      setSelWire(null)
      putDraft(null)
      setArmed(null)
      setHint('')
      setCurrentDrawing(d)
      setDrawingName(d.name)
      setDrawNotice(`已载入图纸《${d.name}》：${drawingCounts(d)}。`)
      fitView()
    } catch (e) {
      setDrawNotice((e as Error).message)
    } finally {
      setDrawingBusy(false)
    }
  }

  const removeDrawing = async (id: number) => {
    const target = drawings.find((d) => d.id === id)
    if (!window.confirm(`删除图纸《${target?.name ?? id}》？画布上正在搭的内容不会丢。`)) return
    try {
      await deleteLabDrawing(id)
      setDrawings((rows) => rows.filter((d) => d.id !== id))
      if (currentDrawing?.id === id) setCurrentDrawing(null)
      setDrawNotice('图纸已删除。')
    } catch (e) {
      setDrawNotice((e as Error).message)
    }
  }

  /* Ctrl + 滚轮缩放：普通滚轮保持页面滚动，因此需要非 passive 的原生监听 */
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = svg.getBoundingClientRect()
      const v = viewRef.current
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2
      const z2 = clamp(v.zoom * factor, Z_MIN, Z_MAX)
      if (z2 === v.zoom) return
      const gx = clamp((e.clientX - rect.left) / Math.max(rect.width, 1), 0, 1)
      const gy = clamp((e.clientY - rect.top) / Math.max(rect.height, 1), 0, 1)
      const w0 = VB_W / v.zoom
      const h0 = VB_H / v.zoom
      const wx = v.cx - w0 / 2 + gx * w0
      const wy = v.cy - h0 / 2 + gy * h0
      const w1 = VB_W / z2
      const h1 = VB_H / z2
      const c = clampCenter(wx - (gx - 0.5) * w1, wy - (gy - 0.5) * h1)
      putView({ zoom: z2, cx: c.cx, cy: c.cy })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [])

  const built = useMemo(() => {
    try {
      return { res: buildCircuit(build), err: '' }
    } catch (e) {
      return { res: null, err: e instanceof Error ? e.message : String(e) }
    }
  }, [build])

  const selected = build.comps.find((c) => c.id === selComp) ?? null

  const deleteComp = (id: string) => {
    setBuild((b) => ({ ...b, comps: b.comps.filter((c) => c.id !== id) }))
    setSelComp(null)
  }
  const deleteWire = (id: string) => {
    setBuild((b) => ({ ...b, wires: b.wires.filter((w) => w.id !== id) }))
    setSelWire(null)
  }

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        setArmed(null)
        putDraft(null)
        putDrag(null)
        putPan(null)
        pressRef.current = null
        setHint('')
        return
      }
      if (ev.key === 'Delete' || ev.key === 'Backspace') {
        const tag = (ev.target as HTMLElement | null)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        if (selComp) {
          setBuild((b) => ({ ...b, comps: b.comps.filter((c) => c.id !== selComp) }))
          setSelComp(null)
        } else if (selWire) {
          setBuild((b) => ({ ...b, wires: b.wires.filter((w) => w.id !== selWire) }))
          setSelWire(null)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selComp, selWire])

  /* ---------- 坐标换算与磁吸 ---------- */

  const rawGrid = (e: { clientX: number; clientY: number }): Pt => {
    const svg = svgRef.current
    if (!svg) return { x: 0, y: 0 }
    const rect = svg.getBoundingClientRect()
    const v = viewRef.current
    const w = VB_W / v.zoom
    const h = VB_H / v.zoom
    const x = v.cx - w / 2 + ((e.clientX - rect.left) / Math.max(rect.width, 1)) * w
    const y = v.cy - h / 2 + ((e.clientY - rect.top) / Math.max(rect.height, 1)) * h
    return { x: x / GRID, y: y / GRID }
  }

  const snapPt = (e: { clientX: number; clientY: number }): Pt => {
    const g = rawGrid(e)
    return { x: clamp(Math.round(g.x), 0, COLS), y: clamp(Math.round(g.y), 0, ROWS) }
  }

  const snapTerms = useMemo(() => build.comps.flatMap((c) => terminalsOf(c).map((t) => t.pt)), [build.comps])
  const snapVerts = useMemo(() => build.wires.flatMap((w) => w.pts), [build.wires])

  /** 磁吸：优先端子与折点（取最近），其次导线线段上的格点（T 型结点），否则网格 */
  const magnetSnap = (g: Pt): SnapInfo => {
    let best: Pt | null = null
    let bestD = SNAP_R
    for (const p of snapTerms) {
      const d = Math.hypot(p.x - g.x, p.y - g.y)
      if (d < bestD) {
        best = p
        bestD = d
      }
    }
    for (const p of snapVerts) {
      const d = Math.hypot(p.x - g.x, p.y - g.y)
      if (d < bestD) {
        best = p
        bestD = d
      }
    }
    if (best) return { pt: best, kind: snapTerms.includes(best) ? 'term' : 'vertex' }
    let seg: Pt | null = null
    let segD = SNAP_R
    for (const w of build.wires) {
      for (let i = 1; i < w.pts.length; i++) {
        const a = w.pts[i - 1]
        const b = w.pts[i]
        if (a.x === b.x) {
          const y = clamp(Math.round(g.y), Math.min(a.y, b.y), Math.max(a.y, b.y))
          const d = Math.hypot(a.x - g.x, y - g.y)
          if (d < segD) {
            seg = { x: a.x, y }
            segD = d
          }
        } else {
          const x = clamp(Math.round(g.x), Math.min(a.x, b.x), Math.max(a.x, b.x))
          const d = Math.hypot(x - g.x, a.y - g.y)
          if (d < segD) {
            seg = { x, y: a.y }
            segD = d
          }
        }
      }
    }
    if (seg) return { pt: seg, kind: 'segment' }
    return { pt: { x: clamp(Math.round(g.x), 0, COLS), y: clamp(Math.round(g.y), 0, ROWS) }, kind: 'grid' }
  }

  /* ---------- 放置 / 拖拽 ---------- */

  const selectComp = (c: BComp) => {
    setSelComp(c.id)
    setSelWire(null)
    setValueText(formatCompValue(c))
    setInitText(c.init !== undefined ? formatSi(c.init, initUnit(c.kind)) : '')
    setFreqText(c.freq !== undefined ? String(c.freq) : '')
    setOffsetText(c.offset !== undefined ? String(c.offset) : '')
  }

  const placeComp = (kind: CompKind, pt: Pt) => {
    const cand: BComp = {
      id: nextId(kind, build.comps),
      kind,
      x: pt.x,
      y: pt.y,
      orient: 'h',
      value: DEFAULT_VALUE[kind],
    }
    if (!canPlace(cand, build.comps)) {
      setHint('这个位置放不下（超出画布或与其它元件重叠），换个格点试试')
      return
    }
    setBuild((b) => ({ ...b, comps: [...b.comps, cand] }))
    setArmed(null)
    setHint('')
    selectComp(cand)
  }

  const startDrag = (e: React.PointerEvent, c: BComp) => {
    if (armed) return
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件 / 老浏览器下忽略 */
    }
    const g = rawGrid(e)
    pressRef.current = g
    putDrag({ id: c.id, offX: g.x - c.x, offY: g.y - c.y, ghost: null, moved: false })
    selectComp(c)
  }

  /* ---------- 连线 ---------- */

  const startFrom = (e: React.PointerEvent, pt: Pt) => {
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件 / 老浏览器下忽略 */
    }
    pressRef.current = rawGrid(e)
    setArmed(null)
    if (draftRef.current) {
      finishWire(pt)
      return
    }
    putDraft({ pts: [pt], to: null, snap: null, moved: false })
    setSelComp(null)
    setSelWire(null)
    setHint('')
  }

  const finishWire = (target: Pt) => {
    const d = draftRef.current
    if (!d) return
    const pts = simplifyWire(appendRoute(d.pts, target))
    if (pts.length < 2) {
      putDraft(null)
      setHint('导线起点与终点重合，已取消')
      return
    }
    const wire: BWire = { id: nextWireId(build.wires), pts }
    setBuild((b) => ({ ...b, wires: [...b.wires, wire] }))
    putDraft(null)
    setHint('')
  }

  /** 画布空白（含导线本体）上的点击：收折点 / 放置元件；返回是否已处理 */
  const backgroundTap = (e: React.PointerEvent): boolean => {
    const d = draftRef.current
    if (d) {
      const snap = magnetSnap(rawGrid(e))
      const pts = appendRoute(d.pts, snap.pt)
      if (pts.length !== d.pts.length) {
        // 保持 moved=false：纯点击加折点不应触发 onUp 的「拖拽松手即收尾」
        putDraft({ pts, to: snap.pt, snap, moved: d.moved })
        // 吸附到端子/导线折点时直接收尾，符合「连到这里」的直觉
        if (snap.kind === 'term' || snap.kind === 'vertex') finishWire(snap.pt)
      }
      return true
    }
    if (armed) {
      placeComp(armed, snapPt(e))
      return true
    }
    return false
  }

  const onBackgroundDown = (e: React.PointerEvent) => {
    pressRef.current = rawGrid(e)
    if (backgroundTap(e)) return
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件 / 老浏览器下忽略 */
    }
    putPan({ start: rawGrid(e), cx: viewRef.current.cx, cy: viewRef.current.cy, moved: false })
  }

  const onBackgroundDouble = (e: React.MouseEvent) => {
    if (!draftRef.current) return
    finishWire(magnetSnap(rawGrid(e)).pt)
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = rawGrid(e)
    const p0 = pressRef.current
    const far = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) > 0.25
    const curDrag = dragRef.current
    if (curDrag) {
      const moved = curDrag.moved || (p0 ? far(g, p0) : false)
      const ghost = { x: Math.round(g.x - curDrag.offX), y: Math.round(g.y - curDrag.offY) }
      putDrag({ ...curDrag, moved, ghost })
      return
    }
    const curPan = panRef.current
    if (curPan) {
      const moved = curPan.moved || far(g, curPan.start)
      const c = clampCenter(
        curPan.cx - (g.x - curPan.start.x) * GRID,
        curPan.cy - (g.y - curPan.start.y) * GRID,
      )
      putPan({ ...curPan, moved })
      putView({ ...viewRef.current, cx: c.cx, cy: c.cy })
      return
    }
    const curDraft = draftRef.current
    if (curDraft) {
      const moved = curDraft.moved || (p0 ? far(g, p0) : false)
      const snap = magnetSnap(g)
      putDraft({ ...curDraft, to: snap.pt, snap, moved })
    }
  }

  const onUp = () => {
    pressRef.current = null
    const d = dragRef.current
    if (d) {
      if (d.moved && d.ghost) {
        const c = build.comps.find((x) => x.id === d.id)
        const cand = c ? { ...c, x: d.ghost.x, y: d.ghost.y } : null
        if (c && cand && canPlace(cand, build.comps, c.id)) {
          setBuild((b) => ({ ...b, comps: b.comps.map((x) => (x.id === c.id ? cand : x)) }))
          setHint('')
        } else {
          setHint('目标位置放不下，元件已退回原处')
        }
      }
      putDrag(null)
      return
    }
    const p = panRef.current
    if (p) {
      if (!p.moved) {
        setSelComp(null)
        setSelWire(null)
      }
      putPan(null)
      return
    }
    const w = draftRef.current
    if (w && w.moved && w.to) finishWire(w.to)
  }

  const onCancel = () => {
    putDrag(null)
    putDraft(null)
    putPan(null)
    pressRef.current = null
  }

  /* ---------- 缩放 ---------- */

  const zoomBy = (factor: number) => {
    const v = viewRef.current
    const z2 = clamp(v.zoom * factor, Z_MIN, Z_MAX)
    if (z2 === v.zoom) return
    const c = clampCenter(v.cx, v.cy)
    putView({ zoom: z2, cx: c.cx, cy: c.cy })
  }

  const fitView = () => putView({ zoom: 1, cx: WORLD_W / 2, cy: WORLD_H / 2 })

  /* ---------- 属性面板 ---------- */

  const onValueInput = (t: string) => {
    setValueText(t)
    if (!selected) return
    const v = parseNumber(t)
    if (v === null) {
      setHint('参数无法识别，可写 4.7k、10µ 这样的形式')
      return
    }
    if (selected.wave && v <= 0) {
      setHint('波形幅值需要大于 0')
      return
    }
    if (!isOutputCurrent(selected.kind) && selected.kind !== 'OA' && selected.kind !== 'GND' && v <= 0) {
      setHint(`${KIND_LABEL[selected.kind]}的参数需要大于 0`)
      return
    }
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) => (x.id === selected.id ? { ...x, value: v } : x)),
    }))
  }

  const onInitInput = (t: string) => {
    setInitText(t)
    if (!selected) return
    if (t.trim() === '') {
      setHint('')
      setBuild((b) => ({
        ...b,
        comps: b.comps.map((x) => (x.id === selected.id ? { ...x, init: undefined } : x)),
      }))
      return
    }
    const v = parseNumber(t)
    if (v === null) {
      setHint('初始条件无法识别')
      return
    }
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) => (x.id === selected.id ? { ...x, init: v } : x)),
    }))
  }

  const onWaveChange = (shape: 'dc' | WaveShape) => {
    if (!selected) return
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) =>
        x.id === selected.id
          ? shape === 'dc'
            ? { ...x, wave: undefined, freq: undefined, offset: undefined }
            : { ...x, wave: shape, offset: x.offset ?? 0 }
          : x,
      ),
    }))
  }

  const onFreqInput = (t: string) => {
    setFreqText(t)
    if (!selected) return
    if (t.trim() === '') {
      setHint('')
      setBuild((b) => ({
        ...b,
        comps: b.comps.map((x) => (x.id === selected.id ? { ...x, freq: undefined } : x)),
      }))
      return
    }
    const v = parseNumber(t)
    if (v === null || v <= 0) {
      setHint('频率需要为正数，可写 1k 这样的形式')
      return
    }
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) => (x.id === selected.id ? { ...x, freq: v } : x)),
    }))
  }

  const onOffsetInput = (t: string) => {
    setOffsetText(t)
    if (!selected) return
    if (t.trim() === '') {
      setHint('')
      setBuild((b) => ({
        ...b,
        comps: b.comps.map((x) => (x.id === selected.id ? { ...x, offset: undefined } : x)),
      }))
      return
    }
    const v = parseNumber(t)
    if (v === null) {
      setHint('偏置无法识别')
      return
    }
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) => (x.id === selected.id ? { ...x, offset: v } : x)),
    }))
  }

  const doRotate = () => {
    if (!selected) return
    const next = rotateComp(selected, build.comps)
    if (!next) {
      setHint('旋转后放不下（超出画布或与其它元件重叠）')
      return
    }
    setHint('')
    setBuild((b) => ({
      ...b,
      comps: b.comps.map((x) => (x.id === selected.id ? next : x)),
    }))
  }

  const putSample = (which: string) => {
    setBuild(which === 'square-rc' ? squareRcBuild() : sampleBuild())
    setSelComp(null)
    setSelWire(null)
    putDraft(null)
    setArmed(null)
    setHint('')
    fitView()
  }

  /* ---------- 渲染 ---------- */

  const vb = useMemo(() => {
    const w = VB_W / view.zoom
    const h = VB_H / view.zoom
    return { x: view.cx - w / 2, y: view.cy - h / 2, w, h }
  }, [view])

  const junctions = useMemo(() => {
    if (!built.res) return [] as Pt[]
    return [...built.res.junctions].map((k) => {
      const [x, y] = k.split(',').map(Number)
      return { x, y }
    })
  }, [built])

  const netLabels = useMemo(() => {
    if (!built.res) return [] as { name: string; pt: Pt }[]
    const best = new Map<string, Pt>()
    for (const [k, name] of built.res.netNameAtPoint) {
      const [x, y] = k.split(',').map(Number)
      const cur = best.get(name)
      if (!cur || y < cur.y || (y === cur.y && x < cur.x)) best.set(name, { x, y })
    }
    return [...best.entries()].map(([name, pt]) => ({ name, pt }))
  }, [built])

  const gridDots: Pt[] = useMemo(() => {
    const out: Pt[] = []
    for (let x = 0; x <= COLS; x++) for (let y = 0; y <= ROWS; y++) out.push({ x, y })
    return out
  }, [])

  const draftPts = draft ? (draft.to ? appendRoute(draft.pts, draft.to) : draft.pts) : []

  return (
    <div className="builder">
      <div className="builder-left">
        <div className="builder-palette" role="group" aria-label="元件面板：选中后在画布上点击放置">
          {KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              data-kind={kind}
              className={armed === kind ? 'palette-btn armed' : 'palette-btn'}
              aria-pressed={armed === kind}
              title={`放置${KIND_LABEL[kind]}（点击后在画布上选位置）`}
              onClick={() => {
                setArmed(armed === kind ? null : kind)
                putDraft(null)
                setHint('')
              }}
            >
              <PaletteIcon kind={kind} />
              <span>{KIND_LABEL[kind]}</span>
            </button>
          ))}
        </div>

        <div className="schematic-card builder-canvas-card">
          <svg
            ref={svgRef}
            data-canvas
            className={armed || draft ? 'builder-svg crosshair' : 'builder-svg'}
            viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onCancel}
          >
            <rect
              x={VB_X - VB_W}
              y={VB_Y - VB_H}
              width={VB_W * 3}
              height={VB_H * 3}
              fill="transparent"
              style={{ cursor: armed || draft ? 'crosshair' : pan?.moved ? 'grabbing' : 'grab' }}
              onPointerDown={onBackgroundDown}
              onDoubleClick={onBackgroundDouble}
            />
            <g pointerEvents="none">
              {gridDots.map((p) => (
                <circle key={ptKey(p)} cx={px(p.x)} cy={px(p.y)} r={1.3} fill="currentColor" fillOpacity={0.32} />
              ))}
            </g>

            {build.wires.map((w) => (
              <WireGlyph
                key={w.id}
                w={w}
                selected={selWire === w.id}
                onDown={(e) => {
                  if (backgroundTap(e)) return
                  setSelWire(w.id)
                  setSelComp(null)
                }}
                onVertex={(e, pt) => startFrom(e, pt)}
              />
            ))}

            {build.comps.map((c) => {
              const ghostPos = drag && drag.id === c.id && drag.ghost ? drag.ghost : null
              const pos = ghostPos ?? c
              const invalid =
                ghostPos !== null && !canPlace({ ...c, x: pos.x, y: pos.y }, build.comps, c.id)
              return (
                <CompGlyph
                  key={c.id}
                  c={c}
                  pos={pos}
                  selected={selComp === c.id}
                  dragging={ghostPos !== null}
                  invalid={invalid}
                  onDown={(e) => startDrag(e, c)}
                  onTerminal={(e, pt) => startFrom(e, pt)}
                />
              )
            })}

            {draft && (
              <g pointerEvents="none">
                <polyline
                  points={draftPts.map((p) => `${px(p.x)},${px(p.y)}`).join(' ')}
                  fill="none"
                  stroke={ACCENT}
                  strokeWidth={1.8}
                  strokeDasharray="6 5"
                />
                <circle cx={px(draft.pts[0].x)} cy={px(draft.pts[0].y)} r={5} fill={ACCENT} />
                {draft.pts.slice(1).map((p, i) => (
                  <circle key={i} cx={px(p.x)} cy={px(p.y)} r={3.5} fill={ACCENT} />
                ))}
                {draft.to && draft.snap && draft.snap.kind !== 'grid' && (
                  <circle
                    cx={px(draft.snap.pt.x)}
                    cy={px(draft.snap.pt.y)}
                    r={9}
                    fill="none"
                    stroke={ACCENT}
                    strokeWidth={2.2}
                  />
                )}
              </g>
            )}

            <g pointerEvents="none">
              {junctions.map((p) => (
                <circle key={ptKey(p)} cx={px(p.x)} cy={px(p.y)} r={3.6} fill={STROKE} />
              ))}
              {netLabels.map(({ name, pt }) => (
                <text
                  key={name}
                  x={px(pt.x) + 7}
                  y={px(pt.y) - 7}
                  fontSize={12}
                  fontWeight={600}
                  fill={ACCENT}
                >
                  {name}
                </text>
              ))}
            </g>
          </svg>
        </div>

        <div className="builder-toolbar">
          <select
            data-sample-select
            className="builder-select"
            value=""
            onChange={(e) => putSample(e.target.value)}
          >
            <option value="" disabled>
              放入示例…
            </option>
            <option value="divider">分压器（直流）</option>
            <option value="square-rc">RC 方波充放电</option>
          </select>
          <button
            type="button"
            className="mini ghost"
            onClick={() => {
              setBuild({ comps: [], wires: [] })
              setSelComp(null)
              setSelWire(null)
              putDraft(null)
              setArmed(null)
              setHint('')
            }}
          >
            清空画布
          </button>
          <span className="builder-zoom">
            <button type="button" className="mini ghost" data-act="zoom-out" title="缩小" onClick={() => zoomBy(1 / 1.3)}>
              －
            </button>
            <button type="button" className="mini ghost" data-act="zoom-in" title="放大" onClick={() => zoomBy(1.3)}>
              ＋
            </button>
            <button type="button" className="mini ghost" data-act="zoom-fit" title="显示整页" onClick={fitView}>
              整页
            </button>
          </span>
          <span className="builder-draw">
            <input
              data-drawing-name
              className="builder-name"
              value={drawingName}
              maxLength={60}
              spellCheck={false}
              placeholder="图纸名，如：反相放大器"
              aria-label="图纸名称"
              onChange={(e) => setDrawingName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void saveDrawing(false)
              }}
            />
            <button
              type="button"
              className="mini"
              disabled={drawingBusy}
              title={
                currentDrawing
                  ? `覆盖保存到《${currentDrawing.name}》`
                  : '命名后把画布内容存到服务端，换浏览器也能载入'
              }
              onClick={() => void saveDrawing(false)}
            >
              {currentDrawing ? '保存' : '保存图纸'}
            </button>
            {currentDrawing && (
              <button
                type="button"
                className="mini ghost"
                disabled={drawingBusy}
                title="用当前名字新建一张，不动原来那张"
                onClick={() => void saveDrawing(true)}
              >
                另存
              </button>
            )}
            <button
              type="button"
              className={drawingsOpen ? 'mini ghost active' : 'mini ghost'}
              aria-expanded={drawingsOpen}
              onClick={() => setDrawingsOpen((open) => !open)}
            >
              我的图纸（{drawings.length}）
            </button>
          </span>
          <span className="builder-status" role="status">
            {armed
              ? `已选「${KIND_LABEL[armed]}」：点击画布放置，Esc 取消`
              : draft
                ? '连线中：点端子/画布加折点，点端子或双击空白收尾，Esc 取消'
                : '拖元件移动；点端子连线（磁吸对齐）；Ctrl+滚轮缩放，拖空白平移'}
          </span>
        </div>

        {drawNotice && (
          <p className="drawings-notice" role="status">
            {drawNotice}
          </p>
        )}

        {drawingsOpen && (
          <div className="builder-drawings">
            <div className="drawings-head">
              <span className="drawings-title">我的图纸（{drawings.length}）</span>
              <button type="button" className="mini ghost" onClick={loadDrawings} disabled={drawingBusy}>
                刷新
              </button>
            </div>
            {drawings.length === 0 ? (
              <p className="drawings-empty">
                还没有保存的图纸。在上方起个名字点「保存图纸」，画布内容就存进服务端，
                换浏览器或重装后都能载回来继续画。
              </p>
            ) : (
              <ul className="drawings-list">
                {drawings.map((d) => (
                  <li
                    key={d.id}
                    className={currentDrawing?.id === d.id ? 'drawing-row active' : 'drawing-row'}
                  >
                    <button
                      type="button"
                      className="drawing-main"
                      disabled={drawingBusy}
                      title="载入到画布（画布上未保存的改动会被替换）"
                      onClick={() => void openDrawing(d.id)}
                    >
                      <span className="drawing-name">
                        {d.name}
                        {currentDrawing?.id === d.id && <span className="drawing-cur">当前</span>}
                      </span>
                      <span className="drawing-meta">
                        {drawingCounts(d)} · 改于 {updatedLabel(d.updated_at)}
                      </span>
                    </button>
                    <button
                      type="button"
                      className="link danger"
                      aria-label={`删除图纸 ${d.name}`}
                      onClick={() => void removeDrawing(d.id)}
                    >
                      删除
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="builder-inspector">
          {selected ? (
            <>
              <span className="insp-title">
                {selected.id} · {KIND_LABEL[selected.kind]}
              </span>
              {selected.kind !== 'GND' && selected.kind !== 'OA' && (
                <label className="insp-field">
                  {selected.wave ? '幅值' : '参数'}
                  <input
                    data-value-input
                    value={valueText}
                    spellCheck={false}
                    onChange={(e) => onValueInput(e.target.value)}
                  />
                </label>
              )}
              {(selected.kind === 'V' || selected.kind === 'I') && (
                <label className="insp-field">
                  波形
                  <select
                    data-wave-select
                    className="builder-select"
                    value={selected.wave ?? 'dc'}
                    onChange={(e) => onWaveChange(e.target.value as 'dc' | WaveShape)}
                  >
                    <option value="dc">直流</option>
                    <option value="sin">正弦波</option>
                    <option value="square">方波</option>
                  </select>
                </label>
              )}
              {selected.wave && (
                <>
                  <label className="insp-field">
                    频率
                    <input
                      data-freq-input
                      value={freqText}
                      placeholder="1k"
                      spellCheck={false}
                      onChange={(e) => onFreqInput(e.target.value)}
                    />
                  </label>
                  <label className="insp-field">
                    偏置
                    <input
                      data-offset-input
                      value={offsetText}
                      placeholder="0"
                      spellCheck={false}
                      onChange={(e) => onOffsetInput(e.target.value)}
                    />
                  </label>
                </>
              )}
              {(selected.kind === 'C' || selected.kind === 'L') && (
                <label className="insp-field">
                  {selected.kind === 'C' ? '初始电压' : '初始电流'}
                  <input
                    data-init-input
                    value={initText}
                    placeholder="0"
                    spellCheck={false}
                    onChange={(e) => onInitInput(e.target.value)}
                  />
                </label>
              )}
              <button type="button" className="mini" data-act="rotate" onClick={doRotate}>
                旋转
              </button>
              <button
                type="button"
                className="mini danger"
                data-act="delete"
                onClick={() => deleteComp(selected.id)}
              >
                删除
              </button>
            </>
          ) : selWire ? (
            <>
              <span className="insp-title">导线 {selWire}</span>
              <button
                type="button"
                className="mini danger"
                data-act="delete-wire"
                onClick={() => deleteWire(selWire)}
              >
                删除导线
              </button>
            </>
          ) : (
            <span className="insp-tip">点击元件或导线进行编辑</span>
          )}
          {hint !== '' && (
            <span className="builder-hint" role="alert">
              {hint}
            </span>
          )}
        </div>
      </div>

      <div className="builder-right">
        <AnalysisPanel exec={built} />
      </div>
    </div>
  )
}

/** SI 参数文本解析复用 builder.ts 的 parseSi（数值 + 前缀单位） */
const parseNumber = parseSi

/* ---------- 画布元件符号 ---------- */

function PaletteIcon({ kind }: { kind: CompKind }) {
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round">
        {kind === 'R' && (
          <>
            <line x1={1} y1={12} x2={5} y2={12} />
            <rect x={5} y={8.5} width={14} height={7} />
            <line x1={19} y1={12} x2={23} y2={12} />
          </>
        )}
        {kind === 'C' && (
          <>
            <line x1={1} y1={12} x2={9.5} y2={12} />
            <line x1={9.5} y1={6} x2={9.5} y2={18} strokeWidth={2} />
            <line x1={14.5} y1={6} x2={14.5} y2={18} strokeWidth={2} />
            <line x1={14.5} y1={12} x2={23} y2={12} />
          </>
        )}
        {kind === 'L' && (
          <path d="M1 12h3a2.4 2.4 0 0 1 4.8 0a2.4 2.4 0 0 1 4.8 0a2.4 2.4 0 0 1 4.8 0h3.6" />
        )}
        {kind === 'V' && (
          <>
            <circle cx={12} cy={12} r={7} />
            <path d="M14.5 8h2M15.5 7v2" />
            <path d="M7.5 8h2" />
          </>
        )}
        {kind === 'I' && (
          <>
            <circle cx={12} cy={12} r={7} />
            <path d="M8 12h7M12.6 9.4L15 12l-2.4 2.6" />
          </>
        )}
        {kind === 'OA' && (
          <>
            <path d="M5 5v14l14-7z" />
            <path d="M8.5 8.5h3M10 7v3" />
            <path d="M8.5 15.5h3" />
          </>
        )}
        {kind === 'GND' && (
          <>
            <path d="M5 8h14" />
            <path d="M8 12h8" />
            <path d="M10.5 16h3" />
          </>
        )}
      </g>
    </svg>
  )
}

/** 电源圆圈内的波形小图标（正弦 / 方波），cx、cy 为圆心 */
function WaveIcon({ cx, cy, stroke, shape }: { cx: number; cy: number; stroke: string; shape: WaveShape }) {
  const d =
    shape === 'sin'
      ? `M${cx - 7} ${cy} q3.5 -6.5 7 0 t7 0`
      : `M${cx - 7} ${cy + 4.5} h4.5 v-9 h5 v9 h4.5`
  return <path d={d} fill="none" stroke={stroke} strokeWidth={1.5} strokeLinejoin="round" />
}

function WireGlyph({
  w,
  selected,
  onDown,
  onVertex,
}: {
  w: BWire
  selected: boolean
  onDown: (e: React.PointerEvent) => void
  onVertex: (e: React.PointerEvent, pt: Pt) => void
}) {
  const d = w.pts.map((p, i) => `${i ? 'L' : 'M'}${px(p.x)} ${px(p.y)}`).join(' ')
  return (
    <g data-wire={w.id}>
      <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ cursor: 'pointer' }} onPointerDown={onDown} />
      <path d={d} fill="none" stroke={selected ? ACCENT : STROKE} strokeWidth={selected ? 2.6 : 1.7} pointerEvents="none" />
      {w.pts.map((p, i) => (
        <circle
          key={i}
          data-vertex={`${w.id}:${i}`}
          cx={px(p.x)}
          cy={px(p.y)}
          r={11}
          fill="transparent"
          style={{ cursor: 'crosshair' }}
          onPointerDown={(e) => onVertex(e, p)}
        />
      ))}
    </g>
  )
}

function termPts(c: BComp): { id: string; pt: Pt }[] {
  return terminalsOf(c)
}

function CompGlyph({
  c,
  pos,
  selected,
  dragging,
  invalid,
  onDown,
  onTerminal,
}: {
  c: BComp
  pos: { x: number; y: number }
  selected: boolean
  dragging: boolean
  invalid: boolean
  onDown: (e: React.PointerEvent) => void
  onTerminal: (e: React.PointerEvent, pt: Pt) => void
}) {
  const c2 = { ...c, x: pos.x, y: pos.y }
  const x0 = px(pos.x)
  const y0 = px(pos.y)
  const g = GRID
  const stroke = invalid ? DANGER : STROKE
  const label = c.kind === 'GND' ? '' : c.kind === 'OA' ? c.id : `${c.id} ${formatCompValue(c)}`

  const body = (() => {
    switch (c.kind) {
      case 'R':
        return c.orient === 'h' ? (
          <>
            <line x1={x0} y1={y0} x2={x0 + 12} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <rect x={x0 + 12} y={y0 - 9} width={2 * g - 24} height={18} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            <line x1={x0 + 2 * g - 12} y1={y0} x2={x0 + 2 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x0} y2={y0 + 12} stroke={stroke} strokeWidth={1.7} />
            <rect x={x0 - 9} y={y0 + 12} width={18} height={2 * g - 24} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            <line x1={x0} y1={y0 + 2 * g - 12} x2={x0} y2={y0 + 2 * g} stroke={stroke} strokeWidth={1.7} />
          </>
        )
      case 'C':
        return c.orient === 'h' ? (
          <>
            <line x1={x0} y1={y0} x2={x0 + g - 5} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <line x1={x0 + g - 5} y1={y0 - 12} x2={x0 + g - 5} y2={y0 + 12} stroke={stroke} strokeWidth={2.4} />
            <line x1={x0 + g + 5} y1={y0 - 12} x2={x0 + g + 5} y2={y0 + 12} stroke={stroke} strokeWidth={2.4} />
            <line x1={x0 + g + 5} y1={y0} x2={x0 + 2 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x0} y2={y0 + g - 5} stroke={stroke} strokeWidth={1.7} />
            <line x1={x0 - 12} y1={y0 + g - 5} x2={x0 + 12} y2={y0 + g - 5} stroke={stroke} strokeWidth={2.4} />
            <line x1={x0 - 12} y1={y0 + g + 5} x2={x0 + 12} y2={y0 + g + 5} stroke={stroke} strokeWidth={2.4} />
            <line x1={x0} y1={y0 + g + 5} x2={x0} y2={y0 + 2 * g} stroke={stroke} strokeWidth={1.7} />
          </>
        )
      case 'L':
        return c.orient === 'h' ? (
          <>
            <line x1={x0} y1={y0} x2={x0 + 12} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <rect x={x0 + 12} y={y0 - 8} width={2 * g - 24} height={16} fill={stroke} />
            <line x1={x0 + 2 * g - 12} y1={y0} x2={x0 + 2 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x0} y2={y0 + 12} stroke={stroke} strokeWidth={1.7} />
            <rect x={x0 - 8} y={y0 + 12} width={16} height={2 * g - 24} fill={stroke} />
            <line x1={x0} y1={y0 + 2 * g - 12} x2={x0} y2={y0 + 2 * g} stroke={stroke} strokeWidth={1.7} />
          </>
        )
      case 'V': {
        const cx = c.orient === 'h' ? x0 + g : x0
        const cy = c.orient === 'h' ? y0 : y0 + g
        return c.orient === 'h' ? (
          <>
            <line x1={x0} y1={y0} x2={x0 + g - 13} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <circle cx={cx} cy={cy} r={13} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            {c.wave && <WaveIcon cx={cx} cy={cy} stroke={stroke} shape={c.wave} />}
            <line x1={x0 + g + 13} y1={y0} x2={x0 + 2 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <text x={x0 + g + 17} y={y0 + 5} fontSize={13} fill={stroke}>
              +
            </text>
            <text x={x0 + g - 17} y={y0 + 5} fontSize={13} fill={stroke} textAnchor="end">
              −
            </text>
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x0} y2={y0 + g - 13} stroke={stroke} strokeWidth={1.7} />
            <circle cx={cx} cy={cy} r={13} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            {c.wave && (
              <g transform={`rotate(90 ${cx} ${cy})`}>
                <WaveIcon cx={cx} cy={cy} stroke={stroke} shape={c.wave} />
              </g>
            )}
            <line x1={x0} y1={y0 + g + 13} x2={x0} y2={y0 + 2 * g} stroke={stroke} strokeWidth={1.7} />
            <text x={x0 + 18} y={y0 + g + 5} fontSize={13} fill={stroke}>
              +
            </text>
            <text x={x0 - 18} y={y0 + g + 5} fontSize={13} fill={stroke} textAnchor="end">
              −
            </text>
          </>
        )
      }
      case 'I': {
        const cx = c.orient === 'h' ? x0 + g : x0
        const cy = c.orient === 'h' ? y0 : y0 + g
        const inner = c.wave ? (
          <g transform={c.orient === 'v' ? `rotate(90 ${cx} ${cy})` : undefined}>
            <WaveIcon cx={cx} cy={cy - 4} stroke={stroke} shape={c.wave} />
            <path
              d={`M${cx - 9} ${cy + 6.5} h13 M${cx + 1} ${cy + 3.1} L${cx + 4} ${cy + 6.5} L${cx + 1} ${cy + 9.9}`}
              fill="none"
              stroke={stroke}
              strokeWidth={1.5}
            />
          </g>
        ) : c.orient === 'h' ? (
          <path
            d={`M${cx - 8} ${cy} h16 M${cx + 4} ${cy - 4.5} L${cx + 8} ${cy} L${cx + 4} ${cy + 4.5}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.7}
          />
        ) : (
          <path
            d={`M${cx} ${cy - 8} v16 M${cx - 4.5} ${cy + 4} L${cx} ${cy + 8} L${cx + 4.5} ${cy + 4}`}
            fill="none"
            stroke={stroke}
            strokeWidth={1.7}
          />
        )
        return c.orient === 'h' ? (
          <>
            <line x1={x0} y1={y0} x2={x0 + g - 13} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <circle cx={cx} cy={cy} r={13} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            {inner}
            <line x1={x0 + g + 13} y1={y0} x2={x0 + 2 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
          </>
        ) : (
          <>
            <line x1={x0} y1={y0} x2={x0} y2={y0 + g - 13} stroke={stroke} strokeWidth={1.7} />
            <circle cx={cx} cy={cy} r={13} fill="#fff" stroke={stroke} strokeWidth={1.7} />
            {inner}
            <line x1={x0} y1={y0 + g + 13} x2={x0} y2={y0 + 2 * g} stroke={stroke} strokeWidth={1.7} />
          </>
        )
      }
      case 'OA':
        return c.orient === 'h' ? (
          <>
            <path
              d={`M${x0 + 6} ${y0 - g} L${x0 + 6} ${y0 + g} L${x0 + 72} ${y0} Z`}
              fill="#fff"
              stroke={stroke}
              strokeWidth={1.7}
            />
            <line x1={x0 + 72} y1={y0} x2={x0 + 3 * g} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <text x={x0 + 15} y={y0 - g + 15} fontSize={13} fill={stroke}>
              +
            </text>
            <text x={x0 + 15} y={y0 + g - 6} fontSize={13} fill={stroke}>
              −
            </text>
          </>
        ) : (
          <>
            <path
              d={`M${x0 - g} ${y0 + 6} L${x0 + g} ${y0 + 6} L${x0} ${y0 + 72} Z`}
              fill="#fff"
              stroke={stroke}
              strokeWidth={1.7}
            />
            <line x1={x0} y1={y0 + 72} x2={x0} y2={y0 + 3 * g} stroke={stroke} strokeWidth={1.7} />
            <text x={x0 - g + 6} y={y0 + 22} fontSize={13} fill={stroke}>
              +
            </text>
            <text x={x0 + g - 15} y={y0 + 22} fontSize={13} fill={stroke}>
              −
            </text>
          </>
        )
      case 'GND':
        return (
          <>
            <line x1={x0} y1={y0} x2={x0 - 13} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <line x1={x0} y1={y0} x2={x0 + 13} y2={y0} stroke={stroke} strokeWidth={1.7} />
            <line x1={x0 - 13} y1={y0} x2={x0 + 13} y2={y0} stroke={stroke} strokeWidth={2} />
            <line x1={x0 - 8} y1={y0 + 6} x2={x0 + 8} y2={y0 + 6} stroke={stroke} strokeWidth={1.7} />
            <line x1={x0 - 4} y1={y0 + 12} x2={x0 + 4} y2={y0 + 12} stroke={stroke} strokeWidth={1.4} />
          </>
        )
      default:
        return null
    }
  })()

  const labelPos = (() => {
    if (c.kind === 'OA') return { x: x0 + 36, y: y0 - g - 10, anchor: 'middle' as const }
    if (c.orient === 'h') return { x: x0 + g, y: y0 - 16, anchor: 'middle' as const }
    return { x: x0 + 16, y: y0 + g + 4, anchor: 'start' as const }
  })()

  const bbox = compBBox(c2)
  const selRect = {
    x: px(bbox.x0),
    y: px(bbox.y0),
    w: px(bbox.x1 - bbox.x0),
    h: px(bbox.y1 - bbox.y0),
  }

  return (
    <g
      data-comp={c.id}
      opacity={dragging ? 0.75 : 1}
      style={{ cursor: 'grab' }}
      onPointerDown={onDown}
    >
      {body}
      {label !== '' && (
        <text
          x={labelPos.x}
          y={labelPos.y}
          fontSize={12}
          fill={LABEL}
          textAnchor={labelPos.anchor}
          pointerEvents="none"
        >
          {label}
        </text>
      )}
      {selected && (
        <rect
          x={selRect.x}
          y={selRect.y}
          width={selRect.w}
          height={selRect.h}
          rx={6}
          fill="none"
          stroke={ACCENT}
          strokeWidth={1.4}
          strokeDasharray="5 4"
          pointerEvents="none"
        />
      )}
      {termPts(c2).map((t) => (
        <g key={t.id}>
          <circle cx={px(t.pt.x)} cy={px(t.pt.y)} r={4} fill="#fff" stroke={stroke} strokeWidth={1.6} />
          <circle
            data-term={`${c.id}:${t.id}`}
            cx={px(t.pt.x)}
            cy={px(t.pt.y)}
            r={13}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            onPointerDown={(e) => {
              e.stopPropagation()
              onTerminal(e, t.pt)
            }}
          />
        </g>
      ))}
    </g>
  )
}

/* ---------- 分析面板 ---------- */

function AnalysisPanel({
  exec,
}: {
  exec: { res: BuildResult | null; err: string }
}) {
  const [tab, setTab] = useState<'dc' | 'tr' | 'ac'>('dc')

  if (!exec.res) {
    return <div className="lab-error">当前电路还无法分析：{exec.err}</div>
  }
  const circuit = exec.res.circuit
  return (
    <div className="builder-analysis">
      <div className="builder-tabs" role="tablist" aria-label="分析类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'dc'}
          data-tab="dc"
          className={tab === 'dc' ? 'tab active' : 'tab'}
          onClick={() => setTab('dc')}
        >
          直流工作点
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'tr'}
          data-tab="tr"
          className={tab === 'tr' ? 'tab active' : 'tab'}
          onClick={() => setTab('tr')}
        >
          瞬态
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'ac'}
          data-tab="ac"
          className={tab === 'ac' ? 'tab active' : 'tab'}
          onClick={() => setTab('ac')}
        >
          频响
        </button>
      </div>
      <div className="builder-tab-body" key={tab}>
        {tab === 'dc' && <DcView circuit={circuit} />}
        {tab === 'tr' && <TransientView circuit={circuit} />}
        {tab === 'ac' && <SweepView circuit={circuit} />}
      </div>
    </div>
  )
}

function DcView({ circuit }: { circuit: Circuit }) {
  const run = useMemo(() => {
    try {
      return { res: solveDC(circuit), err: '' }
    } catch (e) {
      return { res: null, err: e instanceof Error ? e.message : String(e) }
    }
  }, [circuit])

  if (!run.res) return <div className="lab-error">直流分析失败：{run.err}</div>

  const rows: { label: string; value: string }[] = []
  for (const [name, v] of Object.entries(run.res.nodes)) {
    if (name === '0') continue
    rows.push({ label: `V(${name})`, value: formatSi(v, 'V') })
  }
  for (const el of circuit.elements) {
    const i = run.res.currents[el.id]
    if (i === undefined) continue
    rows.push({
      label: isOutputCurrent(el.kind) || el.kind === 'OA' ? `I(${el.id}) 输出` : `I(${el.id})`,
      value: formatSi(displayCurrent(el.kind, i), 'A'),
    })
  }

  return (
    <div>
      <div className="readouts">
        {rows.map((r, i) => (
          <div
            key={r.label}
            className="readout stagger-item"
            style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
          >
            <span className="readout-label">{r.label}</span>
            <span className="readout-value">{r.value}</span>
          </div>
        ))}
      </div>
      <p className="builder-note">
        电流方向：电阻 / 电容 / 电感沿端子 0→1；电压源、电流源为输出电流（流出「+」端）；运放为流出输出端的电流。
      </p>
    </div>
  )
}

function useProbes(circuit: Circuit) {
  const nodes = useMemo(() => {
    const ground = circuit.ground ?? '0'
    const seen = new Set<string>()
    const out: string[] = []
    const visit = (label: string) => {
      if (label === ground || seen.has(label)) return
      seen.add(label)
      out.push(label)
    }
    for (const el of circuit.elements) {
      if (el.kind === 'OA') {
        visit(el.p)
        visit(el.n)
        visit(el.out)
      } else {
        visit(el.a)
        visit(el.b)
      }
    }
    return out
  }, [circuit])
  const ids = useMemo(() => circuit.elements.map((el) => el.id), [circuit])
  const [picked, setPicked] = useState<string[]>([])

  const available = useMemo(
    () => [...nodes.map((n) => `n:${n}`), ...ids.map((id) => `i:${id}`)],
    [nodes, ids],
  )
  const effective = useMemo(() => {
    const valid = picked.filter((k) => available.includes(k))
    if (valid.length > 0) return valid
    return available.length > 0 ? [available[0]] : []
  }, [picked, available])

  const toggle = (key: string) =>
    setPicked((cur) => {
      const base = cur.filter((k) => available.includes(k))
      const from = base.length > 0 ? base : effective
      return from.includes(key) ? from.filter((k) => k !== key) : [...from, key]
    })

  return { nodes, ids, effective, toggle }
}

function ProbeChips({
  circuit,
  probes,
}: {
  circuit: Circuit
  probes: ReturnType<typeof useProbes>
}) {
  return (
    <div className="probe-chips" role="group" aria-label="探针：选择要在曲线中显示的节点电压与元件电流">
      {probes.nodes.map((n) => {
        const key = `n:${n}`
        const on = probes.effective.includes(key)
        return (
          <button
            key={key}
            type="button"
            data-probe={key}
            aria-pressed={on}
            className={on ? 'chip on' : 'chip'}
            onClick={() => probes.toggle(key)}
          >
            V({n})
          </button>
        )
      })}
      {circuit.elements.map((el) => {
        const key = `i:${el.id}`
        const on = probes.effective.includes(key)
        return (
          <button
            key={key}
            type="button"
            data-probe={key}
            aria-pressed={on}
            className={on ? 'chip on' : 'chip'}
            onClick={() => probes.toggle(key)}
          >
            I({el.id})
          </button>
        )
      })}
    </div>
  )
}

const PROBE_NOTE =
  '电流方向：电阻 / 电容 / 电感沿端子 0→1；电压源、电流源为输出电流；运放为流出输出端的电流。'

function TransientView({ circuit }: { circuit: Circuit }) {
  const [durText, setDurText] = useState('5m')
  const probes = useProbes(circuit)

  const duration = parseNumber(durText)
  const run = useMemo(() => {
    if (duration === null || duration <= 0) return { res: null, err: '时长需要为正数，如 5m、10m' }
    try {
      return { res: solveTransient(circuit, { dt: duration / 1000, duration }), err: '' }
    } catch (e) {
      return { res: null, err: e instanceof Error ? e.message : String(e) }
    }
  }, [circuit, duration])

  const series: PlotSeries[] = useMemo(() => {
    if (!run.res) return []
    return probes.effective.map((key, idx) => {
      const color = PROBE_COLORS[idx % PROBE_COLORS.length]
      if (key.startsWith('n:')) {
        const name = key.slice(2)
        return { label: `V(${name})`, color, x: run.res!.t, y: run.res!.nodes[name] ?? [] }
      }
      const id = key.slice(2)
      const el = circuit.elements.find((e) => e.id === id)
      const raw = run.res!.currents[id] ?? []
      const y = el && isOutputCurrent(el.kind) ? raw.map((v) => -v) : raw
      return { label: `I(${id})`, color, x: run.res!.t, y }
    })
  }, [run, probes, circuit])

  return (
    <div>
      <div className="builder-params">
        <label className="insp-field">
          分析时长
          <input
            data-tr-duration
            value={durText}
            spellCheck={false}
            onChange={(e) => setDurText(e.target.value)}
          />
        </label>
        <span className="builder-mini-note">
          {duration !== null && duration > 0 ? `后向欧拉法 · 1000 步 · Δt = ${formatSi(duration / 1000, 's')}` : ''}
        </span>
      </div>
      <ProbeChips circuit={circuit} probes={probes} />
      {run.res ? (
        <Plot series={series} xLabel="时间 t (s)" yLabel="电压 V / 电流 A" />
      ) : (
        <div className="lab-error">瞬态分析失败：{run.err}</div>
      )}
      <p className="builder-note">{PROBE_NOTE}</p>
    </div>
  )
}

function SweepView({ circuit }: { circuit: Circuit }) {
  const [f1Text, setF1Text] = useState('10')
  const [f2Text, setF2Text] = useState('1M')
  const probes = useProbes(circuit)

  const fStart = parseNumber(f1Text)
  const fStop = parseNumber(f2Text)
  const run = useMemo(() => {
    if (fStart === null || fStop === null || fStart <= 0 || fStop <= fStart) {
      return { res: null, err: '频率范围需要满足 0 < 起始 < 终止，如 10 到 1M' }
    }
    try {
      return { res: sweep(circuit, { fStart, fStop, points: 121 }), err: '' }
    } catch (e) {
      return { res: null, err: e instanceof Error ? e.message : String(e) }
    }
  }, [circuit, fStart, fStop])

  const db = (x: Cx) => 20 * Math.log10(Math.max(magnitude(x), 1e-300))

  const series: PlotSeries[] = useMemo(() => {
    if (!run.res) return []
    return probes.effective
      .filter((k) => k.startsWith('n:'))
      .map((key, idx) => {
        const name = key.slice(2)
        const color = PROBE_COLORS[idx % PROBE_COLORS.length]
        const phasors = run.res!.nodes[name] ?? []
        return { label: `V(${name}) 幅值`, color, x: run.res!.f, y: phasors.map(db) }
      })
  }, [run, probes])

  return (
    <div>
      <div className="builder-params">
        <label className="insp-field">
          起始频率
          <input
            data-ac-f1
            value={f1Text}
            spellCheck={false}
            onChange={(e) => setF1Text(e.target.value)}
          />
        </label>
        <label className="insp-field">
          终止频率
          <input
            data-ac-f2
            value={f2Text}
            spellCheck={false}
            onChange={(e) => setF2Text(e.target.value)}
          />
        </label>
      </div>
      <ProbeChips circuit={circuit} probes={probes} />
      {run.res ? (
        series.length > 0 ? (
          <Plot series={series} xLabel="频率 f (Hz)" yLabel="幅值 (dB)" xLog />
        ) : (
          <div className="builder-note">频响只绘制节点电压：请在上方选择至少一个 V(…) 探针。</div>
        )
      ) : (
        <div className="lab-error">频响分析失败：{run.err}</div>
      )}
      <p className="builder-note">{PROBE_NOTE}</p>
    </div>
  )
}
