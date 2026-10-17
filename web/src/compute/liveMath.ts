/**
 * 实时预览的参数槽位：把「操作 + 参数」排成一行可直接编辑的算式。
 * 改上下限、变量、展开点、阶数都发生在预览本身，而不是下面另一排输入框。
 * 线性代数的矩阵也在这里改：预览把 `[[1,2],[3,4]]` / `\begin{pmatrix}…` 解析成格子，
 * 点某个元素就只改那一个元素，写回仍然是合法矩阵语法。
 *
 * 槽位集合必须与 ops.ts 的 opNeeds 一致：预览里出现的槽就是后端真正会收的入参，
 * 少一个会丢参数，多一个会给出一个改了没用的框。
 */

import { opNeeds } from './ops'

export type SlotField = 'variable' | 'point' | 'lower' | 'upper' | 'order'

export interface SlotNode {
  k: 'slot'
  field: SlotField
  label: string // aria-label：同一个 point 在极限里是「趋近值」，在留数里是「奇点」
  hint: string // 输入框里的示例
  hintTex: string // 未填写时式子里显示的数学占位
  numeric?: boolean
}

export interface TexNode {
  k: 'tex'
  tex: string
}

export interface TextNode {
  k: 'text'
  t: string
}

export interface ExprNode {
  k: 'expr'
}

export interface ScriptNode {
  k: 'scripts'
  base: LiveNode[]
  sub?: LiveNode[]
  sup?: LiveNode[]
}

export interface FracNode {
  k: 'frac'
  num: LiveNode[]
  den: LiveNode[]
}

/** 矩阵：内容由表达式本身解析而来（parseMatrix），编辑写回表达式而不是参数。 */
export interface MatrixNode {
  k: 'matrix'
}

export type LiveNode = SlotNode | TexNode | TextNode | ExprNode | ScriptNode | FracNode | MatrixNode

const LABELS: Record<SlotField, string> = {
  variable: '变量',
  point: '展开点',
  lower: '积分下限',
  upper: '积分上限',
  order: '阶数',
}

const HINTS: Record<SlotField, string> = {
  variable: 'x',
  point: '0',
  lower: '-oo',
  upper: '+oo',
  order: '1',
}

/**
 * 没填的时候式子里显示什么——必须与后端 evaluate() 的默认值一致：
 * var 空 → x、point 空 → 0、order 空 → 1；上下限空 **不是** ±∞，而是不定积分，
 * 所以那两个槽留空（渲染成空框）并由 liveNotes 说明，免得预览骗人。
 */
const HINT_TEX: Record<SlotField, string> = {
  variable: 'x',
  point: '0',
  lower: '',
  upper: '',
  order: '1',
}

/** 空值的真实含义，显示在算式后面（只有后端行为与「看起来的意思」不同才需要）。 */
const EMPTY_NOTES: Partial<Record<SlotField, string>> = {
  lower: '上下限不填就是不定积分',
  upper: '上下限不填就是不定积分',
}

const slot = (field: SlotField, label?: string): SlotNode => ({
  k: 'slot',
  field,
  label: label ?? LABELS[field],
  hint: HINTS[field],
  hintTex: HINT_TEX[field],
  ...(field === 'order' ? { numeric: true } : {}),
})

const tex = (value: string): TexNode => ({ k: 'tex', tex: value })
const text = (value: string): TextNode => ({ k: 'text', t: value })
const EXPR: ExprNode = { k: 'expr' }
const MATRIX: MatrixNode = { k: 'matrix' }
/** 只有上标的角标组（用于 d^{n} 这种纯上标）。 */
const supOf = (...nodes: LiveNode[]): ScriptNode => ({ k: 'scripts', base: [], sup: nodes })

/**
 * `\frac{d^{[n]}}{d[x]^{[n]}}`：阶数槽在分子分母各出现一次，改哪一处都写回同一个值——
 * 既保证「想升阶永远有入口」，也不用在式子旁边另找输入框。
 */
function derivative(glyph: string): LiveNode[] {
  const symbol = tex(glyph)
  return [
    {
      k: 'frac',
      num: [symbol, supOf(slot('order'))],
      den: [symbol, slot('variable'), supOf(slot('order'))],
    },
    tex('('),
    EXPR,
    tex(')'),
  ]
}

/** 变换类：`\mathcal{L}_{[t]}( f )`。逆傅里叶不吃变量，槽位也就不能出现。 */
function transform(name: string, inverse: boolean, withVariable: boolean): LiveNode[] {
  const nodes: LiveNode[] = [
    {
      k: 'scripts',
      base: [tex(`\\mathcal{${name}}`)],
      sub: withVariable ? [slot('variable')] : undefined,
      sup: inverse ? [tex('-1')] : undefined,
    },
    tex('('),
    EXPR,
    tex(')'),
  ]
  return nodes
}

