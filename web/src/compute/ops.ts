export interface OpDef {
  id: string
  label: string
}

export const OP_GROUPS: { label: string; ops: OpDef[] }[] = [
  {
    label: '微积分',
    ops: [
      { id: 'diff', label: '导数 / 偏导数' },
      { id: 'integrate', label: '积分（可填上下限）' },
      { id: 'limit', label: '极限' },
      { id: 'taylor', label: '泰勒展开' },
      { id: 'solve', label: '解方程' },
    ],
  },
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
    label: '变换',
    ops: [
      { id: 'fourier', label: '傅里叶变换（ω 约定）' },
      { id: 'inverse_fourier', label: '逆傅里叶变换' },
      { id: 'laplace', label: '拉普拉斯变换' },
      { id: 'inverse_laplace', label: '逆拉普拉斯变换' },
    ],
  },
  {
    label: '线性代数',
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
    label: '复数',
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
  'partial',
  'integrate',
  'limit',
  'taylor',
  'series',
  'solve',
  'apart',
  'residue',
  'laplace',
  'inverse_laplace',
  'fourier',
])
const _POINT_OPS = new Set(['limit', 'taylor', 'series', 'residue'])
const _ORDER_OPS = new Set(['diff', 'partial', 'taylor', 'series'])
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

export const CATEGORIES = ['微积分', '代数', '变换', '线性代数', '复数', '物理与工程', '自定义']

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

/** 矩阵模板：选中线性代数操作时提供快捷插入。 */
export const MATRIX_TEMPLATES = [
  { label: '2×2 矩阵', text: '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}' },
  { label: '3×3 矩阵', text: '\\begin{pmatrix}a&b&c\\\\d&e&f\\\\g&h&i\\end{pmatrix}' },
]

/** 把表达式包装为可预览的 LaTeX（普通语法按 $...$ 直出）。 */
export function toPreviewTex(expr: string): string {
  return `$${expr}$`
}

/**
 * 「作为输入」回填哪一种写法。结果有两种形式：`latex` 是数学源码，`plain` 是 sympy 的
 * 文本形式（`x**5/120 - x**3/6`）。回填后要在预览里读得通，所以取 `latex`——
 * 后端 parse_input 见到反斜杠就走 parse_latex，能原样再吃回去。
 * 特征值那类带中文注记（`重数`）的没法回读，退回 plain 至少不骗人。
 */
export function asInputTex(result: { latex: string; plain: string }): string {
  const tex = result.latex.replace(/\\displaystyle/g, '').trim()
  if (!tex || /[\u4e00-\u9fa5]/.test(tex)) return result.plain
  return tex
}

/** 可折叠的写法提示：每条都会真的送去 KaTeX 排版，所以示例本身必须是合法 LaTeX（有测试钉住）。 */
export const TEX_HINTS: { tex: string; meaning: string }[] = [
  { tex: '\\frac{a}{b}', meaning: '分数，分子分母都要用花括号' },
  { tex: 'x^{n+1}', meaning: '上标；两个字符以上必须括起来' },
  { tex: 'e^{-x^2}', meaning: '指数常这样写，花括号可以直接混用' },
  { tex: '\\sqrt{x}\\,,\\ \\sqrt[3]{x}', meaning: '开方，第三个参数是根指数' },
  { tex: '\\int_0^{\\infty} f\\,dx', meaning: '积分；上下限也能在预览的算式里点着改' },
  { tex: '\\sum_{k=1}^{n} k', meaning: '求和，下标是起点与变量' },
  { tex: '\\lim_{x \\to 0}', meaning: '极限的趋近写法' },
  { tex: '\\partial_x f', meaning: '偏导（操作选「偏导数」更稳）' },
  { tex: '\\pi\\,,\\ e\\,,\\ i', meaning: '圆周率 / 自然底数 / 虚数单位' },
  { tex: '\\omega\\,,\\ \\alpha\\,,\\ \\theta', meaning: '希腊字母，输入 \\ 后也能选快捷符号' },
  { tex: '\\infty\\,,\\ \\infty', meaning: '无穷；上下限里写 oo 也一样' },
  { tex: '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}', meaning: '矩阵：& 分隔列，\\\\ 分隔行，元素能在预览里点着改' },
  { tex: '[[1,2],[3,4]]', meaning: '矩阵的另一种写法，纯文本更好手打' },
  { tex: '2x\\,,\\ 3\\sin(x)', meaning: '普通语法：省略乘号、函数名后接括号' },
]
