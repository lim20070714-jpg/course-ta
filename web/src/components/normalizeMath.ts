/** 把模型常用的其它公式定界符归一化为 $$...$$ / $...$，供 remark-math 解析。
 *
 * 已处于 $...$ / $$...$$ 数学段内的内容保持原样：否则矩阵块（\begin{pmatrix} 等）
 * 会在行内公式里被二次包装成嵌套 $$，KaTeX 解析失败、整段渲染成红色报错。
 */
export function normalizeMath(src: string): string {
  const pre = src
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`)
  const parts = pre.split(/(\$\$[\s\S]*?\$\$|\$[^$]*?\$)/g)
  return parts
    .map((seg, i) => {
      if (i % 2 === 1) return seg
      return seg
        .replace(
          /(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})/g,
          (block: string) => `\n$$${block}$$\n`,
        )
        .replace(/\[([^[\]\n]*\\[a-zA-Z]+[^[\]\n]*)\]/g, (_, body: string) => `$$${body}$$`)
    })
    .join('')
}