export function liveMath(op: string): LiveNode[] {
  switch (op) {
    case 'diff':
      return derivative('d')
    case 'partial':
      return derivative('\\partial')
    case 'integrate':
      return [
        { k: 'scripts', base: [tex('\\int')], sub: [slot('lower')], sup: [slot('upper')] },
        EXPR,
        tex('\\,d'),
        slot('variable'),
      ]
    case 'limit':
      return [
        {
          k: 'scripts',
          base: [tex('\\lim')],
          sub: [slot('variable'), tex('\\to'), slot('point', '趋近值')],
        },
        EXPR,
      ]
    case 'taylor':
    case 'series':
      return [EXPR, text('在'), slot('variable'), tex('='), slot('point'), text('处展到'), slot('order'), text('阶')]
    case 'residue':
      return [
        {
          k: 'scripts',
          base: [tex('\\operatorname{Res}')],
          sub: [slot('variable'), tex('\\to'), slot('point', '奇点')],
        },
        EXPR,
      ]
    case 'solve':
      return [EXPR, text('关于'), slot('variable'), text('求解')]
    case 'apart':
      return [EXPR, text('按'), slot('variable'), text('分解')]
    case 'fourier':
      return transform('F', false, true)
    case 'inverse_fourier':
      return transform('F', true, false)
    case 'laplace':
      return transform('L', false, true)
    case 'inverse_laplace':
      return transform('L', true, true)
    default:
      // 线性代数：矩阵元素本身就是可改的；化简 / 展开 / 复数：只有表达式本身
      return opNeeds(op).matrix ? [MATRIX] : [EXPR]
  }
}

/** 预览里出现的全部参数槽（含嵌在角标里的）。 */
export function liveSlots(nodes: LiveNode[]): SlotNode[] {
  const found: SlotNode[] = []
  const walk = (list: LiveNode[]) => {
    for (const n of list) {
      if (n.k === 'slot') {
        if (!found.some((s) => s.field === n.field)) found.push(n)
      } else if (n.k === 'scripts') {
        walk(n.base)
        if (n.sub) walk(n.sub)
        if (n.sup) walk(n.sup)
      } else if (n.k === 'frac') {
        walk(n.num)
        walk(n.den)
      }
    }
  }
  walk(nodes)
  return found
}

/** 这行预览里出现了哪些参数槽——决定表达式为空时预览是否仍要渲染。 */
export function liveFields(nodes: LiveNode[]): SlotField[] {
  return liveSlots(nodes).map((s) => s.field)
}

/** 空着不填会改变算法（而不只是取个默认值）时，给一句说明。 */
export function liveNotes(nodes: LiveNode[], values: Record<SlotField, string>): string[] {
  const notes: string[] = []
  for (const s of liveSlots(nodes)) {
    const note = EMPTY_NOTES[s.field]
    if (note && !values[s.field].trim() && !notes.includes(note)) notes.push(note)
  }
  return notes
}

/** 阶数是数字槽：只认数字、限幅 1..20，清空算 1。 */
export function clampOrder(raw: string): number {
  const digits = raw.replace(/\D/g, '')
  if (!digits) return 1
  return Math.min(20, Math.max(1, Number(digits)))
}

/**
 * 把槽位里的文本转成可以直接交给 KaTeX 的源码，让参数以数学体长在式子里。
 * 返回空串表示这里就是空的（渲染成空框）——上下限空着不代表 ±∞，而是不定积分。
 */
export function slotTex(field: SlotField, raw: string): string {
  const value = raw.trim()
  return value ? valueTex(value) : HINT_TEX[field]
}

/** 矩阵单元格：填什么就是什么，空着就真的是空着。 */
export const cellTex = valueTex

/** 用户写法到 KaTeX 源码的最小转换：`oo` 认无穷，中文按文本排版而不是让公式报红。 */
function valueTex(value: string): string {
  const v = value.trim()
  if (!v) return ''
  const infinity = v.match(/^([+-]?)oo$/i)
  if (infinity) return `${infinity[1] || ''}\\infty`
  // 花括号要摘掉，否则 \text{} 会提前闭合（后端仍收到原始文本）
  if (/[^\x20-\x7f]/.test(v)) return `\\text{${v.replaceAll(/[{}]/g, '')}}`
  return v
}

export type MatrixStyle = 'bracket' | 'pmatrix' | 'bmatrix' | 'vmatrix' | 'matrix'

export interface ParsedMatrix {
  style: MatrixStyle
  /** 矩阵外面的 `\det` 之类包装，写回时原样带回，免得改一个元素把式子改没了。 */
  prefix: string
  rows: string[][]
}

const ENV_STYLE: Record<string, MatrixStyle> = {
  pmatrix: 'pmatrix',
  bmatrix: 'bmatrix',
  vmatrix: 'vmatrix',
  matrix: 'matrix',
  array: 'matrix',
}

