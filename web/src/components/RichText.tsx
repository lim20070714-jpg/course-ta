import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

/** 把模型常用的其它公式定界符归一化为 $$...$$ / $...$，供 remark-math 解析。 */
function normalizeMath(src: string): string {
  return src
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, body: string) => `\n$$${body}$$\n`)
    .replace(/\\\(([\s\S]*?)\\\)/g, (_, body: string) => `$${body}$`)
    .replace(
      /(\\begin\{[a-zA-Z*]+\}[\s\S]*?\\end\{[a-zA-Z*]+\})/g,
      (block: string) => `\n$$${block}$$\n`,
    )
    .replace(/\[([^[\]\n]*\\[a-zA-Z]+[^[\]\n]*)\]/g, (_, body: string) => `$$${body}$$`)
}

/** Markdown + GFM + KaTeX 渲染（公式定界符已归一化）。 */
export default function RichText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
    >
      {normalizeMath(text)}
    </Markdown>
  )
}
