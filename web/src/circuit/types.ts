/** 电路网表类型定义与统一错误类型。 */

export class CircuitError extends Error {}

export interface Resistor {
  kind: 'R'
  id: string
  a: string
  b: string
  /** 单位：Ω，必须为有限正数 */
  resistance: number
}

export interface Capacitor {
  kind: 'C'
  id: string
  a: string
  b: string
  /** 单位：F，必须为有限正数 */
  capacitance: number
  /** 瞬态分析的初始电压 v(a)-v(b)，默认 0 */
  initialVoltage?: number
}

export interface Inductor {
  kind: 'L'
  id: string
  a: string
  b: string
  /** 单位：H，必须为有限正数 */
  inductance: number
  /** 瞬态分析的初始电流（沿 a→b 方向），默认 0 */
  initialCurrent?: number
}

/**
 * 电源波形：v(t) = base + amplitude·f(t)，
 * 正弦 f = sin(2πft)，方波 f = sign(sin(2πft))（占空比 50%，t=0 起为正）。
 * base 即元件自身的 voltage/current 字段（直流分量 / 偏置）。
 */
export interface SourceWave {
  shape: 'sin' | 'square'
  /** 振幅（峰值），单位同元件值 */
  amplitude: number
  /** 频率，单位 Hz */
  frequency: number
}

export interface VoltageSource {
  kind: 'V'
  id: string
  a: string
  b: string
  /** 理想电压源：直流值或波形的直流偏置，约束 v(a) - v(b) = 该值 */
  voltage: number
  /** 瞬态分析中的时变波形；缺省为恒定直流源 */
  wave?: SourceWave
}

export interface CurrentSource {
  kind: 'I'
  id: string
  a: string
  b: string
  /** 电流源将 current 安培沿 b→a 方向泵过自身，外部电路中电流由 a 流向 b；含波形时为直流偏置 */
  current: number
  /** 瞬态分析中的时变波形；缺省为恒定直流源 */
  wave?: SourceWave
}

export interface OpAmp {
  kind: 'OA'
  id: string
  /** 同相输入端节点 */
  p: string
  /** 反相输入端节点 */
  n: string
  /** 输出端节点 */
  out: string
}

export type CircElement =
  | Resistor
  | Capacitor
  | Inductor
  | VoltageSource
  | CurrentSource
  | OpAmp

export interface Circuit {
  /** 参考地节点标签，默认 "0" */
  ground?: string
  elements: CircElement[]
}
