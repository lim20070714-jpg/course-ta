import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComputeResult, Formula } from '../api'
import { createFormula, deleteFormula, evaluateCompute, listFormulas, updateFormula } from '../api'
import RichText from '../components/RichText'
import {
  CATEGORIES,
  OP_GROUPS,
  QUICK_SYMBOLS,
  SYMBOL_KINDS,
  opNeeds,
  toPreviewTex,
  type SymbolDef,
} from '../compute/ops'

interface FormulaDraft {
  id: number | null
  title: string
  latex: string
  category: string
  note: string
}

const EMPTY_DRAFT: FormulaDraft = { id: null, title: '', latex: '', category: '自定义', note: '' }

export default function Compute() {
  const [formulas, setFormulas] = useState<Formula[]>([])
  const [category, setCategory] = useState('全部')
  const [notice, setNotice] = useState('')
  const [draft, setDraft] = useState<FormulaDraft | null>(null)

  const [expr, setExpr] = useState('')
  const [op, setOp] = useState('simplify')
  const [variable, setVariable] = useState('x')
  const [point, setPoint] = useState('0')
  const [lower, setLower] = useState('')
  const [upper, setUpper] = useState('')
  const [order, setOrder] = useState(1)
  const [symbols, setSymbols] = useState<SymbolDef[]>([])
  const [newSymbol, setNewSymbol] = useState('')
  const [newKind, setNewKind] = useState('real')

  const [result, setResult] = useState<ComputeResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const exprRef = useRef<HTMLTextAreaElement>(null)

  const needs = opNeeds(op)

  useEffect(() => {
    listFormulas()
      .then(setFormulas)
      .catch((e: Error) => setNotice(`加载公式库失败：${e.message}`))
  }, [])

  const categories = useMemo(() => {
    const used = new Set(formulas.map((f) => f.category))
    return ['全部', ...CATEGORIES.filter((c) => used.has(c) || c === '自定义')]
  }, [formulas])

  const shown = useMemo(
    () => (category === '全部' ? formulas : formulas.filter((f) => f.category === category)),
    [formulas, category],
  )

  function insert(text: string) {
    const el = exprRef.current
    if (!el) {
      setExpr((prev) => prev + text)
      return
    }
    const start = el.selectionStart ?? expr.length
    const end = el.selectionEnd ?? start
    setExpr(expr.slice(0, start) + text + expr.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(start + text.length, start + text.length)
    })
  }

  async function run() {
    const input = expr.trim()
    if (!input) {
      setError('请先输入表达式')
      return
    }
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const payload = {
        expr: input,
        op,
        var: variable,
        point,
        lower,
        upper,
        order,
        symbols,
      }
      setResult(await evaluateCompute(payload))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function saveDraft() {
    if (!draft) return
    const title = draft.title.trim()
    const latex = draft.latex.trim()
    if (!title || !latex) {
      setNotice('标题与公式内容不能为空')
      return
    }
    try {
      if (draft.id === null) {
        const created = await createFormula({
          title,
          latex,
          category: draft.category,
          note: draft.note,
        })
        setFormulas((fs) => [...fs, created])
      } else {
        const updated = await updateFormula(draft.id, {
          title,
          latex,
          category: draft.category,
          note: draft.note,
        })
        setFormulas((fs) => fs.map((f) => (f.id === updated.id ? updated : f)))
      }
      setDraft(null)
      setNotice('')
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function removeFormula(f: Formula) {
    if (!window.confirm(`删除公式「${f.title}」？`)) return
    try {
      await deleteFormula(f.id)
      setFormulas((fs) => fs.filter((x) => x.id !== f.id))
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  function addSymbol() {
    const name = newSymbol.trim().replace(/^\\/, '')
    if (!name || symbols.some((s) => s.name === name)) return
    setSymbols((ss) => [...ss, { name, kind: newKind }])
    setNewSymbol('')
  }

  return (
    <div className="compute-page">
      <aside className="compute-side">
        <div className="section-title">
          公式库（{formulas.length}）
          <button className="link" onClick={() => setDraft({ ...EMPTY_DRAFT })}>
            ＋ 新建
          </button>
        </div>
        <div className="chip-row">
          {categories.map((c) => (
            <button
              key={c}
              className={category === c ? 'chip active' : 'chip'}
              onClick={() => setCategory(c)}
            >
              {c}
            </button>
          ))}
        </div>
        {draft && (
          <div className="formula-editor">
            <input
              placeholder="标题，如：分部积分"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              rows={3}
              placeholder="公式内容（LaTeX），如：\int u\,dv = uv - \int v\,du"
              value={draft.latex}
              onChange={(e) => setDraft({ ...draft, latex: e.target.value })}
            />
            <select
              value={draft.category}
              onChange={(e) => setDraft({ ...draft, category: e.target.value })}
            >
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <input
              placeholder="备注（可选）"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <div className="row">
              <button className="mini" onClick={saveDraft}>
                {draft.id === null ? '添加' : '保存修改'}
              </button>
              <button className="mini ghost" onClick={() => setDraft(null)}>
                取消
              </button>
            </div>
          </div>
        )}
        <ul className="formula-list">
          {shown.map((f) => (
            <li key={f.id} className="formula-item">
              <button className="formula-insert" title="插入到输入框" onClick={() => insert(f.latex)}>
                <span className="formula-title">
                  {f.title}
                  {f.preset && <span className="formula-badge">预置</span>}
                </span>
                <span className="formula-preview">
                  <RichText text={toPreviewTex(f.latex)} />
                </span>
                {f.note && (
                  <span className="formula-note">
                    <RichText text={f.note} />
                  </span>
                )}
              </button>
              <div className="formula-actions">
                <button
                  className="link"
                  onClick={() =>
                    setDraft({
                      id: f.id,
                      title: f.title,
                      latex: f.latex,
                      category: f.category,
                      note: f.note,
                    })
                  }
                >
                  编辑
                </button>
                <button className="link danger" onClick={() => removeFormula(f)}>
                  删除
                </button>
              </div>
            </li>
          ))}
          {shown.length === 0 && <li className="empty">该分类下还没有公式</li>}
        </ul>
      </aside>

      <main className="compute-main">
        {notice && <div className="lib-notice">{notice}</div>}
        <div className="compute-card">
          <div className="compute-input-head">
            <span className="compute-hint">
              支持 LaTeX 或普通语法（如 2x、x^3、exp(-2t)）；定积分在下方填上下限，傅里叶变换按 ω 约定
            </span>
          </div>
          <textarea
            ref={exprRef}
            className="compute-expr"
            rows={3}
            placeholder="输入函数或表达式，如：e^{-x^2}、\frac{\sin x}{x}、\int_0^{+\infty} e^{-x^2} dx"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run()
            }}
          />
          <div className="chip-row">
            {QUICK_SYMBOLS.map((s) => (
              <button key={s} className="chip mono" onClick={() => insert(s)} title={`插入 ${s}`}>
                {symbolLabel(s)}
              </button>
            ))}
          </div>
          {expr.trim() && (
            <div className="compute-preview">
              <span className="preview-label">预览</span>
              <RichText text={toPreviewTex(expr)} />
            </div>
          )}
          <div className="compute-controls">
            <label>
              操作
              <select
                value={op}
                onChange={(e) => {
                  const next = e.target.value
                  setOp(next)
                  if ((next === 'taylor' || next === 'series') && order === 1) setOrder(6)
                }}
              >
                {OP_GROUPS.map((g) => (
                  <optgroup key={g.label} label={g.label}>
                    {g.ops.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {needs.variable && (
              <label>
                变量
                <input
                  className="w60"
                  value={variable}
                  onChange={(e) => setVariable(e.target.value)}
                  placeholder="x"
                />
              </label>
            )}
            {needs.bounds && (
              <>
                <label>
                  下限
                  <input value={lower} onChange={(e) => setLower(e.target.value)} placeholder="0" />
                </label>
                <label>
                  上限
                  <input value={upper} onChange={(e) => setUpper(e.target.value)} placeholder="1" />
                </label>
              </>
            )}
            {needs.point && (
              <label>
                {op === 'limit' ? '趋近于' : op === 'residue' ? '奇点' : '展开点'}
                <input value={point} onChange={(e) => setPoint(e.target.value)} placeholder="0" />
              </label>
            )}
            {needs.order && (
              <label>
                阶数
                <input
                  className="w60"
                  type="number"
                  min={1}
                  max={20}
                  value={order}
                  onChange={(e) => setOrder(Math.max(1, Number(e.target.value) || 1))}
                />
              </label>
            )}
            <button className="compute-run" onClick={run} disabled={busy}>
              {busy ? '计算中…' : '计算'}
            </button>
          </div>
        </div>

        <div className="compute-card">
          {error && <p className="compute-error">{error}</p>}
          {!error && !result && <p className="compute-empty">结果会显示在这里（KaTeX 渲染）。</p>}
          {result && (
            <>
              <div className="result-label">结果</div>
              <div className="compute-result">
                <RichText text={`$$${result.latex}$$`} />
              </div>
              <div className="result-meta">
                <code>{result.plain}</code>
                {result.approx && <code title="数值近似">≈ {result.approx}</code>}
                <button
                  className="mini ghost"
                  onClick={() => navigator.clipboard?.writeText(result.latex)}
                >
                  复制 LaTeX
                </button>
              </div>
            </>
          )}
        </div>
      </main>

      <aside className="compute-symbols">
        <div className="section-title">符号变量</div>
        <p className="symbols-hint">
          {'可自定义符号及其类型，例如把 a 设为正数后，√(a²) 会自动化简为 a，而不是 |a|。'}
        </p>
        <ul className="symbol-list">
          {symbols.map((s) => (
            <li key={s.name}>
              <span className="mono">{s.name}</span>
              <select
                value={s.kind}
                onChange={(e) =>
                  setSymbols((ss) =>
                    ss.map((x) => (x.name === s.name ? { ...x, kind: e.target.value } : x)),
                  )
                }
              >
                {SYMBOL_KINDS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
              <button
                className="link danger"
                onClick={() => setSymbols((ss) => ss.filter((x) => x.name !== s.name))}
              >
                删除
              </button>
            </li>
          ))}
          {symbols.length === 0 && <li className="empty">暂无自定义符号</li>}
        </ul>
        <div className="symbol-add">
          <input
            placeholder="符号名，如 a、alpha"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
          />
          <select value={newKind} onChange={(e) => setNewKind(e.target.value)}>
            {SYMBOL_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.label}
              </option>
            ))}
          </select>
          <button className="mini" onClick={addSymbol} disabled={!newSymbol.trim()}>
            添加符号
          </button>
        </div>
      </aside>
    </div>
  )
}

function symbolLabel(tex: string): string {
  const map: Record<string, string> = {
    '\\pi': 'π',
    e: 'e',
    i: 'i',
    '\\infty': '∞',
    '\\alpha': 'α',
    '\\beta': 'β',
    '\\gamma': 'γ',
    '\\theta': 'θ',
    '\\lambda': 'λ',
    '\\mu': 'μ',
    '\\varphi': 'φ',
    '\\omega': 'ω',
    '\\Omega': 'Ω',
    '\\partial': '∂',
    '\\int': '∫',
    '\\sum': 'Σ',
    '\\lim': 'lim',
    '\\frac{}{}': '⅟',
    '\\sqrt{}': '√',
    '^2': '²',
  }
  return map[tex] ?? tex
}
