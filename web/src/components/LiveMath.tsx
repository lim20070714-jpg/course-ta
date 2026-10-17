import katex from 'katex'
import { useMemo, useState } from 'react'
import {
  cellTex,
  parseMatrix,
  setMatrixCell,
  slotTex,
  type LiveNode,
  type ParsedMatrix,
  type ScriptNode,
  type SlotField,
  type SlotNode,
} from '../compute/liveMath'

interface Props {
  nodes: LiveNode[]
  values: Record<SlotField, string>
  onSlot(field: SlotField, raw: string): void
  /** 矩阵格子的编辑写回表达式（它不是参数，就是式子本身的一部分）。 */
  onExpr(next: string): void
  onRun(): void
  /** 原始表达式文本（可以还没填）。 */
  exprTex: string
  /** 空参数会让算法变得跟式子看起来不一样时的说明。 */
  notes: string[]
}

/** 一个可点的数学值：key 定位到具体哪一处，同一个参数出现两次也只会有一个输入框。 */
interface ValueProps {
  id: string
  label: string
  value: string
  tex: string
  /** true = 这里真的没值，画空心框。 */
  blank: boolean
  hint: string
  numeric: boolean
  open: boolean
  onEdit(id: string | null): void
  onInput(raw: string): void
  onCommit(): void
}

/** 行内 KaTeX：整条算式（含参数值）都走同一条渲染路径，字号与基线才可能一致。 */
function useTex(source: string): string {
  return useMemo(
    () => katex.renderToString(source, { throwOnError: false, displayMode: false, output: 'html' }),
    [source],
  )
}

export function InlineMath({ tex }: { tex: string }) {
  const html = useTex(tex)
  return <span className="pv-tex" dangerouslySetInnerHTML={{ __html: html }} />
}

/**
 * 参数与矩阵元素共用的编辑单元：平时是式子里的一个数学值（点它才变成输入框），
 * 所以预览看起来就是一条算式，而不是「算式 + 一排控件」。
 */
function MathValue(v: ValueProps) {
  const html = useTex(v.tex)
  if (!v.open) {
    const click = () => v.onEdit(v.id)
    return v.blank ? (
      <button
        type="button"
        className="pv-slot pv-slot-blank"
        title={`${v.label}：还没填，点击输入`}
        aria-label={`填写${v.label}`}
        onClick={click}
      />
    ) : (
      <button
        type="button"
        className={v.value.trim() ? 'pv-slot filled' : 'pv-slot'}
        title={`${v.label}：点击修改`}
        aria-label={`修改${v.label}`}
        onClick={click}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    )
  }
  const width = Math.min(12, Math.max(v.value.length, v.hint.length, 2) + 1)
  return (
    <input
      autoFocus
      className="pv-slot pv-slot-edit"
      style={{ width: `${width}ch` }}
      aria-label={v.label}
      placeholder={v.hint}
      title={v.label}
      inputMode={v.numeric ? 'numeric' : undefined}
      value={v.value}
      onChange={(e) => v.onInput(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          v.onEdit(null)
          v.onCommit()
        } else if (e.key === 'Escape') {
          v.onEdit(null)
        }
      }}
      onBlur={() => v.onEdit(null)}
    />
  )
}

function SlotView({
  node,
  value,
  id,
  open,
  onEdit,
  onSlot,
  onRun,
}: {
  node: SlotNode
  value: string
  id: string
  open: boolean
  onEdit: (id: string | null) => void
  onSlot: Props['onSlot']
  onRun: Props['onRun']
}) {
  return (
    <MathValue
      id={id}
      label={node.label}
      value={value}
      tex={slotTex(node.field, value)}
      blank={!value.trim() && !node.hintTex}
      hint={node.hint}
      numeric={Boolean(node.numeric)}
      open={open}
      onEdit={onEdit}
      onInput={(raw) => onSlot(node.field, raw)}
      onCommit={onRun}
    />
  )
}

