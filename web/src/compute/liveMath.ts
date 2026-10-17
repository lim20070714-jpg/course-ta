/**
 * 实时预览的参数槽位：把「操作 + 参数」排成一行可直接编辑的算式。
 * 改上下限、变量、展开点、阶数都发生在预览本身，而不是下面另一排输入框。
 *
 * 槽位集合必须与 ops.ts 的 opNeeds 一致：预览里出现的槽就是后端真正会收的入参，
 * 少一个会丢参数，多一个会给出一个改了没用的框。
 */

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

export type LiveNode = SlotNode | TexNode | TextNode | ExprNode | ScriptNode | FracNode

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
      return [EXPR] // 化简 / 展开 / 因式分解 / 矩阵 / 复数：只有表达式本身
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
  if (!value) return HINT_TEX[field]
  const infinity = value.match(/^([+-]?)oo$/i)
  if (infinity) return `${infinity[1] || ''}\\infty`
  // 中文之类按文本排版；花括号要摘掉，否则 \text{} 会提前闭合（后端仍收到原始文本）
  if (/[^\x20-\x7f]/.test(value)) return `\\text{${value.replaceAll(/[{}]/g, '')}}`
  return value
}
