/**
 * 实验台 / 计算台的“仪器”纯函数：坐标轴刻度、波形重采样、游标测量与 CSV 导出。
 *
 * 这里的函数都不接触 DOM，方便单测；组件只负责把结果画出来。
 * 关键约定：
 * - 波形重采样只改变采样点密度，不改变数学结论；越界点用 NaN 表示（绘图/导出时视为空档）。
 * - 游标读数按 x 值就近取样，因此拖动游标或改变参数后仍然指向同一时刻/频率。
 */

export interface Domain {
  xMin: number
  xMax: number
  yMin: number
  yMax: number
}

export interface TraceLike {
  x: number[]
  y: number[]
}

/** 轴刻度的“好看”步长：1 / 2 / 5 × 10ⁿ */
export function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  const norm = raw / mag
  const step = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10
  return step * mag
}

/** 三位有效数字的紧凑写法（去掉尾随 0） */
export function trimNum(v: number): string {
  return String(parseFloat(v.toPrecision(3)))
}

const SI_STEPS: [number, string][] = [
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
]

/** 轴刻度文字：带工程前缀，超出范围时退回科学计数 */
export function fmtTick(v: number): string {
  if (v === 0) return '0'
  if (!Number.isFinite(v)) return '—'
  const a = Math.abs(v)
  for (const [s, p] of SI_STEPS) {
    if (a >= s) return `${trimNum(v / s)}${p}`
  }
  return v.toExponential(0)
}

function log10(v: number): number {
  return Math.log10(Math.max(v, 1e-12))
}

