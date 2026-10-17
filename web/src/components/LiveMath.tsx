import katex from 'katex'
import { useMemo, useState } from 'react'
import { slotTex, type LiveNode, type ScriptNode, type SlotField, type SlotNode } from '../compute/liveMath'

interface Props {
  nodes: LiveNode[]
  values: Record<SlotField, string>
  onSlot(field: SlotField, raw: string): void
  onRun(): void
  /** 原始表达式文本（可以还没填）。 */
  exprTex: string
  /** 空参数会让算法变得跟式子看起来不一样时的说明。 */
  notes: string[]
}

/** 行内 KaTeX：整条算式（含参数值）都走同一条渲染路径，字号与基线才可能一致。 */
function useTex(source: string): string {
  return useMemo(
    () => katex.renderToString(source, { throwOnError: false, displayMode: false, output: 'html' }),
    [source],
  )
}

function Tex({ tex }: { tex: string }) {
  const html = useTex(tex)
  return <span className="pv-tex" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 参数槽：平时是式子里的一个数学值（点它才变成输入框），
 * 所以预览看起来就是一条算式，而不是「算式 + 一排控件」。
 */
function Slot({
  node,
  value,
  editing,
  onEdit,
  onSlot,
  onRun,
}: {
  node: SlotNode
  value: string
  editing: boolean
  onEdit(field: SlotField | null): void
  onSlot: Props['onSlot']
  onRun: () => void
}) {
  const html = useTex(slotTex(node.field, value))
  const blank = !value.trim() && !node.hintTex
  if (!editing) {
    return blank ? (
      <button
        type="button"
        className="pv-slot pv-slot-blank"
        title={`${node.label}：还没填，点击输入`}
        aria-label={`填写${node.label}`}
        onClick={() => onEdit(node.field)}
      />
    ) : (
      <button
        type="button"
        className={value.trim() ? 'pv-slot filled' : 'pv-slot'}
        title={`${node.label}：点击修改`}
        aria-label={`修改${node.label}`}
        onClick={() => onEdit(node.field)}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  const width = Math.min(12, Math.max(value.length, node.hint.length, 2) + 1)
  return (
    <input
      autoFocus
      className="pv-slot pv-slot-edit"
      style={{ width: `${width}ch` }}
      aria-label={node.label}
      placeholder={node.hint}
      title={node.label}
      inputMode={node.numeric ? 'numeric' : undefined}
      value={value}
      onChange={(e) => onSlot(node.field, e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          onEdit(null)
          onRun()
        } else if (e.key === 'Escape') {
          onEdit(null)
        }
      }}
      onBlur={() => onEdit(null)}
    />
  )
}

/** 只有一侧角标时按上标 / 下标的位置排；两侧都有才居中（∫ 的上下限就是这种）。 */
function scriptShift(node: ScriptNode): string {
  if (node.sup && !node.sub) return ' pv-sup'
  if (node.sub && !node.sup) return ' pv-sub'
  return ''
}

function renderNodes(nodes: LiveNode[], p: Props, editing: SlotField | null, onEdit: (f: SlotField | null) => void) {
  return nodes.map((node, i) => {
    switch (node.k) {
      case 'tex':
        return <Tex key={i} tex={node.tex} />
      case 'text':
        return (
          <span key={i} className="pv-text">
            {node.t}
          </span>
        )
      case 'expr':
        return p.exprTex.trim() ? (
          <Tex key={i} tex={p.exprTex} />
        ) : (
          <span key={i} className="pv-blank">
            表达式
          </span>
        )
      case 'slot':
        return (
          <Slot
            key={i}
            node={node}
            value={p.values[node.field]}
            editing={editing === node.field}
            onEdit={onEdit}
            onSlot={p.onSlot}
            onRun={p.onRun}
          />
        )
      case 'scripts':
        return (
          <span key={i} className={`pv-scripts${scriptShift(node)}`}>
            <span className="pv-base">{renderNodes(node.base, p, editing, onEdit)}</span>
            <span className="pv-sscript">
              {node.sup && (
                <span className="pv-script-line">{renderNodes(node.sup, p, editing, onEdit)}</span>
              )}
              {node.sub && (
                <span className="pv-script-line">{renderNodes(node.sub, p, editing, onEdit)}</span>
              )}
            </span>
          </span>
        )
      case 'frac':
        return (
          <span key={i} className="pv-frac">
            <span className="pv-script-line">{renderNodes(node.num, p, editing, onEdit)}</span>
            <span className="pv-script-line pv-den">{renderNodes(node.den, p, editing, onEdit)}</span>
          </span>
        )
    }
  })
}

/** 把「操作 + 参数」排成一条算式：参数是算式里的数学值，点击就地改。 */
export default function LiveMath(p: Props) {
  const [editing, setEditing] = useState<SlotField | null>(null)
  return (
    <>
      <div className="live-row">{renderNodes(p.nodes, p, editing, setEditing)}</div>
      {p.notes.length > 0 && <p className="pv-note">{p.notes.join('；')}</p>}
    </>
  )
}
