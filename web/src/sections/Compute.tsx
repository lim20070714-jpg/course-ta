import { useEffect, useMemo, useRef, useState } from 'react'
import type { ComputeResult, ComputeRun, Formula } from '../api'
import {
  clearComputeHistory,
  createFormula,
  deleteFormula,
  evaluateCompute,
  getComputeHistory,
  listFormulas,
  updateFormula,
} from '../api'
import RichText from '../components/RichText'
import LiveMath, { InlineMath } from '../components/LiveMath'
import { clampOrder, liveFields, liveMath, liveNotes, type SlotField } from '../compute/liveMath'
import {
  argSummary,
  dedupeRuns,
  groupRuns,
  HISTORY_LIMIT,
  opLabel,
  runOutcome,
} from '../compute/history'
import {
  CATEGORIES,
  MATRIX_TEMPLATES,
  OP_GROUPS,
  QUICK_SYMBOLS,
  SYMBOL_KINDS,
  TEX_HINTS,
  asInputTex,
  opNeeds,
  toPreviewTex,
  type SymbolDef,
} from '../compute/ops'
import { localTimeLabel } from '../components/traceGroups'

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
  const [resultSeq, setResultSeq] = useState(0)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState('')
  const [history, setHistory] = useState<ComputeRun[]>([])
  const [moreSymbols, setMoreSymbols] = useState(false)
  const [historyTotal, setHistoryTotal] = useState(0)
  const [usedRun, setUsedRun] = useState<ComputeRun | null>(null)
  const exprRef = useRef<HTMLTextAreaElement>(null)
  const mainRef = useRef<HTMLElement>(null)

  const needs = opNeeds(op)
  const liveNodes = useMemo(() => liveMath(op), [op])
  const hasSlots = useMemo(() => liveFields(liveNodes).length > 0, [liveNodes])
  const slotValues: Record<SlotField, string> = useMemo(
    () => ({ variable, point, lower, upper, order: String(order) }),
    [variable, point, lower, upper, order],
  )

  /** 预览里的参数框直接写回同一份状态：改哪儿都只有一条路径。 */
  function setSlot(field: SlotField, raw: string) {
    if (field === 'order') setOrder(clampOrder(raw))
    else if (field === 'variable') setVariable(raw)
    else if (field === 'point') setPoint(raw)
    else if (field === 'lower') setLower(raw)
    else setUpper(raw)
  }

  useEffect(() => {
    listFormulas()
      .then(setFormulas)
      .catch((e: Error) => setNotice(`加载公式库失败：${e.message}`))
  }, [])

  function loadHistory() {
    getComputeHistory(HISTORY_LIMIT)
      .then((h) => {
        setHistory(h.items)
        setHistoryTotal(h.total)
      })
      .catch(() => setHistory([]))
  }

  useEffect(() => {
    loadHistory()
  }, [])

  const categories = useMemo(() => {
    const used = new Set(formulas.map((f) => f.category))
    return ['全部', ...CATEGORIES.filter((c) => used.has(c) || c === '自定义')]
  }, [formulas])

  const counts = useMemo(() => {
    const map = new Map<string, number>([['全部', formulas.length]])
    for (const f of formulas) map.set(f.category, (map.get(f.category) ?? 0) + 1)
    return map
  }, [formulas])

  const shown = useMemo(
    () => (category === '全部' ? formulas : formulas.filter((f) => f.category === category)),
    [formulas, category],
  )

  const historyDays = useMemo(() => groupRuns(dedupeRuns(history)), [history])

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

  async function copy(text: string, tag: string) {
    if (!navigator.clipboard) {
      setNotice('当前环境不支持剪贴板，请手动选择文本复制')
      return
    }
    try {
      await navigator.clipboard.writeText(text)
      setCopied(tag)
      window.setTimeout(() => setCopied(''), 1400)
    } catch {
      setNotice('复制失败：浏览器拒绝了剪贴板访问，请手动选择文本')
    }
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
    setUsedRun(null)
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
      const next = await evaluateCompute(payload)
      setResult(next)
      setResultSeq((n) => n + 1)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
      loadHistory()
    }
  }

  /** 点历史 = 把这次运算原样搬回输入区，并直接显示当时记下（或报错）的结果。 */
  function restore(r: ComputeRun) {
    setExpr(r.expr)
    setOp(r.op)
    setVariable(r.args.var ?? 'x')
    setPoint(r.args.point ?? '0')
    setLower(r.args.lower ?? '')
    setUpper(r.args.upper ?? '')
    setOrder(r.args.order ?? 1)
    setSymbols(r.args.symbols ?? [])
    setCopied('')
    if (r.error) {
      setResult(null)
      setError(r.error)
    } else {
      setError('')
      setResult({ latex: r.result_latex, plain: r.result_plain, approx: r.approx })
      setResultSeq((n) => n + 1)
    }
    setUsedRun(r)
    mainRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function clearHistory() {
    if (!window.confirm('清空计算历史？只删历史记录，公式库与符号设置不受影响。')) return
    try {
      const r = await clearComputeHistory()
      setHistory([])
      setHistoryTotal(0)
      setUsedRun(null)
      setNotice(`已清空 ${r.removed} 条计算历史。`)
    } catch (e) {
      setNotice((e as Error).message)
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
        <div className="chip-row" role="group" aria-label="按分类筛选公式">
          {categories.map((c) => (
            <button
              key={c}
              className={category === c ? 'chip active' : 'chip'}
              aria-pressed={category === c}
              onClick={() => setCategory(c)}
            >
              {c}
              <span className="cmp-count">{counts.get(c) ?? 0}</span>
            </button>
          ))}
        </div>
        {draft && (
          <div
            className="formula-editor cmp-editor"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setDraft(null)
            }}
          >
            <input
              placeholder="标题，如：分部积分"
              aria-label="公式标题"
              value={draft.title}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
            />
            <textarea
              rows={3}
              placeholder="公式内容（LaTeX），如：\int u\,dv = uv - \int v\,du"
              aria-label="公式内容 LaTeX"
              value={draft.latex}
              onChange={(e) => setDraft({ ...draft, latex: e.target.value })}
            />
            <select
              aria-label="公式分类"
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
              aria-label="公式备注"
              value={draft.note}
              onChange={(e) => setDraft({ ...draft, note: e.target.value })}
            />
            <div className="row">
              <button className="mini" onClick={saveDraft}>
                {draft.id === null ? '添加' : '保存修改'}
              </button>
              <button className="mini ghost" onClick={() => setDraft(null)} title="Esc 也可取消">
                取消
              </button>
            </div>
          </div>
        )}
        <ul className="formula-list">
          {shown.map((f, i) => (
            <li
              key={f.id}
              className="formula-item cmp-item stagger-item"
              style={{ '--i': Math.min(i, 12) } as React.CSSProperties}
            >
              <button
                className="formula-insert"
                title="插入到输入框"
                aria-label={`插入公式 ${f.title}`}
                onClick={() => insert(f.latex)}
              >
                <span className="formula-title">
                  {f.title}
                  {f.preset && <span className="formula-badge">预置</span>}
                  {category === '全部' && <span className="cmp-cat">{f.category}</span>}
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

      <main className="compute-main" ref={mainRef}>
        {notice && (
          <div className="lib-notice" role="alert">
            {notice}
          </div>
        )}
        <div className="compute-card">
          <div className="compute-input-head">
            <span className="compute-hint">
              {needs.matrix
                ? '矩阵输入：[[1,2],[3,4]] 或 \\begin{pmatrix}1&2\\\\3&4\\end{pmatrix}，也可把公式库里的矩阵公式整行粘进来；下面的预览里点哪个元素就能改哪个'
                : '支持 LaTeX 或普通语法（2x、x^3、exp(-2t)）；上下限 / 变量 / 展开点 / 阶数不用另找输入框，在下面那条算式里点着改就行，傅里叶变换按 ω 约定。不会写就展开下面的「LaTeX 写法提示」'}
            </span>
          </div>
          <textarea
            ref={exprRef}
            className="compute-expr"
            rows={3}
            aria-label="表达式输入"
            spellCheck={false}
            placeholder="输入函数或表达式，如：e^{-x^2}、\frac{\sin x}{x}、\int_0^{+\infty} e^{-x^2} dx"
            value={expr}
            onChange={(e) => setExpr(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) run()
            }}
          />
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
            <span className="cmp-run-wrap">
              <button
                className={busy ? 'compute-run cmp-busy' : 'compute-run'}
                onClick={run}
                disabled={busy}
                aria-busy={busy}
                title="Ctrl / ⌘ + Enter 可直接计算"
              >
                {busy && <span className="cmp-spin" aria-hidden="true" />}
                {busy ? '计算中…' : '计算'}
              </button>
              <span className="cmp-kbd-hint">Ctrl/⌘ + ↵</span>
            </span>
          </div>
          {(expr.trim() || hasSlots) && (
            <div className="compute-preview cmp-preview cmp-live">
              <span className="preview-label">
                要算的{needs.matrix ? '矩阵 · 点哪个格子就改哪个元素' : '式子 · 点带下划线的值就能改参数'}
              </span>
              <LiveMath
                nodes={liveNodes}
                values={slotValues}
                exprTex={expr}
                notes={liveNotes(liveNodes, slotValues)}
                onSlot={setSlot}
                onExpr={setExpr}
                onRun={run}
              />
            </div>
          )}
          <div className="chip-row">
            {(moreSymbols ? QUICK_SYMBOLS : QUICK_SYMBOLS.slice(0, 10)).map((s) => (
              <button key={s} className="chip mono" onClick={() => insert(s)} title={`插入 ${s}`}>
                {symbolLabel(s)}
              </button>
            ))}
            {needs.matrix &&
              MATRIX_TEMPLATES.map((t) => (
                <button
                  key={t.label}
                  className="chip mono"
                  onClick={() => insert(t.text)}
                  title={`插入 ${t.label}`}
                >
                  {t.label}
                </button>
              ))}
            {QUICK_SYMBOLS.length > 10 && (
              <button className="chip" aria-expanded={moreSymbols} onClick={() => setMoreSymbols((v) => !v)}>
                {moreSymbols ? '收起符号' : `＋ 符号 ${QUICK_SYMBOLS.length - 10}`}
              </button>
            )}
          </div>
          <details className="cmp-help">
            <summary>LaTeX 写法提示（{TEX_HINTS.length} 条）</summary>
            <dl className="cmp-help-list">
              {TEX_HINTS.map((h) => (
                <div key={h.tex} className="cmp-help-item">
                  <dt>
                    <button className="cmp-help-copy" onClick={() => insert(h.tex)} title={`插入 ${h.tex}`}>
                      <InlineMath tex={h.tex} />
                    </button>
                  </dt>
                  <dd>{h.meaning}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>

        <div className="compute-card cmp-result-card">
          {error && (
            <p className="compute-error cmp-error" role="alert">
              <span aria-hidden="true">⚠</span> {error}
            </p>
          )}
          {!error && !result && (
            <p className="compute-empty">结果会显示在这里（KaTeX 渲染）。输入后按 Ctrl/⌘ + ↵ 计算。</p>
          )}
          {result && (
            <div className="cmp-result-in stagger-item" key={resultSeq}>
              <div className="result-label">
                结果
                {usedRun && (
                  <span className="cmp-from-history">
                    {localTimeLabel(usedRun.created_at)} 那次运算的记录
                  </span>
                )}
              </div>
              <div className="compute-result">
                <RichText text={`$$${result.latex}$$`} />
              </div>
              <div className="result-meta">
                <code className="cmp-plain" title="纯文本形式">
                  {result.plain}
                </code>
                {result.approx && (
                  <code title="数值近似">≈ {result.approx}</code>
                )}
                <span className="cmp-actions">
                  <button
                    className="mini ghost"
                    onClick={() => copy(result.latex, 'latex')}
                    title="复制可直接粘贴到 Markdown / LaTeX 的公式源码"
                  >
                    {copied === 'latex' ? '已复制 ✓' : '复制 LaTeX'}
                  </button>
                  <button
                    className="mini ghost"
                    onClick={() => copy(result.plain, 'plain')}
                    title="复制纯文本结果"
                  >
                    {copied === 'plain' ? '已复制 ✓' : '复制结果'}
                  </button>
                  <button
                    className="mini"
                    onClick={() => setExpr(asInputTex(result))}
                    title="把结果放回输入框继续算（回填的是 LaTeX 源码，预览与后端读的是同一份）"
                  >
                    ↗ 作为输入
                  </button>
                </span>
              </div>
            </div>
          )}
        </div>

        <div className="compute-card cmp-history">
          <div className="cmp-history-head">
            <span className="result-label">计算历史（{history.length}）</span>
            <span className="cmp-history-tools">
              <button className="mini ghost" onClick={loadHistory} title={`重新拉取最近 ${HISTORY_LIMIT} 条`}>
                刷新
              </button>
              {history.length > 0 && (
                <button className="mini danger" onClick={clearHistory}>
                  清空
                </button>
              )}
            </span>
          </div>
          <div className="cmp-history-body">
            {history.length === 0 ? (
              <p className="compute-empty">
                还没有计算记录。这里的运算都会留下来（包括没算出来的），换浏览器也能接着看。
              </p>
            ) : (
              <>
                {historyTotal > history.length && (
                  <p className="cmp-history-more">
                    共 {historyTotal} 条，这里只显示最近 {history.length} 条。
                  </p>
                )}
                {historyDays.map((day) => (
                  <div key={day.key} className="cmp-hist-day">
                    <div className="cmp-hist-day-head">
                      {day.label}
                      <span className="cmp-hist-day-count">{day.items.length} 次</span>
                    </div>
                    <ul className="cmp-hist-list">
                      {day.items.map((r) => {
                        const outcome = runOutcome(r)
                        const args = argSummary(r)
                        return (
                          <li key={r.id}>
                            <button
                              className={usedRun?.id === r.id ? 'cmp-hist-item active' : 'cmp-hist-item'}
                              onClick={() => restore(r)}
                              title="放回输入框，并显示当时记下的结果"
                            >
                              <span className="cmp-hist-time">{localTimeLabel(r.created_at)}</span>
                              <span className="cmp-hist-main">
                                <span className="cmp-hist-expr mono">{r.expr}</span>
                                <span className="cmp-hist-meta">
                                  {opLabel(r.op)}
                                  {args && ` · ${args}`}
                                </span>
                                <span className={outcome.failed ? 'cmp-hist-out fail' : 'cmp-hist-out'}>
                                  {outcome.failed && <span aria-hidden="true">⚠ </span>}
                                  {outcome.text}
                                </span>
                              </span>
                            </button>
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </main>

      <aside className="compute-symbols">
        <div className="section-title">符号变量</div>
        <p className="symbols-hint">
          {'可自定义符号及其类型，例如把 a 设为正数后，√(a²) 会自动化简为 a，而不是 |a|。'}
        </p>
        <ul className="symbol-list">
          {symbols.map((s, i) => (
            <li key={s.name} className="stagger-item" style={{ '--i': i } as React.CSSProperties}>
              <span className="mono">{s.name}</span>
              <select
                aria-label={`${s.name} 的类型`}
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
                aria-label={`删除符号 ${s.name}`}
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
            aria-label="新符号名"
            value={newSymbol}
            onChange={(e) => setNewSymbol(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
          />
          <select aria-label="新符号类型" value={newKind} onChange={(e) => setNewKind(e.target.value)}>
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