const STYLE_ENV: Record<MatrixStyle, string> = {
  pmatrix: 'pmatrix',
  bmatrix: 'bmatrix',
  vmatrix: 'vmatrix',
  matrix: 'matrix',
  bracket: 'pmatrix',
}

/** `\left[ … \right]` 这类外层装饰只用来决定括号形状。 */
const WRAP_STYLE: Record<string, MatrixStyle> = { '[': 'bmatrix', '(': 'pmatrix', '|': 'vmatrix' }

const MAX_SIZE = 8

/** 按括号深度切分：`\frac{1}{2}` 里的逗号 / `&` 不会被当成单元格分隔。 */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (ch === '{' || ch === '(' || ch === '[') depth += 1
    else if (ch === '}' || ch === ')' || ch === ']') depth -= 1
    else if (depth === 0 && text.startsWith(sep, i)) {
      parts.push(text.slice(start, i).trim())
      i += sep.length - 1
      start = i + 1
    }
  }
  parts.push(text.slice(start).trim())
  return parts
}

function shapeOk(rows: string[][]): boolean {
  if (!rows.length || rows.length > MAX_SIZE) return false
  const cols = rows[0].length
  if (!cols || cols > MAX_SIZE) return false
  return rows.every((r) => r.length === cols && r.every((c) => c.length > 0))
}

/**
 * 认这三种写法（与后端 `_parse_matrix` 支持的口子一致）：
 * `[[1,2],[3,4]]`、`\begin{pmatrix}…\end{pmatrix}`（含 bmatrix / vmatrix / matrix / array）、
 * 以及它们外面的 `\det` 前缀与 `=ad-bc` 尾巴（后端也只取等号左边）。
 * 认不出来的（比如 `\det(A-\lambda I)`、矩阵相加）返回 null，预览退回原始表达式渲染。
 */
export function parseMatrix(raw: string): ParsedMatrix | null {
  let text = raw.trim().replace(/^\$+|\$+$/g, '')
  if (!text) return null
  const eq = text.indexOf('=')
  if (eq >= 0) text = text.slice(0, eq).trim()

  let prefix = ''
  const wrapped = text.match(/^(\\(?:operatorname\s*\{det\}|mathrm\s*\{det\}|det)|det)\s*/i)
  if (wrapped) {
    prefix = wrapped[1]
    text = text.slice(wrapped[0].length).trim()
  }

  // 外层的 \left[ … \right] 只是装饰，取它决定用哪种括号
  let wrapStyle: MatrixStyle | null = null
  const outer = text.match(/^\\left\s*(\[|\(|\|)([\s\S]*?)\\right\s*(?:\]|\)|\|)$/)
  if (outer) {
    wrapStyle = WRAP_STYLE[outer[1]] ?? null
    text = outer[2].trim()
  }

  const env = text.match(/^\\begin\{([a-zA-Z*]+)\}([\s\S]*?)\\end\{\1\}$/)
  if (env) {
    const style = wrapStyle ?? ENV_STYLE[env[1]]
    if (!style) return null
    let body = env[2]
    if (env[1] === 'array') body = body.replace(/^\s*\{[^}]*\}/, '') // array 的列格式说明不是内容
    const rows = body
      .split('\\\\')
      .filter((r) => r.trim())
      .map((r) => splitTop(r, '&'))
    return shapeOk(rows) ? { style, prefix, rows } : null
  }

  if (text.startsWith('[') && text.endsWith(']')) {
    const rowTexts = splitTop(text.slice(1, -1), ',')
    if (!rowTexts.every((r) => r.startsWith('[') && r.endsWith(']'))) return null
    const rows = rowTexts.map((r) => splitTop(r.slice(1, -1), ','))
    return shapeOk(rows) ? { style: 'bracket', prefix, rows } : null
  }
  return null
}

/** 写回表达式：保持原来的记法（`[[...]]` 还是 `[[...]]`，pmatrix 还是 pmatrix）。 */
export function matrixSource(m: ParsedMatrix): string {
  const body =
    m.style === 'bracket'
      ? `[${m.rows.map((r) => `[${r.join(', ')}]`).join(', ')}]`
      : `\\begin{${STYLE_ENV[m.style]}}${m.rows.map((r) => r.join('&')).join('\\\\')}\\end{${STYLE_ENV[m.style]}}`
  return m.prefix ? `${m.prefix}${m.style === 'bracket' ? ' ' : ''}${body}` : body
}

/**
 * 改一个单元格 = 重写整个表达式（其余部分原样保留）。
 * 矩阵里清空一格没有「无」这个取值，按 0 处理——预览显示什么就发什么。
 */
export function setMatrixCell(m: ParsedMatrix, row: number, col: number, value: string): string {
  const next = value.trim() || '0'
  const rows = m.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? next : c)) : [...r]))
  return matrixSource({ ...m, rows })
}
