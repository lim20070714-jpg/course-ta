import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  axisTicks,
  cursorRead,
  easeOutCubic,
  fmtTick,
  lerp,
  logTicks,
  nearestIndex,
  plotDomain,
  pxAt,
  pyAt,
  resampleOnto,
  timeToHz,
  toCsv,
  type CursorRead,
  type Domain,
} from '../labs/instruments'

export interface PlotSeries {
  label: string
  color: string
  x: number[]
  y: number[]
  /** 虚线（参考线，不参与悬停读数） */
  dashed?: boolean
  /** 单点标记（标注工作点/谐振峰） */
  marker?: boolean
}

interface PlotProps {
  series: PlotSeries[]
  xLabel: string
  yLabel: string
  xLog?: boolean
  height?: number
}

const W = 760
const M = { top: 16, right: 18, bottom: 44, left: 66 }
/** 波形形变时长：与 --dur-3 一致，肉眼可跟随但不拖沓 */
const MORPH_MS = 320
/** 网格线元素池大小：刻度数量随缩放变化，池子固定、位置与文字走命令式更新 */
const Y_TICK_POOL = 7
const X_TICK_POOL = 9

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 目标快照：几何与坐标轴都以它为准（数学上永远是当前参数的正确结果） */
interface Snapshot {
  dom: Domain
  series: PlotSeries[]
  xLog: boolean
  innerW: number
  innerH: number
  byLabel: Map<string, PlotSeries>
  byIndex: PlotSeries[]
}

interface Morph {
  /** 与目标 x 网格对齐的起始值；NaN 已在 seed 阶段用目标值补齐 */
  fromY: number[][]
  toY: number[][]
  t: number
  start: number
}

interface UiState {
  hover: number | null
  cursorA: number | null
  cursorB: number | null
  hidden: string[]
}

function snapshotOf(series: PlotSeries[], dom: Domain, xLog: boolean, innerW: number, innerH: number): Snapshot {
  return {
    dom,
    series,
    xLog,
    innerW,
    innerH,
    byLabel: new Map(series.map((s) => [s.label, s])),
    byIndex: series.slice(),
  }
}

