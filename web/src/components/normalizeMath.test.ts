import { describe, expect, it } from 'vitest'

import { normalizeMath } from './normalizeMath'

const PMATRIX = '\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}'

describe('normalizeMath', () => {
  it('已在 $...$ 内的矩阵块保持原样（不再嵌套 $$）', () => {
    const input = `$\\det${PMATRIX}=ad-bc$`
    expect(normalizeMath(input)).toBe(input)
  })

  it('已在 $$...$$ 内的矩阵块保持原样', () => {
    const input = `$$${PMATRIX}$$`
    expect(normalizeMath(input)).toBe(input)
  })

  it('裸矩阵块包装为独立 $$ 段', () => {
    expect(normalizeMath(PMATRIX)).toBe(`\n$$${PMATRIX}$$\n`)
  })

  it('\\[...\\] 转为 $$...$$，其中矩阵块不被二次包装', () => {
    expect(normalizeMath(`\\[${PMATRIX}\\]`)).toBe(`\n$$${PMATRIX}$$\n`)
  })

  it('\\(...\\) 转为 $...$', () => {
    expect(normalizeMath('\\(E=mc^2\\)')).toBe('$E=mc^2$')
  })

  it('普通文本中的方括号行内公式仍转换', () => {
    expect(normalizeMath('见 [x^2 + \\alpha] 一节')).toBe('见 $$x^2 + \\alpha$$ 一节')
  })

  it('数学段内的方括号内容不转换', () => {
    const input = '$[x^2 + \\alpha]$'
    expect(normalizeMath(input)).toBe(input)
  })

  it('混合文本：正文中的矩阵块转 $$，已有的行内公式不受影响', () => {
    const out = normalizeMath(`公式 $x^2$ 与矩阵 ${PMATRIX} 一起`)
    expect(out).toBe(`公式 $x^2$ 与矩阵 \n$$${PMATRIX}$$\n 一起`)
  })
})