/** 与 Plot 内部一致的域计算：跳过非有限点，留 2% / 8% 余量 */
export function plotDomain(traces: TraceLike[], xLog: boolean): Domain {
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  for (const s of traces) {
    const n = Math.min(s.x.length, s.y.length)
    for (let i = 0; i < n; i++) {
      const xv = xLog ? log10(s.x[i]) : s.x[i]
      const yv = s.y[i]
      if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue
      if (xv < xMin) xMin = xv
      if (xv > xMax) xMax = xv
      if (yv < yMin) yMin = yv
      if (yv > yMax) yMax = yv
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
}

/** 数据值 → 像素 x（xLog 时以 log10 变换） */
export function pxAt(v: number, dom: Domain, xLog: boolean, left: number, width: number): number {
  const span = dom.xMax - dom.xMin || 1
  const t = ((xLog ? log10(v) : v) - dom.xMin) / span
  return left + t * width
}

/** 数据值 → 像素 y（SVG 坐标向下） */
export function pyAt(v: number, dom: Domain, top: number, height: number): number {
  const span = dom.yMax - dom.yMin || 1
  return top + height - ((v - dom.yMin) / span) * height
}

export interface AxisTick {
  /** 刻度值（xLog 时为 log10 空间的值） */
  value: number
  /** 在轴上的相对位置 0…1 */
  ratio: number
}

/**
 * 线性轴刻度：步长由 niceStep 决定，最多返回 maxCount 条（超出时按整数间隔抽稀）。
 * 返回值保证落在 [min, max] 内。
 */
export function axisTicks(min: number, max: number, target: number, maxCount: number): AxisTick[] {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min || maxCount <= 0) return []
  const step = niceStep((max - min) / Math.max(1, target))
  const raw: number[] = []
  const start = Math.ceil(min / step - 1e-9) * step
  for (let i = 0; i < 4096; i++) {
    const v = start + i * step
    if (v > max + 1e-9) break
    raw.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  }
  const stride = raw.length > maxCount ? Math.ceil(raw.length / maxCount) : 1
  const out: AxisTick[] = []
  for (let i = 0; i < raw.length; i += stride) {
    out.push({ value: raw[i], ratio: (raw[i] - min) / (max - min) })
  }
  return out.slice(0, maxCount)
}

/** 对数轴刻度：在 log10 空间取整数指数，最多 maxCount 条 */
export function logTicks(minLog: number, maxLog: number, maxCount: number): AxisTick[] {
  if (!Number.isFinite(minLog) || !Number.isFinite(maxLog) || maxLog <= minLog || maxCount <= 0) return []
  // +0 归一化：Math.ceil(-1e-9) 会得到 -0，会把标签写成 "-0"
  const e0 = Math.ceil(minLog - 1e-9) + 0
  const e1 = Math.floor(maxLog + 1e-9) + 0
  const count = e1 - e0 + 1
  if (count <= 0) return []
  const stride = Math.ceil(count / maxCount)
  const out: AxisTick[] = []
  for (let e = e0; e <= e1; e += stride) {
    out.push({ value: e === 0 ? 0 : e, ratio: (e - minLog) / (maxLog - minLog) })
  }
  return out.slice(0, maxCount)
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** 入场缓动：起步快、收尾慢，适合数值跟随 */
export function easeOutCubic(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t
  return 1 - Math.pow(1 - c, 3)
}

/**
 * 把 (xs, ys) 线性重采样到 targetX 上；越界或非有限的源值返回 NaN。
 * 用于参数变化后“从旧波形平滑过渡到新波形”。
 */
export function resampleOnto(xs: number[], ys: number[], targetX: number[]): number[] {
  const n = Math.min(xs.length, ys.length)
  const out: number[] = new Array(targetX.length)
  if (n === 0) {
    out.fill(NaN)
    return out
  }
  if (n === 1) {
    for (let i = 0; i < targetX.length; i++) out[i] = targetX[i] === xs[0] ? ys[0] : NaN
    return out
  }
  let j = 0
  for (let i = 0; i < targetX.length; i++) {
    const tx = targetX[i]
    if (!Number.isFinite(tx) || tx < xs[0] || tx > xs[n - 1]) {
      out[i] = NaN
      continue
    }
    while (j < n - 2 && xs[j + 1] < tx) j++
    const a = xs[j]
    const b = xs[j + 1]
    const ya = ys[j]
    const yb = ys[j + 1]
    if (!Number.isFinite(ya) || !Number.isFinite(yb)) {
      out[i] = Number.isFinite(ya) && a === tx ? ya : NaN
      continue
    }
    if (b === a) out[i] = ya
    else out[i] = lerp(ya, yb, (tx - a) / (b - a))
  }
  return out
}

/** 在 xs 中找到最接近 target 的下标（xs 视为按 x 有序；空数组返回 -1） */
export function nearestIndex(xs: number[], target: number): number {
  const n = xs.length
  if (n === 0) return -1
  if (n === 1) return 0
  // 升序采样（绝大多数情况）用二分；降序时退回线性扫描
  if (xs[n - 1] >= xs[0]) {
    let lo = 0
    let hi = n - 1
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1
      if (xs[mid] <= target) lo = mid
      else hi = mid
    }
    return Math.abs(xs[lo] - target) <= Math.abs(xs[hi] - target) ? lo : hi
  }
  let best = 0
  let bestD = Infinity
  for (let i = 0; i < n; i++) {
    const d = Math.abs(xs[i] - target)
    if (d < bestD) {
      bestD = d
      best = i
    }
  }
  return best
}

export interface CursorRow {
  label: string
  y0: number
  y1: number
  /** y1 - y0，即两游标之间的增量 */
  dy: number
}

/** 时间单位 → 每秒的倍数（把 ±Δ 的时间跨度换成频率） */
const TIME_UNITS: Record<string, number> = { s: 1, ms: 1e3, 'µs': 1e6, us: 1e6, ns: 1e9 }

/**
 * 时间轴上的 Δx 换算成频率（Hz）：例如 Δt = 2.57 ms → 389 Hz。
 * 非时间单位（Ω / Hz / dB…）返回 null，避免出现 1/Δ 这种没有物理意义的读数。
 */
export function timeToHz(dx: number, unit: string): number | null {
  const k = TIME_UNITS[unit]
  if (!k || !Number.isFinite(dx) || dx === 0) return null
  return k / dx
}

export interface CursorRead {
  xa: number
  xb: number
  dx: number
  /** 1/dx（斜坡/周期的常用换算），dx 为 0 或非有限时为 null */
  invDx: number | null
  rows: CursorRow[]
}

/**
 * 双游标测量：按 x 值就近取样，给出 Δx、1/Δx 以及每条曲线的 Δy。
 * 两条游标重合或没有可用数据时返回 null。
 */
export function cursorRead(
  xs: number[],
  traces: { label: string; y: number[] }[],
  xa: number,
  xb: number,
): CursorRead | null {
  if (xs.length === 0) return null
  const ia = nearestIndex(xs, xa)
  const ib = nearestIndex(xs, xb)
  if (ia < 0 || ib < 0) return null
  const ax = xs[ia]
  const bx = xs[ib]
  const dx = bx - ax
  const rows: CursorRow[] = []
  for (const tr of traces) {
    const y0 = tr.y[ia]
    const y1 = tr.y[ib]
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) continue
    rows.push({ label: tr.label, y0, y1, dy: y1 - y0 })
  }
  // 一条可用曲线都没有时，Δx 本身没有意义
  if (rows.length === 0) return null
  return { xa: ax, xb: bx, dx, invDx: dx !== 0 && Number.isFinite(dx) ? 1 / dx : null, rows }
}

function csvCell(text: string): string {
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}
function csvNum(v: number): string {
  return Number.isFinite(v) ? String(v) : ''
}

export interface CsvTrace extends TraceLike {
  label: string
}

/**
 * 导出波形为 CSV：以采样点最多的曲线为基准列，其余曲线重采样对齐。
 * 非有限值导出为空单元格，方便直接丢进 Excel / Python。
 */
export function toCsv(xLabel: string, traces: CsvTrace[]): string {
  if (traces.length === 0) return ''
  let base = traces[0]
  for (const t of traces) {
    if (t.x.length > base.x.length) base = t
  }
  const lines: string[] = [[csvCell(xLabel), ...traces.map((t) => csvCell(t.label))].join(',')]
  const aligned = traces.map((t) => (t === base ? t.y : resampleOnto(t.x, t.y, base.x)))
  for (let i = 0; i < base.x.length; i++) {
    const cells = [csvNum(base.x[i])]
    for (const ys of aligned) cells.push(csvNum(ys[i]))
    lines.push(cells.join(','))
  }
  return lines.join('\n')
}