export default function Plot({ series, xLabel, yLabel, xLog = false, height = 320 }: PlotProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const animRef = useRef<Morph | null>(null)
  const lastRef = useRef<Snapshot | null>(null)
  const rafRef = useRef(0)
  const uiRef = useRef<UiState>({ hover: null, cursorA: null, cursorB: null, hidden: [] })
  const dragRef = useRef<'a' | 'b' | null>(null)
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '')

  const [hover, setHover] = useState<number | null>(null)
  const [cursorA, setCursorA] = useState<number | null>(null)
  const [cursorB, setCursorB] = useState<number | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [hidden, setHidden] = useState<string[]>([])
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
  )

  const H = height
  const innerW = W - M.left - M.right
  const innerH = H - M.top - M.bottom

  useEffect(() => {
    const mq = window.matchMedia?.('(prefers-reduced-motion: reduce)')
    if (!mq) return
    const on = () => setReduced(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])

  const dom = useMemo(() => plotDomain(series, xLog), [series, xLog])

  /* ---------- 命令式绘制：只改几何属性，不触发 React 重渲染 ---------- */

  const paintRef = useRef<() => void>(() => {})

  function paint() {
    const svg = svgRef.current
    const tgt = lastRef.current
    if (!svg || !tgt) return
    const m = animRef.current
    const animating = m !== null && m.t < 1
    const t = m ? m.t : 1
    /**
     * 坐标轴一律用「目标域」：参数变化时采样网格本身也会变（例如扫频的 f 网格整体平移），
     * 若同时插值域，新采样点会落到旧域之外，整条曲线会飞出屏幕。
     * 因此只插值数值（曲线形状），刻度立即显示当前参数下正确的刻度。
     */
    const d: Domain = tgt.dom
    const { xLog: lg, innerW: iw, innerH: ih } = tgt
    const pxOf = (v: number) => pxAt(v, d, lg, M.left, iw)
    const pyOf = (v: number) => pyAt(v, d, M.top, ih)

    /* 波形：动画中按 t 混合，动画结束/静止时直接写目标值（零分配、终点即精确值） */
    for (let i = 0; i < tgt.series.length; i++) {
      const s = tgt.series[i]
      const from = animating && m ? m.fromY[i] : null
      const to = animating && m ? m.toY[i] : s.y
      const n = Math.min(s.x.length, to.length)
      const parts: string[] = []
      let pen = false
      for (let k = 0; k < n; k++) {
        const yv = from ? lerp(from[k], to[k], t) : to[k]
        if (!Number.isFinite(yv)) {
          pen = false
          continue
        }
        parts.push(`${pen ? 'L' : 'M'}${pxOf(s.x[k]).toFixed(1)} ${pyOf(yv).toFixed(1)}`)
        pen = true
      }
      const d2 = parts.join('')
      const sel = `[data-pk="${i}"]`
      const path = svg.querySelector<SVGPathElement>(`path[data-ptrace]${sel}`)
      const glow = svg.querySelector<SVGPathElement>(`path[data-pglow]${sel}`)
      if (path) path.setAttribute('d', d2)
      if (glow) glow.setAttribute('d', d2)
      const dot = svg.querySelector<SVGCircleElement>(`circle[data-pdot]${sel}`)
      if (dot && s.marker && s.x.length > 0) {
        const y0 = from ? lerp(from[0], to[0], t) : to[0]
        dot.setAttribute('cx', pxOf(s.x[0]).toFixed(1))
        dot.setAttribute('cy', pyOf(y0).toFixed(1))
      }
    }

    /* 网格：刻度按目标域生成，位置与文字直接写进元素池 */
    const yLines = svg.querySelectorAll<SVGLineElement>('line[data-ytick]')
    const yTexts = svg.querySelectorAll<SVGTextElement>('text[data-ytick]')
    const yTicks = axisTicks(d.yMin, d.yMax, 5, yLines.length)
    for (let i = 0; i < yLines.length; i++) {
      const tk = yTicks[i]
      const line = yLines[i]
      const text = yTexts[i]
      if (!tk) {
        line.setAttribute('visibility', 'hidden')
        text.setAttribute('visibility', 'hidden')
        continue
      }
      const Y = pyAt(tk.value, d, M.top, ih)
      line.setAttribute('visibility', 'visible')
      line.setAttribute('y1', Y.toFixed(1))
      line.setAttribute('y2', Y.toFixed(1))
      text.setAttribute('visibility', 'visible')
      text.setAttribute('y', (Y + 4).toFixed(1))
      text.textContent = fmtTick(tk.value)
    }
    const xLines = svg.querySelectorAll<SVGLineElement>('line[data-xtick]')
    const xTexts = svg.querySelectorAll<SVGTextElement>('text[data-xtick]')
    const xTicks = lg ? logTicks(d.xMin, d.xMax, xLines.length) : axisTicks(d.xMin, d.xMax, 7, xLines.length)
    for (let i = 0; i < xLines.length; i++) {
      const tk = xTicks[i]
      const line = xLines[i]
      const text = xTexts[i]
      if (!tk) {
        line.setAttribute('visibility', 'hidden')
        text.setAttribute('visibility', 'hidden')
        continue
      }
      const X = M.left + tk.ratio * iw
      line.setAttribute('visibility', 'visible')
      line.setAttribute('x1', X.toFixed(1))
      line.setAttribute('x2', X.toFixed(1))
      text.setAttribute('visibility', 'visible')
      text.setAttribute('x', X.toFixed(1))
      text.textContent = fmtTick(lg ? Math.pow(10, tk.value) : tk.value)
    }

    /* 测量游标：竖线与顶部读数随域一起移动 */
    const ui = uiRef.current
    const cursorPairs: ['a' | 'b', number | null][] = [
      ['a', ui.cursorA],
      ['b', ui.cursorB],
    ]
    for (const [key, value] of cursorPairs) {
      const line = svg.querySelector<SVGLineElement>(`line[data-cursor="${key}"]`)
      const label = svg.querySelector<SVGTextElement>(`text[data-cursor-label="${key}"]`)
      if (!line || !label) continue
      if (value === null || !Number.isFinite(value)) {
        line.setAttribute('visibility', 'hidden')
        label.setAttribute('visibility', 'hidden')
        continue
      }
      const X = pxOf(value)
      line.setAttribute('visibility', 'visible')
      line.setAttribute('x1', X.toFixed(1))
      line.setAttribute('x2', X.toFixed(1))
      label.setAttribute('visibility', 'visible')
      label.setAttribute('x', clamp(X, M.left + 20, W - M.right - 20).toFixed(1))
      label.textContent = `${key === 'a' ? 'A' : 'B'} ${fmtTick(value)}`    }
  }

  /* paint 每帧都从 ref 读取状态，因此 rAF 里必须调用最新的一份 */
  useLayoutEffect(() => {
    paintRef.current = paint
  })

  /* ---------- 目标变化：从“当前显示的状态”平滑过渡到新目标 ---------- */

  useLayoutEffect(() => {
    const prev = lastRef.current
    const a = animRef.current
    const next = snapshotOf(series, dom, xLog, innerW, innerH)
    lastRef.current = next

    const stop = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
      rafRef.current = 0
    }

    // 首帧或减少动效：直接落到目标（数学结果立即正确）
    if (!prev || reduced || series.length === 0) {
      stop()
      animRef.current = null
      paint()
      return
    }

    // 以“当前正在显示的值”为新动画的起点，连续拖动滑块时轨迹持续跟随
    const tCur = a ? a.t : 1
    const curY: number[][] = prev.series.map((s, i) => {
      const from = a ? a.fromY[i] : s.y
      const to = a ? a.toY[i] : s.y
      return s.y.map((_, k) => lerp(from[k], to[k], tCur))
    })
    const curByIndex = prev.series.map((s, i) => ({ ...s, y: curY[i] }))
    const curSnapshot: Snapshot = {
      ...prev,
      byIndex: curByIndex,
      byLabel: new Map(curByIndex.map((s) => [s.label, s])),
    }

    const fromY: number[][] = []
    for (let i = 0; i < series.length; i++) {
      const s = series[i]
      const src = curSnapshot.byLabel.get(s.label) ?? curSnapshot.byIndex[i]
      if (!src) {
        fromY.push(s.y.slice())
        continue
      }
      const aligned = resampleOnto(src.x, src.y, s.x)
      for (let k = 0; k < aligned.length; k++) {
        if (!Number.isFinite(aligned[k])) aligned[k] = s.y[k]
      }
      fromY.push(aligned)
    }

    const morph: Morph = {
      fromY,
      toY: series.map((s) => s.y),
      t: 0,
      start: typeof performance !== 'undefined' ? performance.now() : Date.now(),
    }
    animRef.current = morph
    stop()
    paint()
    const tick = (now: number) => {
      const m = animRef.current
      if (!m) return
      const raw = Math.min(1, (now - m.start) / MORPH_MS)
      m.t = easeOutCubic(raw)
      paintRef.current()
      if (raw < 1) rafRef.current = requestAnimationFrame(tick)
      else animRef.current = null
    }
    rafRef.current = requestAnimationFrame(tick)
  }, [series, dom, xLog, innerW, innerH, reduced])

  useEffect(
    () => () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    },
    [],
  )

  /* 悬停 / 游标 / 隐藏变化：同步到 ref 后重绘 */
  useLayoutEffect(() => {
    uiRef.current = { hover, cursorA, cursorB, hidden }
    paint()
  })

  /* ---------- 交互 ---------- */

  const main = useMemo(() => series.find((s) => !s.marker && s.x.length > 1), [series])
  const visible = useMemo(() => series.filter((s) => !hidden.includes(s.label)), [series, hidden])
  const mainHidden = main !== undefined && hidden.includes(main.label)

  const xAtPointer = (e: React.PointerEvent<SVGSVGElement>): number | null => {
    const svg = svgRef.current
    if (!svg || !main) return null
    const rect = svg.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / Math.max(rect.width, 1)) * W
    const ratio = (mx - M.left) / innerW
    const dx = dom.xMin + ratio * (dom.xMax - dom.xMin)
    const xv = xLog ? Math.pow(10, dx) : dx
    const i = nearestIndex(main.x, xv)
    return i >= 0 ? main.x[i] : null
  }

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const xv = xAtPointer(e)
    if (xv === null) return
    setHover(nearestIndex(main!.x, xv))
    const drag = dragRef.current
    if (drag === 'a') setCursorA(xv)
    else if (drag === 'b') setCursorB(xv)
  }

  const onDown = (e: React.PointerEvent<SVGSVGElement>) => {
    const xv = xAtPointer(e)
    if (xv === null) return
    setHover(nearestIndex(main!.x, xv))
    if (!measuring) return
    let which: 'a' | 'b'
    if (cursorA === null) which = 'a'
    else if (cursorB === null) which = 'b'
    else which = Math.abs(cursorA - xv) <= Math.abs(cursorB - xv) ? 'a' : 'b'
    dragRef.current = which
    try {
      svgRef.current?.setPointerCapture(e.pointerId)
    } catch {
      /* 合成事件下忽略 */
    }
    if (which === 'a') setCursorA(xv)
    else setCursorB(xv)
  }

  const onKey = (e: React.KeyboardEvent<SVGSVGElement>) => {
    if (e.key === 'Escape') {
      setCursorA(null)
      setCursorB(null)
      dragRef.current = null
      return
    }
    if (!measuring || !main) return
    const step = Math.max(1, Math.round(main.x.length / 40))
    const which = cursorB !== null ? 'b' : 'a'
    const cur = which === 'a' ? cursorA : cursorB
    if (cur === null) return
    const i = nearestIndex(main.x, cur)
    let j = i
    if (e.key === 'ArrowLeft') j = clamp(i - step, 0, main.x.length - 1)
    else if (e.key === 'ArrowRight') j = clamp(i + step, 0, main.x.length - 1)
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = main.x.length - 1
    else return
    e.preventDefault()
    if (which === 'a') setCursorA(main.x[j])
    else setCursorB(main.x[j])
  }

  /* ---------- 游标读数与导出 ---------- */

  const traces = useMemo(
    () => visible.filter((s) => !s.marker && !s.dashed && main !== undefined && s.x.length === main.x.length),
    [visible, main],
  )

  const read: CursorRead | null = useMemo(() => {
    if (!main || cursorA === null || cursorB === null) return null
    const pairs = traces.map((s) => ({ label: s.label, y: s.y }))
    if (pairs.length === 0) return null
    return cursorRead(main.x, pairs, cursorA, cursorB)
  }, [main, cursorA, cursorB, traces])
  const colorOf = (label: string) => traces.find((s) => s.label === label)?.color ?? 'var(--accent)'
  /** 从轴标题里取出单位，如 “时间 t (s)” → s，让游标读数自带单位 */
  const unitOf = (label: string) => /\(([^)]+)\)\s*$/.exec(label)?.[1] ?? ''
  /** 时间轴上顺带给出等效频率（示波器游标最常用的换算） */
  const cursorHz = read ? timeToHz(read.dx, unitOf(xLabel)) : null

  const [exported, setExported] = useState(false)
  const exportCsv = () => {
    const body = toCsv(
      xLabel,
      visible.filter((s) => !s.marker),
    )
    if (!body) return
    try {
      const blob = new Blob([`\uFEFF${body}`], { type: 'text/csv;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `波形-${yLabel.replace(/[\\/:*?"<>|\s]+/g, '')}.csv`
      a.click()
      URL.revokeObjectURL(url)
      setExported(true)
      window.setTimeout(() => setExported(false), 1600)
    } catch {
      /* 隐私模式等场景忽略 */
    }
  }

  /* ---------- 悬停读数 ---------- */

  const hoverX = hover !== null && main ? main.x[hover] : null
  const hoverSeries =
    hover !== null && main
      ? visible.filter((s) => !s.marker && !s.dashed && s.x.length === main.x.length)
      : []

  return (
    <div className="plot-card">
      <div className="plot-actions">
        <button
          type="button"
          className={measuring ? 'mini on' : 'mini ghost'}
          aria-pressed={measuring}
          onClick={() => {
            setMeasuring((m) => !m)
            if (measuring) {
              setCursorA(null)
              setCursorB(null)
            }
          }}
          title="开启后在曲线上点两下放置 A / B 游标，可拖动或按 ←/→ 微调，Esc 清除"
        >
          测量游标
        </button>
        {(cursorA !== null || cursorB !== null) && (
          <button
            type="button"
            className="mini ghost"
            onClick={() => {
              setCursorA(null)
              setCursorB(null)
            }}
          >
            清除游标
          </button>
        )}
        <button type="button" className="mini ghost" onClick={exportCsv} title="把当前显示的曲线导出为 CSV">
          {exported ? '已导出 ✓' : '导出 CSV'}
        </button>
      </div>
      <svg
        ref={svgRef}
        id={`plot-${uid}`}
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`${yLabel} 随 ${xLabel} 的曲线${measuring ? '，测量游标已开启' : ''}`}
        tabIndex={0}
        style={{ width: '100%', display: 'block', touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerDown={onDown}
        onPointerUp={() => {
          dragRef.current = null
        }}
        onPointerLeave={() => {
          setHover(null)
          dragRef.current = null
        }}
        onKeyDown={onKey}
      >
        <rect
          className="plot-screen"
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          rx={10}
          style={{ fill: 'var(--scope-bg)' }}
        />
        {/* 网格池：位置与文字由 paint() 写入，JSX 只声明静态样式 */}
        <g>
          {Array.from({ length: Y_TICK_POOL }, (_, i) => (
            <g key={`y${i}`}>
              <line data-ytick x1={M.left} x2={W - M.right} style={{ stroke: 'var(--scope-grid)' }} />
              <text data-ytick x={M.left - 8} fontSize={11} style={{ fill: 'var(--muted)' }} textAnchor="end" />
            </g>
          ))}
        </g>
        <g>
          {Array.from({ length: X_TICK_POOL }, (_, i) => (
            <g key={`x${i}`}>
              <line data-xtick y1={M.top} y2={H - M.bottom} style={{ stroke: 'var(--scope-grid)' }} />
              <text
                data-xtick
                y={H - M.bottom + 16}
                fontSize={11}
                style={{ fill: 'var(--muted)' }}
                textAnchor="middle"
              />
            </g>
          ))}
        </g>
        <line x1={M.left} x2={W - M.right} y1={H - M.bottom} y2={H - M.bottom} style={{ stroke: 'var(--scope-axis)' }} />
        <line x1={M.left} x2={M.left} y1={M.top} y2={H - M.bottom} style={{ stroke: 'var(--scope-axis)' }} />
        <text
          x={(M.left + W - M.right) / 2}
          y={H - 8}
          fontSize={12}
          style={{ fill: 'var(--text-3)' }}
          textAnchor="middle"
        >
          {xLabel}
        </text>
        <text
          transform={`rotate(-90 16 ${M.top + innerH / 2})`}
          x={16}
          y={M.top + innerH / 2}
          fontSize={12}
          style={{ fill: 'var(--text-3)' }}
          textAnchor="middle"
        >
          {yLabel}
        </text>

        {/* 测量游标（先画，压在波形下方） */}
        <g pointerEvents="none">
          {(['a', 'b'] as const).map((k) => (
            <g key={k}>
              <line
                data-cursor={k}
                y1={M.top}
                y2={H - M.bottom}
                strokeDasharray="4 4"
                style={{ stroke: k === 'a' ? 'var(--scope-cross)' : 'var(--accent)' }}
              />
              <text
                data-cursor-label={k}
                y={H - M.bottom - 8}
                fontSize={11}
                textAnchor="middle"
                style={{
                  fill: k === 'a' ? 'var(--scope-cross)' : 'var(--scope-ink)',
                  paintOrder: 'stroke',
                  stroke: 'var(--scope-bg)',
                  strokeWidth: 3,
                  strokeLinejoin: 'round',
                }}
              />
            </g>
          ))}
        </g>

        {/* 波形辉光层 */}
        {series.map((s, i) =>
          s.marker || s.dashed ? null : (
            <path
              key={`${s.label}-glow`}
              data-pglow
              data-pk={i}
              fill="none"
              stroke={s.color}
              strokeWidth={6}
              opacity={0.18}
              strokeLinecap="round"
              className={hidden.includes(s.label) ? 'plot-trace off' : 'plot-trace'}
            />
          ),
        )}
        {/* 波形主线 */}
        {series.map((s, i) =>
          s.marker ? null : (
            <path
              key={s.label}
              data-ptrace
              data-pk={i}
              fill="none"
              stroke={s.color}
              strokeWidth={s.dashed ? 1.4 : 1.9}
              strokeDasharray={s.dashed ? '6 5' : undefined}
              strokeLinejoin="round"
              className={hidden.includes(s.label) ? 'plot-trace off' : 'plot-trace'}
            />
          ),
        )}
        {/* 单点标记 */}
        {series.map((s, i) =>
          s.marker ? (
            <circle
              key={s.label}
              data-pdot
              data-pk={i}
              r={4.5}
              fill={s.color}
              style={{ stroke: 'var(--scope-bg)' }}
              strokeWidth={1.5}
              className={hidden.includes(s.label) ? 'plot-trace off' : 'plot-trace'}
            />
          ) : null,
        )}

        {hover !== null && hoverX !== null && !mainHidden && (
          <g pointerEvents="none">
            <line
              x1={pxAt(hoverX, dom, xLog, M.left, innerW)}
              x2={pxAt(hoverX, dom, xLog, M.left, innerW)}
              y1={M.top}
              y2={H - M.bottom}
              style={{ stroke: 'var(--scope-cross)' }}
              strokeDasharray="3 3"
            />
            {hoverSeries.map((s) => (
              <circle
                key={s.label}
                cx={pxAt(s.x[hover], dom, xLog, M.left, innerW)}
                cy={pyAt(s.y[hover], dom, M.top, innerH)}
                r={3.5}
                style={{ fill: 'var(--scope-bg)' }}
                stroke={s.color}
                strokeWidth={2}
              />
            ))}
            <g
              transform={`translate(${Math.min(
                pxAt(hoverX, dom, xLog, M.left, innerW) + 10,
                W - 216,
              )}, ${M.top + 8})`}
            >
              <rect
                width={206}
                height={20 + 16 * hoverSeries.length}
                rx={6}
                style={{ fill: 'var(--scope-bg)', stroke: 'var(--scope-axis)', opacity: 0.96 }}
              />
              <text x={10} y={16} fontSize={11} style={{ fill: 'var(--scope-ink)' }}>
                {`${xLabel.split(' ')[0]} = ${fmtTick(hoverX)}`}
              </text>
              {hoverSeries.map((s, i) => (
                <text key={s.label} x={10} y={32 + 16 * i} fontSize={11} fill={s.color}>
                  {`${s.label.split(' ')[0]}: ${fmtTick(s.y[hover])}`}
                </text>
              ))}
            </g>
          </g>
        )}
      </svg>

      <div className="legend">
        {series.map((s) => {
          const off = hidden.includes(s.label)
          return (
            <button
              key={s.label}
              type="button"
              className={off ? 'legend-item off' : 'legend-item'}
              aria-pressed={!off}
              title={off ? '点击显示该曲线' : '点击隐藏该曲线'}
              onClick={() => setHidden((h) => (h.includes(s.label) ? h.filter((x) => x !== s.label) : [...h, s.label]))}
            >
              <span
                className="legend-dot"
                style={{
                  background: s.color,
                  width: 10,
                  height: s.marker ? 10 : 3,
                  borderRadius: s.marker ? 5 : 2,
                }}
              />
              {s.label}
            </button>
          )
        })}
      </div>

      {read && (
        <div className="plot-cursor-read" role="status">
          <span className="pcr-head">
            Δx = <b>{fmtTick(read.dx)}{unitOf(xLabel)}</b>
            {cursorHz !== null && (
              <span className="pcr-sub"> · 等效 1/Δx = {fmtTick(cursorHz)} Hz</span>
            )}
          </span>
          {read.rows.map((r) => (
            <span key={r.label} className="pcr-row">
              <span className="legend-dot" style={{ background: colorOf(r.label), width: 10, height: 3, borderRadius: 2 }} />
              {r.label}：{fmtTick(r.y0)}{unitOf(yLabel)} → {fmtTick(r.y1)}{unitOf(yLabel)}
              <b>（Δ {r.dy >= 0 ? '+' : ''}{fmtTick(r.dy)}{unitOf(yLabel)}）</b>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
