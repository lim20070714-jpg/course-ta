import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Citation, ProblemDetail, ProblemListItem, ProblemSource, TagCount, WrongItem } from '../api'
import {
  extractProblems,
  fetchHint,
  getProblem,
  getWrongbook,
  listProblemSources,
  listProblemTags,
  listProblems,
  materialKindLabel,
  pageImageUrl,
  problemImageUrl,
  streamGrade,
  streamSolution,
} from '../api'
import RichText from '../components/RichText'

const VERDICT_TEXT: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '错误',
  unknown: '无法判断',
}

const STATUS_FILTERS: [string, string][] = [
  ['', '全部'],
  ['unseen', '未做'],
  ['wrong', '做错过'],
  ['correct', '做对'],
]

export default function Bank({
  courseId,
  jump,
}: {
  courseId: number | null
  jump?: { problemId: number; seq: number } | null
}) {
  const [sources, setSources] = useState<ProblemSource[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [items, setItems] = useState<ProblemListItem[]>([])
  const [wrongItems, setWrongItems] = useState<WrongItem[]>([])
  const [total, setTotal] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')
  const lastJumpRef = useRef(0)

  const [filterMaterial, setFilterMaterial] = useState<number | null>(null)
  const [filterKnowledge, setFilterKnowledge] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [wrongMode, setWrongMode] = useState(false)
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')

  const [current, setCurrent] = useState<ProblemDetail | null>(null)
  const [showImage, setShowImage] = useState(false)
  const [imgFallback, setImgFallback] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [grading, setGrading] = useState(false)
  const [verdict, setVerdict] = useState('')
  const [gradeText, setGradeText] = useState('')
  const [hint, setHint] = useState('')
  const [hintBusy, setHintBusy] = useState(false)
  const [solving, setSolving] = useState(false)
  const [solutionText, setSolutionText] = useState('')
  const [solutionCitations, setSolutionCitations] = useState<Citation[]>([])
  const historyRef = useRef<HTMLDetailsElement>(null)

  const hasRunning = sources.some((s) => s.job_status === 'running')
  const prevRunning = useRef(false)

  const refreshSources = useCallback((id: number) => {
    listProblemSources(id)
      .then(setSources)
      .catch((e: Error) => setNotice(`加载题目来源失败：${e.message}`))
    listProblemTags(id)
      .then(setTags)
      .catch(() => undefined)
  }, [])

  const refreshList = useCallback(
    (id: number) => {
      const task = wrongMode
        ? getWrongbook(id).then((rows) => {
            setWrongItems(rows)
            setTotal(rows.length)
          })
        : listProblems(id, {
            materialId: filterMaterial,
            knowledge: filterKnowledge,
            status: filterStatus,
            q,
          }).then((resp) => {
            setItems(resp.items)
            setTotal(resp.total)
          })
      task
        .catch((e: Error) => setNotice(`加载题目失败：${e.message}`))
        .finally(() => setLoaded(true))
    },
    [wrongMode, filterMaterial, filterKnowledge, filterStatus, q],
  )

  useEffect(() => {
    if (courseId !== null) refreshSources(courseId)
  }, [courseId, refreshSources])

  useEffect(() => {
    if (courseId !== null) refreshList(courseId)
  }, [courseId, refreshList])

  useEffect(() => {
    if (courseId === null || !hasRunning) return
    const timer = setInterval(() => refreshSources(courseId), 4000)
    return () => clearInterval(timer)
  }, [courseId, hasRunning, refreshSources])

  useEffect(() => {
    if (prevRunning.current && !hasRunning && courseId !== null) {
      refreshList(courseId)
      setNotice('')
    }
    prevRunning.current = hasRunning
  }, [hasRunning, courseId, refreshList])

  useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 400)
    return () => clearTimeout(timer)
  }, [query])

  const tagList = useMemo(() => tags.slice(0, 30), [tags])

  const openProblem = useCallback((id: number) => {
    setNotice('')
    getProblem(id)
      .then((d) => {
        setCurrent(d)
        setShowImage(false)
        setImgFallback(false)
        setAnswerText('')
        setVerdict('')
        setGradeText('')
        setHint('')
        setSolutionText('')
        setSolutionCitations([])
      })
      .catch((e: Error) => setNotice(e.message))
  }, [])

  useEffect(() => {
    if (!jump || jump.seq === lastJumpRef.current) return
    const problemId = jump.problemId
    const seq = jump.seq
    const timer = setTimeout(() => {
      lastJumpRef.current = seq
      openProblem(problemId)
    }, 0)
    return () => clearTimeout(timer)
  }, [jump, openProblem])

  function backToList() {
    setCurrent(null)
    if (courseId !== null) {
      refreshList(courseId)
      refreshSources(courseId)
    }
  }

  async function extract(source: ProblemSource) {
    setNotice(`正在从「${source.filename}」提取题目，大材料可能需要一两分钟…`)
    try {
      await extractProblems(source.material_id)
      if (courseId !== null) refreshSources(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function grade() {
    if (!current || grading) return
    const text = answerText.trim()
    if (!text) {
      setNotice('先写下你的作答，再提交批改')
      return
    }
    setGrading(true)
    setVerdict('')
    setGradeText('')
    setNotice('')
    try {
      await streamGrade({
        problemId: current.id,
        answer: text,
        onVerdict: setVerdict,
        onDelta: (t) => setGradeText((s) => s + t),
      })
      const refreshed = await getProblem(current.id)
      setCurrent(refreshed)
      setTimeout(() => historyRef.current?.scrollIntoView({ behavior: 'smooth' }), 150)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setGrading(false)
    }
  }

  async function askHint() {
    if (!current || hintBusy) return
    setHintBusy(true)
    setNotice('')
    try {
      const resp = await fetchHint(current.id)
      setHint(resp.hint)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setHintBusy(false)
    }
  }

  async function solve() {
    if (!current || solving) return
    setSolving(true)
    setSolutionText('')
    setSolutionCitations([])
    setNotice('')
    try {
      await streamSolution({
        problemId: current.id,
        onCitations: setSolutionCitations,
        onDelta: (t) => setSolutionText((s) => s + t),
      })
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setSolving(false)
    }
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程，再上传真题提取题目。</div>
  }

  const list: (ProblemListItem | WrongItem)[] = wrongMode ? wrongItems : items

  return (
    <div className="lib-page">
      <aside className="sidebar">
        <div className="section-title">
          题目来源
          <button className="link" onClick={() => refreshSources(courseId)}>
            刷新
          </button>
        </div>
        <ul className="material-list bank-sources">
          {sources.map((s) => (
            <li key={s.material_id}>
              <div className={filterMaterial === s.material_id ? 'prob-source active' : 'prob-source'}>
                <button
                  className="prob-source-name"
                  title={s.job_error || s.filename}
                  onClick={() => {
                    setWrongMode(false)
                    setCurrent(null)
                    setFilterMaterial(filterMaterial === s.material_id ? null : s.material_id)
                  }}
                >
                  {s.filename}
                </button>
                <span className={`kind-badge ${s.kind}`}>{materialKindLabel(s.kind)}</span>
                <span className="prob-source-count">{s.problem_count}</span>
                {s.status === 'ready' &&
                  (s.job_status === 'running' ? (
                    <span className="prob-source-job">提取中…</span>
                  ) : (
                    <button className="mini ghost" onClick={() => extract(s)}>
                      {s.problem_count > 0 ? '重抽' : '提取'}
                    </button>
                  ))}
              </div>
            </li>
          ))}
          {sources.length === 0 && <li className="empty">还没有材料，先到「课程资料」上传真题</li>}
        </ul>

        <div className="section-title">知识点</div>
        <div className="bank-chips">
          {tagList.map((t) => (
            <button
              key={t.tag}
              className={filterKnowledge === t.tag ? 'bank-tag active' : 'bank-tag'}
              onClick={() => {
                setWrongMode(false)
                setCurrent(null)
                setFilterKnowledge(filterKnowledge === t.tag ? '' : t.tag)
              }}
            >
              {t.tag} {t.count}
            </button>
          ))}
          {tagList.length === 0 && <p className="empty">提取题目后自动生成</p>}
        </div>

        <div className="section-title">练习状态</div>
        <div className="bank-chips">
          {STATUS_FILTERS.map(([value, label]) => (
            <button
              key={value}
              className={!wrongMode && filterStatus === value ? 'bank-tag active' : 'bank-tag'}
              onClick={() => {
                setWrongMode(false)
                setCurrent(null)
                setFilterStatus(value)
              }}
            >
              {label}
            </button>
          ))}
          <button
            className={wrongMode ? 'bank-tag active warn' : 'bank-tag warn'}
            onClick={() => {
              setWrongMode((v) => !v)
              setCurrent(null)
            }}
          >
            错题本
          </button>
        </div>

        <input
          className="lib-filter"
          placeholder="搜索题干关键词…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </aside>

      <main className="lib-main">
        {notice && <div className="lib-notice">{notice}</div>}
        <div className="lib-content">
          {current ? (
            <div className="prob-detail">
              <div className="reader-head">
                <h2 className="reader-title">
                  {current.number || '题目'} · 第 {current.page} 页
                  <span className="prob-src-slim">{current.material}</span>
                </h2>
                <div className="reader-nav">
                  <button className="mini ghost" onClick={() => setShowImage((v) => !v)}>
                    {showImage ? '收起原题图' : '查看原题图'}
                  </button>
                  <button className="mini ghost" onClick={backToList}>
                    返回题库
                  </button>
                </div>
              </div>

              <div className="prob-tags">
                {current.knowledge.map((tag) => (
                  <span key={tag} className="tag">
                    {tag}
                  </span>
                ))}
              </div>

              <div className="md-body bubble prob-stem">
                <RichText text={current.stem} />
              </div>

              {showImage && current.material_id != null && (
                <img
                  className="prob-image"
                  src={
                    imgFallback
                      ? pageImageUrl(current.material_id, current.page)
                      : problemImageUrl(current.id)
                  }
                  onError={() => setImgFallback(true)}
                  title="已自动裁剪出该题在原试卷上的区域（含配图）；裁剪失败时显示整页"
                  alt="原题图"
                />
              )}

              <section className="prob-section">
                <h4>我的作答</h4>
                <textarea
                  className="prob-answer-input"
                  rows={6}
                  placeholder="写下思路与关键步骤（不用写完整答案也可以），提交后助教会分步批改"
                  value={answerText}
                  onChange={(e) => setAnswerText(e.target.value)}
                />
                <div className="prob-actions">
                  <button onClick={grade} disabled={grading}>
                    {grading ? '批改中…' : '提交批改'}
                  </button>
                  <button className="ghost-btn" onClick={askHint} disabled={hintBusy}>
                    {hintBusy ? '思考中…' : hint ? '换一条提示' : '先给个提示'}
                  </button>
                  {verdict && (
                    <span className={`verdict-badge ${verdict}`}>
                      {VERDICT_TEXT[verdict] ?? verdict}
                    </span>
                  )}
                </div>
                {hint && (
                  <div className="prob-hint-box">
                    <span className="hint-label">思路提示</span>
                    <RichText text={hint} />
                  </div>
                )}
                {(grading || gradeText) && (
                  <div className="md-body bubble grade-feedback">
                    {gradeText ? (
                      <RichText text={stripVerdictLine(gradeText)} />
                    ) : (
                      <p className="prob-hint">助教正在对照你的步骤逐条批改…</p>
                    )}
                  </div>
                )}
              </section>

              <section className="prob-section">
                <h4>参考答案与详解</h4>
                {current.answer ? (
                  <div className="md-body bubble">
                    <RichText text={current.answer} />
                  </div>
                ) : (
                  <p className="prob-hint">
                    材料中未附带该题解答。点击「AI 详解」，助教会结合课程材料完整推导。
                  </p>
                )}
                <div className="prob-actions">
                  <button className="ghost-btn" onClick={solve} disabled={solving}>
                    {solving ? '生成中…' : 'AI 详解'}
                  </button>
                  {solutionCitations.length > 0 && (
                    <div className="citations">
                      {solutionCitations.slice(0, 4).map((c, i) => (
                        <span key={i} className="citation-static" title={c.snippet}>
                          {c.material} 第{c.page}页
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                {(solving || solutionText) && (
                  <div className="md-body bubble">
                    {solutionText ? (
                      <RichText text={solutionText} />
                    ) : (
                      <p className="prob-hint">正在结合课程材料推导详细解答…</p>
                    )}
                  </div>
                )}
              </section>

              {current.attempts.length > 0 && (
                <details className="prob-history" ref={historyRef}>
                  <summary>历史作答（{current.attempts.length} 次）</summary>
                  {current.attempts.map((a) => (
                    <div key={a.id} className="prob-attempt">
                      <div className="prob-attempt-head">
                        <span className={`verdict-badge ${a.verdict}`}>
                          {VERDICT_TEXT[a.verdict] ?? a.verdict}
                        </span>
                        <span className="prob-src-slim">
                          {new Date(a.created_at).toLocaleString()}
                        </span>
                      </div>
                      <p className="prob-attempt-answer">{a.answer_text}</p>
                      <details>
                        <summary>批改详情</summary>
                        <div className="md-body bubble">
                          <RichText text={stripVerdictLine(a.feedback)} />
                        </div>
                      </details>
                    </div>
                  ))}
                </details>
              )}
            </div>
          ) : (
            <>
              <div className="results-head">
                <h3>
                  {wrongMode ? '错题本' : '题目列表'}（{total} 题
                  {filterKnowledge && ` · ${filterKnowledge}`}
                  {filterStatus && ` · ${STATUS_FILTERS.find(([v]) => v === filterStatus)?.[1]}`}）
                </h3>
                {(filterKnowledge || filterStatus || filterMaterial != null || q) && (
                  <button
                    className="link"
                    onClick={() => {
                      setFilterKnowledge('')
                      setFilterStatus('')
                      setFilterMaterial(null)
                      setQuery('')
                      setQ('')
                    }}
                  >
                    清除筛选
                  </button>
                )}
              </div>
              {!loaded && <p className="empty">加载中…</p>}
              {loaded && list.length === 0 && (
                <div className="lib-welcome">
                  {wrongMode ? (
                    <>
                      <h2>错题本是空的</h2>
                      <p>做过的题若判定为「错误」或「部分正确」，会自动收进这里。</p>
                    </>
                  ) : (
                    <>
                      <h2>还没有题目</h2>
                      <p>
                        在左侧「题目来源」里，找到真题/试卷材料，点「提取」，AI
                        会把试卷自动整理成结构化题目（题干、解答、知识点标签）。
                      </p>
                      <p className="lib-welcome-sub">
                        也可以选择已提取的材料、知识点或练习状态来筛选题目。
                      </p>
                    </>
                  )}
                </div>
              )}
              <div className="prob-list">
                {list.map((item) => (
                  <button key={item.id} className="prob-card" onClick={() => openProblem(item.id)}>
                    <div className="prob-card-top">
                      <span className="prob-src-slim">
                        {item.material} · 第 {item.page} 页 {item.number && `· ${item.number}`}
                      </span>
                      {item.last_verdict && (
                        <span className={`verdict-badge small ${item.last_verdict}`}>
                          {VERDICT_TEXT[item.last_verdict] ?? item.last_verdict}
                        </span>
                      )}
                    </div>
                    <div className="prob-excerpt">{item.excerpt}</div>
                    {'last_feedback' in item && item.last_feedback && (
                      <div className="prob-excerpt feedback">上次批改：{item.last_feedback}</div>
                    )}
                    <div className="prob-tags">
                      {item.knowledge.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                      {item.attempt_count > 0 && (
                        <span className="prob-attempt-count">已做 {item.attempt_count} 次</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      </main>
    </div>
  )
}

function stripVerdictLine(text: string): string {
  return text.replace(/^\s*【判定】[^\n]*\n*/, '')
}
