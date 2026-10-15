import Markdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { normalizeMath } from './normalizeMath'

/** Markdown + GFM + KaTeX 渲染（公式定界符已归一化，保留单换行）。 */
export default function RichText({ text }: { text: string }) {
  return (
    <Markdown
      remarkPlugins={[remarkGfm, remarkMath]}
      rehypePlugins={[[rehypeKatex, { throwOnError: false }]]}
    >
      {normalizeMath(text).replace(/\n/g, '  \n')}
    </Markdown>
  )
}