/** 矩阵：解析成功就是带括号的可点网格，解析不了就退回原始表达式。 */
function MatrixView({
  m,
  id,
  editing,
  onEdit,
  onExpr,
  onRun,
}: {
  m: ParsedMatrix
  id: string
  editing: string | null
  onEdit: (id: string | null) => void
  onExpr: Props['onExpr']
  onRun: Props['onRun']
}) {
  const cols = m.rows[0]?.length ?? 1
  return (
    <>
      {m.prefix && <InlineMath tex={m.prefix.startsWith('\\') ? m.prefix : `\\operatorname{${m.prefix}}`} />}
      <span className={`pv-matrix pv-style-${m.style}`}>
        <span className="pv-grid" style={{ gridTemplateColumns: `repeat(${cols}, max-content)` }}>
          {m.rows.map((row, r) =>
            row.map((cell, c) => (
              <MathValue
                key={`${r}-${c}`}
                id={`${id}.${r}.${c}`}
                label={`第 ${r + 1} 行第 ${c + 1} 列`}
                value={cell}
                tex={cellTex(cell)}
                blank={!cell.trim()}
                hint={cell || '0'}
                numeric={false}
                open={editing === `${id}.${r}.${c}`}
                onEdit={onEdit}
                onInput={(raw) => onExpr(setMatrixCell(m, r, c, raw))}
                onCommit={onRun}
              />
            )),
          )}
        </span>
      </span>
    </>
  )
}

function renderNodes(
  nodes: LiveNode[],
  p: Props,
  editing: string | null,
  onEdit: (id: string | null) => void,
  path: string,
) {
  return nodes.map((node, i) => {
    const id = `${path}.${i}`
    switch (node.k) {
      case 'tex':
        return <InlineMath key={i} tex={node.tex} />
      case 'text':
        return (
          <span key={i} className="pv-text">
            {node.t}
          </span>
        )
      case 'expr':
        return p.exprTex.trim() ? (
          <InlineMath key={i} tex={p.exprTex} />
        ) : (
          <span key={i} className="pv-blank">
            表达式
          </span>
        )
      case 'matrix': {
        const m = parseMatrix(p.exprTex)
        if (!m) {
          return p.exprTex.trim() ? (
            <InlineMath key={i} tex={p.exprTex} />
          ) : (
            <span key={i} className="pv-blank">
              矩阵
            </span>
          )
        }
        return (
          <MatrixView
            key={i}
            m={m}
            id={`m${id}`}
            editing={editing}
            onEdit={onEdit}
            onExpr={p.onExpr}
            onRun={p.onRun}
          />
        )
      }
      case 'slot':
        return (
          <SlotView
            key={i}
            node={node}
            value={p.values[node.field]}
            id={`s${id}`}
            open={editing === `s${id}`}
            onEdit={onEdit}
            onSlot={p.onSlot}
            onRun={p.onRun}
          />
        )
      case 'scripts':
        return (
          <span key={i} className={`pv-scripts${scriptShift(node)}`}>
            <span className="pv-base">{renderNodes(node.base, p, editing, onEdit, `${id}b`)}</span>
            <span className="pv-sscript">
              {node.sup && (
                <span className="pv-script-line">{renderNodes(node.sup, p, editing, onEdit, `${id}u`)}</span>
              )}
              {node.sub && (
                <span className="pv-script-line">{renderNodes(node.sub, p, editing, onEdit, `${id}l`)}</span>
              )}
            </span>
          </span>
        )
      case 'frac':
        return (
          <span key={i} className="pv-frac">
            <span className="pv-script-line">{renderNodes(node.num, p, editing, onEdit, `${id}n`)}</span>
            <span className="pv-script-line pv-den">{renderNodes(node.den, p, editing, onEdit, `${id}d`)}</span>
          </span>
        )
    }
  })
}

/** 只有一侧角标时按上标 / 下标的位置排；两侧都有才居中（∫ 的上下限就是这种）。 */
function scriptShift(node: ScriptNode): string {
  if (node.sup && !node.sub) return ' pv-sup'
  if (node.sub && !node.sup) return ' pv-sub'
  return ''
}

/** 把「操作 + 参数」排成一条算式：参数与矩阵元素都是算式里的数学值，点击就地改。 */
export default function LiveMath(p: Props) {
  const [editing, setEditing] = useState<string | null>(null)
  return (
    <>
      <div className="live-row">{renderNodes(p.nodes, p, editing, setEditing, 'n')}</div>
      {p.notes.length > 0 && <p className="pv-note">{p.notes.join('；')}</p>}
    </>
  )
}
