/**
 * 预置实验定义：电路构建、参数滑块、仿真运行与读数。
 * 全部数值来自自研 MNA 仿真内核（web/src/circuit），与手算结果一致。
 */

import {
  magnitude,
  solveDC,
  solveTransient,
  sweep,
  toDb,
  type Circuit,
} from '../circuit'

export interface LabParam {
  key: string
  label: string
  unit: string
  min: number
  max: number
  step: number
  default: number
  /** 对数滑块（适合跨数量级的元件值） */
  log?: boolean
}

export interface LabSeries {
  label: string
  color: string
  x: number[]
  y: number[]
  dashed?: boolean
  marker?: boolean
}

export interface Readout {
  label: string
  value: string
}

export interface LabRun {
  xLabel: string
  yLabel: string
  xLog?: boolean
  series: LabSeries[]
  readouts: Readout[]
}

export interface Lab {
  id: string
  title: string
  chapter: string
  description: string
  params: LabParam[]
  run: (p: Record<string, number>) => LabRun
}

const C = { main: '#2f5bd8', second: '#d8622f', ref: '#9aa1b2', peak: '#2fae66' }

/** 数字 → 带工程前缀的字符串，如 0.004995 A → "5 mA" */
export function formatSi(value: number, unit: string): string {
  if (value === 0) return `0 ${unit}`
  const a = Math.abs(value)
  const units: [number, string][] = [
    [1e9, 'G'],
    [1e6, 'M'],
    [1e3, 'k'],
    [1, ''],
    [1e-3, 'm'],
    [1e-6, 'µ'],
    [1e-9, 'n'],
    [1e-12, 'p'],
  ]
  for (const [s, p] of units) {
    if (a >= s) return `${fmtNum(value / s)} ${p}${unit}`
  }
  return `${value.toExponential(2)} ${unit}`
}

export function fmtNum(v: number, digits = 3): string {
  return String(parseFloat(v.toPrecision(digits)))
}

