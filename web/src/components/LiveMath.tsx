import katex from 'katex'
import { type ReactNode, useMemo } from 'react'
import type { LiveNode, SlotField, SlotNode } from '../compute/liveMath'

interface Props {
  nodes: LiveNode[]
  values: Record<SlotField, string>
  onSlot(field: SlotField, raw: string): void
  onRun(): void
  expr: ReactNode
}

function Tex({ tex }: { tex: string }) {
  const html = useMemo(() => katex.renderToString(tex, { throwOnError: false, output: 'html' }), [tex])
  return <span className="pv-tex" dangerouslySetInnerHTML={{ __html: html }} />
}

/** 预览里的参数框：宽度跟着内容走，Enter 直接算。 */
function SlotFieldInput({
  node,
  value,
  onSlot,
  onRun,
}: {
  node: SlotNode
  value: string
  onSlot: Props['onSlot']
  onRun: () => void
}) {
  const width = Math.min(10, Math.max(value.length, node.hint.length) + 1)
  return (
    <input
      className="pv-slot"
      style={{ width: `${width}ch` }}
      aria-label={node.label}
      placeholder={node.hint}
      title={`${node.label}：改完按 Enter 直接计算`}
      inputMode={node.numeric ? 'numeric' : undefined}
      value={value}
      onChange={(e) => onSlot(node.field, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onRun()
      }}
    />
  )
}

function renderNodes(nodes: LiveNode[], p: Props): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.k) {
      case 'tex':
        return <Tex key={i} tex={node.tex} />
      case 'text':
        return <span key={i} className="pv-text">{node.t}</span>
      case 'expr':
        return <span key={i} className="pv-expr">{p.expr}</span>
      case 'slot':
        return (
          <SlotFieldInput key={i} node={node} value={p.values[node.field]} onSlot={p.onSlot} onRun={p.onRun} />
        )
      case 'scripts':
        return (
          <span key={i} className="pv-scripts">
            <span className="pv-base">{renderNodes(node.base, p)}</span>
            <span className="pv-sscript">
              {node.sup && <span className="pv-script-line">{renderNodes(node.sup, p)}</span>}
              {node.sub && <span className="pv-script-line">{renderNodes(node.sub, p)}</span>}
            </span>
          </span>
        )
      case 'frac':
        return (
          <span key={i} className="pv-frac">
            <span className="pv-script-line">{renderNodes(node.num, p)}</span>
            <span className="pv-script-line pv-den">{renderNodes(node.den, p)}</span>
          </span>
        )
    }
  })
}

/** 把「操作 + 参数」渲染成一行的算式，参数就地可改。 */
export default function LiveMath(p: Props) {
  return <div className="live-row">{renderNodes(p.nodes, p)}</div>
}
