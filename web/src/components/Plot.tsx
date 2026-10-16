import { useMemo, useRef, useState } from 'react'

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
const M = { top: 14, right: 18, bottom: 42, left: 64 }

function niceStep(raw: number): number {
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10
  return step * mag
}

function trimNum(v: number): string {
  return String(parseFloat(v.toPrecision(3)))
}

function fmtTick(v: number): string {
  if (v === 0) return '0'
  const a = Math.abs(v)
  const units: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
  ]
  for (const [s, p] of units) {
    if (a >= s) return `${trimNum(v / s)}${p}`
  }
  return v.toExponential(0)
}

export default function Plot({ series, xLabel, yLabel, xLog = false, height = 320 }: PlotProps) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<number | null>(null)

  const H = height
  const innerW = W - M.left - M.right
  const innerH = H - M.top - M.bottom
  const tx = (v: number) => (xLog ? Math.log10(Math.max(v, 1e-12)) : v)

  const domain = useMemo(() => {
    let xMin = Infinity
    let xMax = -Infinity
    let yMin = Infinity
    let yMax = -Infinity
    for (const s of series) {
      for (let i = 0; i < s.x.length; i++) {
        const xv = xLog ? Math.log10(Math.max(s.x[i], 1e-12)) : s.x[i]
        const yv = s.y[i]
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue
        xMin = Math.min(xMin, xv)
        xMax = Math.max(xMax, xv)
        yMin = Math.min(yMin, yv)
        yMax = Math.max(yMax, yv)
      }
    }
    if (!Number.isFinite(xMin)) return { xMin: 0, xMax: 1, yMin: 0, yMax: 1 }
    if (xMax - xMin < 1e-12) xMax = xMin + 1
    if (yMax - yMin < 1e-12) {
      const mid = (yMax + yMin) / 2
      yMin = mid - 0.5
      yMax = mid + 0.5
    }
    const padX = (xMax - xMin) * 0.02
    const padY = (yMax - yMin) * 0.08
    return { xMin: xMin - padX, xMax: xMax + padX, yMin: yMin - padY, yMax: yMax + padY }
  }, [series, xLog])

  const px = (v: number) => M.left + ((tx(v) - domain.xMin) / (domain.xMax - domain.xMin)) * innerW
  const py = (v: number) =>
    M.top + innerH - ((v - domain.yMin) / (domain.yMax - domain.yMin)) * innerH

  const yTicks = useMemo(() => {
    const step = niceStep((domain.yMax - domain.yMin) / 5)
    const out: number[] = []
    for (let t = Math.ceil(domain.yMin / step) * step; t <= domain.yMax + 1e-9; t += step) {
      out.push(t)
    }
    return out
  }, [domain])

  const xTicks = useMemo(() => {
    if (xLog) {
      const e0 = Math.ceil(domain.xMin)
      const e1 = Math.floor(domain.xMax)
      const count = e1 - e0 + 1
      const stride = count > 9 ? Math.ceil(count / 9) : 1
      const out: number[] = []
      for (let e = e0; e <= e1; e += stride) out.push(Math.pow(10, e))
      return out
    }
    const step = niceStep((domain.xMax - domain.xMin) / 7)
    const out: number[] = []
    for (let t = Math.ceil(domain.xMin / step) * step; t <= domain.xMax + 1e-9; t += step) {
      out.push(t)
    }
    return out
  }, [domain, xLog])

  const main = series.find((s) => !s.marker && s.x.length > 1)

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!main || !svgRef.current) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx = ((e.clientX - rect.left) / rect.width) * W
    let best = 0
    let bestD = Infinity
    for (let i = 0; i < main.x.length; i++) {
      const d = Math.abs(px(main.x[i]) - mx)
      if (d < bestD) {
        bestD = d
        best = i
      }
    }
    setHover(best)
  }

  const pathOf = (s: PlotSeries): string => {
    let d = ''
    let pen = false
    for (let i = 0; i < s.x.length; i++) {
      const yv = s.y[i]
      if (!Number.isFinite(yv)) {
        pen = false
        continue
      }
      d += `${pen ? 'L' : 'M'}${px(s.x[i]).toFixed(1)} ${py(yv).toFixed(1)}`
      pen = true
    }
    return d
  }

  const hoverX = hover !== null && main !== undefined ? main.x[hover] : null
  const hoverSeries =
    hover !== null && main !== undefined
      ? series.filter((s) => !s.marker && !s.dashed && s.x.length === main.x.length)
      : []

  return (
    <div className="plot-card">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', display: 'block', touchAction: 'none' }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <rect
          x={M.left}
          y={M.top}
          width={innerW}
          height={innerH}
          rx={10}
          style={{ fill: 'var(--scope-bg)' }}
        />
        {yTicks.map((t) => (
          <g key={`y${t}`}>
            <line
              x1={M.left}
              x2={W - M.right}
              y1={py(t)}
              y2={py(t)}
              style={{ stroke: 'var(--scope-grid)' }}
            />
            <text x={M.left - 8} y={py(t) + 4} fontSize={11} style={{ fill: 'var(--muted)' }} textAnchor="end">
              {fmtTick(t)}
            </text>
          </g>
        ))}
        {xTicks.map((t) => (
          <g key={`x${t}`}>
            <line
              y1={M.top}
              y2={H - M.bottom}
              x1={px(t)}
              x2={px(t)}
              style={{ stroke: 'var(--scope-grid)' }}
            />
            <text x={px(t)} y={H - M.bottom + 16} fontSize={11} style={{ fill: 'var(--muted)' }} textAnchor="middle">
              {fmtTick(t)}
            </text>
          </g>
        ))}
        <line
          x1={M.left}
          x2={W - M.right}
          y1={H - M.bottom}
          y2={H - M.bottom}
          style={{ stroke: 'var(--scope-axis)' }}
        />
        <line
          x1={M.left}
          x2={M.left}
          y1={M.top}
          y2={H - M.bottom}
          style={{ stroke: 'var(--scope-axis)' }}
        />
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

        {series
          .filter((s) => !s.marker && !s.dashed)
          .map((s) => (
            <path
              key={`${s.label}-glow`}
              d={pathOf(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={5.5}
              opacity={0.22}
              strokeLinecap="round"
            />
          ))}
        {series
          .filter((s) => !s.marker)
          .map((s) => (
            <path
              key={s.label}
              d={pathOf(s)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.dashed ? 1.4 : 2}
              strokeDasharray={s.dashed ? '6 5' : undefined}
            />
          ))}
        {series
          .filter((s) => s.marker)
          .map((s) => (
            <circle
              key={s.label}
              cx={px(s.x[0])}
              cy={py(s.y[0])}
              r={4.5}
              fill={s.color}
              style={{ stroke: 'var(--scope-bg)' }}
              strokeWidth={1.5}
            />
          ))}

        {hover !== null && hoverX !== null && (
          <g>
            <line
              x1={px(hoverX)}
              x2={px(hoverX)}
              y1={M.top}
              y2={H - M.bottom}
              style={{ stroke: 'var(--scope-cross)' }}
              strokeDasharray="3 3"
            />
            {hoverSeries.map((s) => (
              <circle
                key={s.label}
                cx={px(s.x[hover])}
                cy={py(s.y[hover])}
                r={3.5}
                style={{ fill: 'var(--scope-bg)' }}
                stroke={s.color}
                strokeWidth={2}
              />
            ))}
            <g transform={`translate(${Math.min(px(hoverX) + 10, W - 214)}, ${M.top + 8})`}>
              <rect
                width={204}
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
        {series.map((s) => (
          <span key={s.label} className="legend-item">
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
          </span>
        ))}
      </div>
    </div>
  )
}
