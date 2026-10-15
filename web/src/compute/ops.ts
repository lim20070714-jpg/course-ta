export interface OpDef {
  id: string
  label: string
}

export const OP_GROUPS: { label: string; ops: OpDef[] }[] = [
  {
    label: '代数',
    ops: [
      { id: 'simplify', label: '化简' },
      { id: 'expand', label: '展开' },
      { id: 'factor', label: '因式分解' },
      { id: 'apart', label: '部分分式' },
      { id: 'trigsimp', label: '三角化简' },
    ],
  },
  {
    label: '微积分',
    ops: [
      { id: 'diff', label: '求导' },
      { id: 'integrate', label: '积分' },
      { id: 'limit', label: '极限' },
      { id: 'series', label: '级数展开' },
      { id: 'solve', label: '解方程' },
    ],
  },
  {
    label: '变换',
    ops: [
      { id: 'laplace', label: '拉普拉斯变换' },
      { id: 'inverse_laplace', label: '逆拉普拉斯变换' },
    ],
  },
  {
    label: '矩阵',
    ops: [
      { id: 'det', label: '行列式' },
      { id: 'inv', label: '逆矩阵' },
      { id: 'transpose', label: '转置' },
      { id: 'rank', label: '秩' },
      { id: 'rref', label: '行最简形' },
      { id: 'eigen', label: '特征值' },
    ],
  },
  {
    label: '复变',
    ops: [
      { id: 'conjugate', label: '共轭' },
      { id: 'expand_complex', label: '展开为 x+yi' },
      { id: 'abs', label: '模' },
      { id: 'arg', label: '辐角' },
      { id: 're', label: '实部' },
      { id: 'im', label: '虚部' },
      { id: 'residue', label: '留数' },
    ],
  },
]

export interface OpParams {
  variable: boolean
  point: boolean
  bounds: boolean
  order: boolean
  matrix: boolean
}

const _VAR_OPS = new Set([
  'diff',
  'integrate',
  'limit',
  'series',
  'solve',
  'apart',
  'residue',
  'laplace',
  'inverse_laplace',
])
const _POINT_OPS = new Set(['limit', 'series', 'residue'])
const _ORDER_OPS = new Set(['diff', 'series'])
const _MATRIX_OPS = new Set(['det', 'inv', 'transpose', 'rank', 'rref', 'eigen'])

export function opNeeds(op: string): OpParams {
  return {
    variable: _VAR_OPS.has(op),
    point: _POINT_OPS.has(op),
    bounds: op === 'integrate',
    order: _ORDER_OPS.has(op),
    matrix: _MATRIX_OPS.has(op),
  }
}

export const CATEGORIES = ['高等微积分', '线性代数', '物理', '电子', '复变函数', '自定义']

export interface SymbolDef {
  name: string
  kind: string
}

export const SYMBOL_KINDS: { id: string; label: string }[] = [
  { id: 'complex', label: '复数（默认）' },
  { id: 'real', label: '实数' },
  { id: 'positive', label: '正数' },
  { id: 'negative', label: '负数' },
  { id: 'integer', label: '整数' },
]

/** 快捷符号面板：点击插入到输入框。 */
export const QUICK_SYMBOLS = [
  '\\pi',
  'e',
  'i',
  '\\infty',
  '\\alpha',
  '\\beta',
  '\\gamma',
  '\\theta',
  '\\lambda',
  '\\mu',
  '\\varphi',
  '\\omega',
  '\\Omega',
  '\\partial',
  '\\int',
  '\\sum',
  '\\lim',
  '\\frac{}{}',
  '\\sqrt{}',
  '^2',
]

/** 把表达式包装为可预览的 LaTeX（普通语法按 $...$ 直出）。 */
export function toPreviewTex(expr: string): string {
  return `$${expr}$`
}