export const LABS: Lab[] = [
  {
    id: 'divider',
    title: '电阻分压器',
    chapter: '电路基本定律',
    description:
      '两电阻串联分压：v_out = V·R₂/(R₁+R₂)。拖动滑块观察输出电压、电流与功率的变化，曲线给出输出电压随 R₂ 的完整关系。',
    params: [
      { key: 'vin', label: '电源 V₁', unit: 'V', min: 1, max: 24, step: 0.5, default: 12 },
      { key: 'r1', label: '上电阻 R₁', unit: 'Ω', min: 10, max: 1e5, step: 1, default: 1000, log: true },
      { key: 'r2', label: '下电阻 R₂', unit: 'Ω', min: 10, max: 1e5, step: 1, default: 2000, log: true },
    ],
    run(p) {
      const circuit: Circuit = {
        elements: [
          { kind: 'V', id: 'V1', a: '1', b: '0', voltage: p.vin },
          { kind: 'R', id: 'R1', a: '1', b: '2', resistance: p.r1 },
          { kind: 'R', id: 'R2', a: '2', b: '0', resistance: p.r2 },
        ],
      }
      const { nodes, currents } = solveDC(circuit)
      const vout = nodes['2']

      const r2s: number[] = []
      const vouts: number[] = []
      const n = 80
      const lo = Math.log10(10)
      const hi = Math.log10(1e5)
      for (let i = 0; i <= n; i++) {
        const r2 = Math.pow(10, lo + ((hi - lo) * i) / n)
        r2s.push(r2)
        vouts.push((p.vin * r2) / (p.r1 + r2))
      }

      return {
        xLabel: 'R₂ (Ω)',
        yLabel: 'v_out (V)',
        xLog: true,
        series: [
          { label: 'v_out(R₂)', color: C.main, x: r2s, y: vouts },
          {
            label: `当前工作点 R₂ = ${formatSi(p.r2, 'Ω')}`,
            color: C.peak,
            x: [p.r2],
            y: [vout],
            marker: true,
          },
        ],
        readouts: [
          { label: '输出电压 v_out', value: formatSi(vout, 'V') },
          { label: '回路电流', value: formatSi(currents['R1'], 'A') },
          { label: '分压比', value: `${fmtNum((vout / p.vin) * 100, 4)} %` },
          { label: 'R₂ 功率', value: formatSi((vout * vout) / p.r2, 'W') },
        ],
      }
    },
  },
  {
    id: 'rc',
    title: 'RC 充电暂态',
    chapter: '一阶动态电路',
    description:
      't=0 开关闭合，电容经电阻充电：τ = RC，v_C(τ) ≈ 0.632·V，约 5τ 后进入稳态。曲线同时给出电阻电压 v_R = V - v_C。',
    params: [
      { key: 'v', label: '电源 V₁', unit: 'V', min: 1, max: 10, step: 0.5, default: 5 },
      { key: 'r', label: '电阻 R₁', unit: 'Ω', min: 100, max: 1e5, step: 1, default: 1000, log: true },
      { key: 'c', label: '电容 C₁', unit: 'F', min: 1e-7, max: 1e-3, step: 1e-7, default: 1e-6, log: true },
    ],
    run(p) {
      const tau = p.r * p.c
      const duration = 5 * tau
      const steps = 2000
      const dt = duration / steps
      const circuit: Circuit = {
        elements: [
          { kind: 'V', id: 'V1', a: '1', b: '0', voltage: p.v },
          { kind: 'R', id: 'R1', a: '1', b: '2', resistance: p.r },
          { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: p.c },
        ],
      }
      const res = solveTransient(circuit, { dt, duration })
      const si = duration < 1e-3
      const x = res.t.map((t) => t * (si ? 1e6 : 1e3))
      const vc = res.nodes['2']
      const vr = vc.map((v) => p.v - v)
      const i0 = res.currents['C1'][1]
      return {
        xLabel: `t (${si ? 'µs' : 'ms'})`,
        yLabel: '电压 (V)',
        series: [
          { label: 'v_C(t) 电容电压', color: C.main, x, y: vc },
          { label: 'v_R(t) 电阻电压', color: C.second, x, y: vr },
        ],
        readouts: [
          { label: '时间常数 τ = RC', value: formatSi(tau, 's') },
          { label: 'v_C(τ)（理论 0.632·V）', value: `${vc[400].toFixed(3)} V` },
          { label: '稳态 v_C(5τ)', value: `${vc[vc.length - 1].toFixed(3)} V` },
          { label: '初始电流 i(0⁺) = V/R', value: formatSi(i0, 'A') },
        ],
      }
    },
  },
  {
    id: 'rl',
    title: 'RL 电流建立',
    chapter: '一阶动态电路',
    description:
      '电感电流从 0 按指数规律上升：τ = L/R，稳态电流 V/R。t=0⁺ 时电感电流不能突变，全部电源电压由电感承担。',
    params: [
      { key: 'v', label: '电源 V₁', unit: 'V', min: 1, max: 10, step: 0.5, default: 5 },
      { key: 'r', label: '电阻 R₁', unit: 'Ω', min: 100, max: 1e4, step: 1, default: 1000, log: true },
      { key: 'l', label: '电感 L₁', unit: 'H', min: 1e-3, max: 10, step: 1e-3, default: 1, log: true },
    ],
    run(p) {
      const tau = p.l / p.r
      const duration = 5 * tau
      const steps = 2000
      const dt = duration / steps
      const circuit: Circuit = {
        elements: [
          { kind: 'V', id: 'V1', a: '1', b: '0', voltage: p.v },
          { kind: 'R', id: 'R1', a: '1', b: '2', resistance: p.r },
          { kind: 'L', id: 'L1', a: '2', b: '0', inductance: p.l },
        ],
      }
      const res = solveTransient(circuit, { dt, duration })
      const si = duration < 1e-3
      const x = res.t.map((t) => t * (si ? 1e6 : 1e3))
      const iMa = res.currents['L1'].map((i) => i * 1e3)
      const isteady = (p.v / p.r) * 1e3
      return {
        xLabel: `t (${si ? 'µs' : 'ms'})`,
        yLabel: '电流 (mA)',
        series: [
          { label: 'i_L(t) 电感电流', color: C.main, x, y: iMa },
          { label: '稳态 i(∞) = V/R', color: C.ref, x: [x[0], x[x.length - 1]], y: [isteady, isteady], dashed: true },
        ],
        readouts: [
          { label: '时间常数 τ = L/R', value: formatSi(tau, 's') },
          { label: 'i_L(τ)（理论 0.632·I∞）', value: `${iMa[400].toFixed(3)} mA` },
          { label: '稳态电流 i(∞)', value: `${isteady.toFixed(2)} mA` },
          { label: 'v_L(0⁺) 电感初始电压', value: `${p.v.toFixed(2)} V` },
        ],
      }
    },
  },
  {
    id: 'rc-lowpass',
    title: 'RC 低通滤波器',
    chapter: '正弦稳态与频率响应',
    description:
      '一阶低通的幅频特性：截止频率 f_c = 1/(2πRC)，f_c 处衰减 3 dB，之后按 -20 dB/十倍频 下降。',
    params: [
      { key: 'r', label: '电阻 R₁', unit: 'Ω', min: 100, max: 1e5, step: 1, default: 1000, log: true },
      { key: 'c', label: '电容 C₁', unit: 'F', min: 1e-7, max: 1e-3, step: 1e-7, default: 1e-6, log: true },
    ],
    run(p) {
      const fc = 1 / (2 * Math.PI * p.r * p.c)
      const circuit: Circuit = {
        elements: [
          { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
          { kind: 'R', id: 'R1', a: '1', b: '2', resistance: p.r },
          { kind: 'C', id: 'C1', a: '2', b: '0', capacitance: p.c },
        ],
      }
      const sw = sweep(circuit, { fStart: fc / 100, fStop: fc * 100, points: 121 })
      const out = sw.nodes['2']
      return {
        xLabel: 'f (Hz)',
        yLabel: '|H| (dB)',
        xLog: true,
        series: [
          { label: '幅频 |v_out/V₁|', color: C.main, x: sw.f, y: out.map((v) => toDb(v)) },
          {
            label: '-3 dB',
            color: C.ref,
            x: [fc / 100, fc * 100],
            y: [-3.0103, -3.0103],
            dashed: true,
          },
        ],
        readouts: [
          { label: '截止频率 f_c = 1/(2πRC)', value: `${fmtNum(fc, 5)} Hz` },
          { label: 'f_c 处 |H|（理论 0.707）', value: fmtNum(magnitude(out[60]), 4) },
          { label: '100·f_c 处 |H|', value: magnitude(out[120]).toFixed(4) },
          { label: '倍频衰减', value: '≈ 20 dB/十倍频（一阶）' },
        ],
      }
    },
  },
  {
    id: 'rlc',
    title: '串联 RLC 谐振',
    chapter: '谐振与频率响应',
    description:
      '串联谐振：f₀ = 1/(2π√(LC))，品质因数 Q = (1/R)·√(L/C)，谐振时电感与电容电压是电源电压的 Q 倍。',
    params: [
      { key: 'r', label: '电阻 R₁', unit: 'Ω', min: 1, max: 1e3, step: 1, default: 10, log: true },
      { key: 'l', label: '电感 L₁', unit: 'H', min: 1e-3, max: 0.1, step: 1e-3, default: 0.01, log: true },
      { key: 'c', label: '电容 C₁', unit: 'F', min: 1e-7, max: 1e-4, step: 1e-7, default: 1e-6, log: true },
    ],
    run(p) {
      const f0 = 1 / (2 * Math.PI * Math.sqrt(p.l * p.c))
      const q = Math.sqrt(p.l / p.c) / p.r
      const circuit: Circuit = {
        elements: [
          { kind: 'V', id: 'V1', a: '1', b: '0', voltage: 1 },
          { kind: 'R', id: 'R1', a: '1', b: '2', resistance: p.r },
          { kind: 'L', id: 'L1', a: '2', b: '3', inductance: p.l },
          { kind: 'C', id: 'C1', a: '3', b: '0', capacitance: p.c },
        ],
      }
      const sw = sweep(circuit, { fStart: f0 / 100, fStop: f0 * 100, points: 241 })
      const out = sw.nodes['3']
      let pk = 0
      for (let i = 1; i < out.length; i++) {
        if (magnitude(out[i]) > magnitude(out[pk])) pk = i
      }
      return {
        xLabel: 'f (Hz)',
        yLabel: '|v_C| (dB)',
        xLog: true,
        series: [
          { label: '电容电压 |v_C/V₁|', color: C.main, x: sw.f, y: out.map((v) => toDb(v)) },
          {
            label: `谐振峰 (${fmtNum(sw.f[pk], 4)} Hz)`,
            color: C.peak,
            x: [sw.f[pk]],
            y: [toDb(out[pk])],
            marker: true,
          },
        ],
        readouts: [
          { label: '谐振频率 f₀', value: `${fmtNum(f0, 5)} Hz` },
          { label: '品质因数 Q', value: fmtNum(q, 4) },
          { label: '通频带 BW = f₀/Q', value: `${fmtNum(f0 / q, 4)} Hz` },
          { label: '谐振时 v_C = Q·V₁', value: `${fmtNum(magnitude(out[pk]), 4)} V` },
        ],
      }
    },
  },
]
