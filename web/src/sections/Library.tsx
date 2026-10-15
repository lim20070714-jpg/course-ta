import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatTurn,
  Citation,
  Material,
  MaterialPages,
  MaterialSummary,
  ProblemListItem,
  SearchHit,
  SearchResponse,
} from '../api'
import {
  KIND_LABELS,
  extractProblems,
  getMaterialSummary,
  listMaterials,
  listProblemSources,
  listProblems,
  materialKindLabel,
  materialPages,
  pageImageUrl,
  regenerateSummary,
  searchCourse,
  streamChat,
  updateMaterialKind,
  uploadMaterial,
} from '../api'
import RichText from '../components/RichText'

const PAGE_WINDOW = 20

type ReaderView = 'summary' | 'text' | 'image' | 'problems'

const VERDICT_TEXT: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '错误',
  unknown: '无法判断',
}

interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
}

export default function Library({
  courseId,
  jump,
  onOpenProblem,
}: {
  courseId: number | null
  jump?: { materialId: number; page: number; filename: string; seq: number } | null
  onOpenProblem?: (problemId: number) => void
}) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')
  const [uploadKind, setUploadKind] = useState('auto')
  const fileRef = useRef<HTMLInputElement>(null)
  const lastJumpRef = useRef(0)

  const [current, setCurrent] = useState<Material | null>(null)
  const [doc, setDoc] = useState<MaterialPages | null>(null)
  const [page, setPage] = useState(1)
  const [jumpText, setJumpText] = useState('1')
  const [reading, setReading] = useState(false)
  const [view, setView] = useState<ReaderView>('summary')
  const [summary, setSummary] = useState<MaterialSummary | null>(null)

  const [examProblems, setExamProblems] = useState<ProblemListItem[] | null>(null)
  const [examJob, setExamJob] = useState('idle')
  const [examBusy, setExamBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchResponse | null>(null)
  const [searching, setSearching] = useState(false)

  const [askOpen, setAskOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const askBottomRef = useRef<HTMLDivElement>(null)

  const hasActive = materials.some((m) => m.status === 'pending' || m.status === 'ingesting')

  function refresh(id: number) {
    listMaterials(id)
      .then(setMaterials)
      .catch((e: Error) => setNotice(`加载材料失败：${e.message}`))
  }

  useEffect(() => {
    if (courseId !== null) refresh(courseId)
  }, [courseId])

  useEffect(() => {
    if (courseId === null || !hasActive) return
    const timer = setInterval(() => refresh(courseId), 4000)
    return () => clearInterval(timer)
  }, [courseId, hasActive])

  useEffect(() => {
    askBottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    if (!current || current.kind === 'exam') return  // 试题不做总结，改看切割出的题目
    let stop = false
    getMaterialSummary(current.id)
      .then((s) => {
        if (!stop) setSummary(s)
      })
      .catch(() => {
        if (!stop) setSummary(null)
      })
    return () => {
      stop = true
    }
  }, [current])

  useEffect(() => {
    if (!current || summary?.status !== 'generating') return
    const timer = setInterval(() => {
      getMaterialSummary(current.id)
        .then(setSummary)
        .catch(() => undefined)
    }, 4000)
    return () => clearInterval(timer)
  }, [current, summary?.status])

  const refreshExam = useCallback((materialId: number, cid: number) => {
    listProblems(cid, { materialId, limit: 200 })
      .then((resp) => setExamProblems(resp.items))
      .catch(() => undefined)
    listProblemSources(cid)
      .then((rows) => {
        const row = rows.find((s) => s.material_id === materialId)
        setExamJob(row ? row.job_status : 'idle')
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!current || view !== 'problems' || courseId === null) return
    const timer = setTimeout(() => refreshExam(current.id, courseId), 0)
    return () => clearTimeout(timer)
  }, [current, view, courseId, refreshExam])

  useEffect(() => {
    if (!current || view !== 'problems' || examJob !== 'running' || courseId === null) return
    const timer = setInterval(() => refreshExam(current.id, courseId), 4000)
    return () => clearInterval(timer)
  }, [current, view, examJob, courseId, refreshExam])

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return materials
    return materials.filter((m) => m.filename.toLowerCase().includes(q))
  }, [materials, filter])

  const pageText = useMemo(
    () => (doc ? (doc.pages.find((p) => p.page === page)?.text ?? '') : ''),
    [doc, page],
  )

  const loadWindow = useCallback((materialId: number, target: number) => {
    setReading(true)
    materialPages(materialId, Math.max(0, target - Math.floor(PAGE_WINDOW / 2)), PAGE_WINDOW)
      .then((d) => {
        const clamped = Math.min(Math.max(1, target), Math.max(1, d.page_count))
        setDoc(d)
        setPage(clamped)
        setJumpText(String(clamped))
      })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => setReading(false))
  }, [])

  function openMaterial(m: Material, target = 1) {
    setCurrent(m)
    setSummary(null)
    setExamProblems(null)
    setExamJob('idle')
    setView(m.kind === 'exam' ? 'problems' : 'summary')
    setNotice('')
    if (
      doc?.material_id === m.id &&
      target >= doc.offset + 1 &&
      target <= doc.offset + doc.pages.length
    ) {
      setPage(target)
      setJumpText(String(target))
      return
    }
    loadWindow(m.id, target)
  }

  const openAtPage = useCallback(
    (m: Material, target: number) => {
      if (!m) return
      setCurrent(m)
      setSummary(null)
      setNotice('')
      setView(m.filename.toLowerCase().endsWith('.pdf') ? 'image' : 'text')
      if (
        doc?.material_id === m.id &&
        target >= doc.offset + 1 &&
        target <= doc.offset + doc.pages.length
      ) {
        setPage(target)
        setJumpText(String(target))
        return
      }
      loadWindow(m.id, target)
    },
    [doc, loadWindow],
  )

  useEffect(() => {
    if (!jump || jump.seq === lastJumpRef.current) return
    const target = jump
    const timer = setTimeout(() => {
      lastJumpRef.current = target.seq
      openAtPage(
        {
          id: target.materialId,
          filename: target.filename,
          status: 'ready',
          error: '',
          chunk_count: 0,
          kind: 'other',
        },
        target.page,
      )
    }, 0)
    return () => clearTimeout(timer)
  }, [jump, openAtPage])

  async function regenerate() {
    if (!current) return
    try {
      await regenerateSummary(current.id)
      setSummary((s) =>
        s
          ? { ...s, status: 'generating', error: '' }
          : {
              material_id: current.id,
              status: 'generating',
              overview: '',
              key_points: [],
              error: '',
            },
      )
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  function gotoPage(target: number) {
    if (!current) return
    if (!doc) {
      loadWindow(current.id, target)
      return
    }
    const clamped = Math.min(Math.max(1, target), Math.max(1, doc.page_count))
    setJumpText(String(clamped))
    if (clamped >= doc.offset + 1 && clamped <= doc.offset + doc.pages.length) {
      setPage(clamped)
    } else {
      loadWindow(current.id, clamped)
    }
  }

  function runSearch() {
    const q = query.trim()
    if (courseId === null) return
    if (!q) {
      setHits(null)
      return
    }
    setSearching(true)
    searchCourse(courseId, q)
      .then((resp) => {
        setHits(resp)
        setCurrent(null)
        setDoc(null)
      })
      .catch((e: Error) => setNotice(e.message))
      .finally(() => setSearching(false))
  }

  function openHit(hit: SearchHit) {
    const m = materials.find((x) => x.id === hit.material_id)
    openAtPage(
      m ?? { id: hit.material_id, filename: hit.material, status: 'ready', error: '', chunk_count: 0, kind: 'other' },
      hit.page,
    )
  }

  function jumpToPage(p: number) {
    if (!current) return
    setView(current.filename.toLowerCase().endsWith('.pdf') ? 'image' : 'text')
    gotoPage(p)
  }

  function jumpCitation(c: Citation) {
    const m = materials.find((x) => x.id === c.material_id)
    openAtPage(
      m ?? { id: c.material_id, filename: c.material, status: 'ready', error: '', chunk_count: 0, kind: 'other' },
      c.page,
    )
  }

  async function handleUpload(file: File) {
    if (courseId === null) return
    setNotice(
      uploadKind === 'exam' || (uploadKind === 'auto' && /真题|试卷|试题|final|middle/i.test(file.name))
        ? `正在上传 ${file.name}，试题将在解析后自动切割题目…`
        : `正在上传 ${file.name}，上传后自动解析入库…`,
    )
    try {
      await uploadMaterial(courseId, file, uploadKind)
      setNotice('')
      refresh(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function changeKind(kind: string) {
    if (!current || kind === current.kind) return
    try {
      const updated = await updateMaterialKind(current.id, kind)
      setCurrent(updated)
      setMaterials((ms) => ms.map((m) => (m.id === updated.id ? updated : m)))
      setSummary(null)
      setExamProblems(null)
      setExamJob('idle')
      setView(kind === 'exam' ? 'problems' : 'summary')
      setNotice(`材料类型已改为「${materialKindLabel(kind)}」`)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function extractExam() {
    if (!current || courseId === null || examBusy) return
    setExamBusy(true)
    setNotice('正在切割题目，完成后自动刷新…')
    try {
      await extractProblems(current.id)
      setExamJob('running')
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setExamBusy(false)
    }
  }

  async function ask() {
    const question = input.trim()
    if (!question || busy || courseId === null) return
    const history: ChatTurn[] = messages.map((m) => ({ role: m.role, content: m.content }))
    setInput('')
    setMessages((ms) => [
      ...ms,
      { role: 'user', content: question },
      { role: 'assistant', content: '' },
    ])
    setBusy(true)
    setNotice('')
    const patchLast = (patch: (m: Message) => Message) =>
      setMessages((ms) => {
        const next = [...ms]
        next[next.length - 1] = patch(next[next.length - 1])
        return next
      })
    try {
      await streamChat({
        courseId,
        question,
        history,
        onCitations: (citations) => patchLast((m) => ({ ...m, citations })),
        onDelta: (text) => patchLast((m) => ({ ...m, content: m.content + text })),
      })
    } catch (e) {
      const message = (e as Error).message
      setNotice(message)
      patchLast((m) => (m.content ? m : { ...m, content: `（出错了：${message}）` }))
    } finally {
      setBusy(false)
    }
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程，再上传课件。</div>
  }

  return (
    <div className="lib-page">
      <aside className="sidebar">
        <div className="section-title">
          课程资料（{materials.length}）
          <button className="link" onClick={() => refresh(courseId)}>
            刷新
          </button>
        </div>
        <input
          className="lib-filter"
          placeholder="筛选材料名…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <ul className="material-list">
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                className={current?.id === m.id ? 'material-item active' : 'material-item'}
                title={m.error || m.filename}
                disabled={m.status !== 'ready'}
                onClick={() => openMaterial(m)}
              >
                <span className={`dot ${m.status}`} />
                <span className="material-name">{m.filename}</span>
                <span className={`kind-badge ${m.kind}`}>{materialKindLabel(m.kind)}</span>
                <span className="material-status">
                  {m.status === 'ready' ? `${m.chunk_count} 块` : statusText(m.status)}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="empty">
              {materials.length === 0 ? '还没有材料，先上传课件' : '没有匹配的材料'}
            </li>
          )}
        </ul>
        <div className="upload-row">
          <select
            className="kind-select"
            value={uploadKind}
            title="材料类型：试题不做总结、自动切割题目；教材/课件/讲义生成知识总结"
            onChange={(e) => setUploadKind(e.target.value)}
          >
            <option value="auto">自动识别</option>
            {Object.entries(KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <button className="upload" onClick={() => fileRef.current?.click()}>
            上传材料（PDF / PPTX）
          </button>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.pptx,.txt,.md"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handleUpload(file)
            e.target.value = ''
          }}
        />
      </aside>

      <main className="lib-main">
        {notice && <div className="lib-notice">{notice}</div>}
        <div className="lib-searchbar">
          <input
            placeholder="全文搜索课程资料，如：基尔霍夫 或 superposition"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && runSearch()}
          />
          <button onClick={runSearch} disabled={searching || !query.trim()}>
            {searching ? '搜索中…' : '搜索'}
          </button>
          <button className="ghost-btn" onClick={() => setAskOpen((v) => !v)}>
            {askOpen ? '收起助教' : '问助教'}
          </button>
        </div>

        <div className="lib-content">
          {current ? (
            <>
              <div className="reader-head">
                <div className="reader-title-wrap">
                  <h2 className="reader-title">
                    {current.filename}
                    <select
                      className="kind-select slim"
                      value={current.kind}
                      title="材料类型（可修改；影响是否生成总结、是否切割题目）"
                      onChange={(e) => changeKind(e.target.value)}
                    >
                      {Object.entries(KIND_LABELS).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </h2>
                  <div className="reader-views">
                    {(current.kind === 'exam'
                      ? ([
                          ['problems', '题目'],
                          ['text', '原文'],
                        ] as [ReaderView, string][])
                      : ([
                          ['summary', '知识点总结'],
                          ['text', '原文'],
                        ] as [ReaderView, string][])
                    )
                      .concat(
                        current.filename.toLowerCase().endsWith('.pdf')
                          ? ([['image', '原页图']] as [ReaderView, string][])
                          : [],
                      )
                      .map(([value, label]) => (
                        <button
                          key={value}
                          className={view === value ? 'view-tab active' : 'view-tab'}
                          onClick={() => setView(value)}
                        >
                          {label}
                        </button>
                      ))}
                  </div>
                </div>
                <div className="reader-nav">
                  <button
                    className="mini ghost"
                    disabled={page <= 1 || reading}
                    onClick={() => gotoPage(page - 1)}
                  >
                    上一页
                  </button>
                  <input
                    className="reader-page-input"
                    value={jumpText}
                    onChange={(e) => setJumpText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const n = Number.parseInt(jumpText, 10)
                        if (!Number.isNaN(n)) gotoPage(n)
                      }
                    }}
                  />
                  <span className="reader-total">/ {doc?.page_count ?? '…'} 页</span>
                  <button
                    className="mini ghost"
                    disabled={!doc || page >= doc.page_count || reading}
                    onClick={() => gotoPage(page + 1)}
                  >
                    下一页
                  </button>
                  <button
                    className="mini ghost"
                    onClick={() => {
                      setCurrent(null)
                      setDoc(null)
                    }}
                  >
                    {hits ? '返回搜索结果' : '关闭'}
                  </button>
                </div>
              </div>
              <article className="reader-body">
                {view === 'problems' ? (
                  <div className="exam-panel">
                    <div className="exam-panel-head">
                      <span className="exam-panel-count">
                        {examProblems === null ? '加载中…' : `已切割出 ${examProblems.length} 道题`}
                      </span>
                      {examJob === 'running' ? (
                        <span className="prob-source-job">AI 正在切割题目…</span>
                      ) : (
                        <button className="mini ghost" disabled={examBusy} onClick={extractExam}>
                          {examBusy ? '提交中…' : examProblems && examProblems.length > 0 ? '重新切割' : '提取题目'}
                        </button>
                      )}
                    </div>
                    {examProblems !== null && examProblems.length === 0 && examJob !== 'running' && (
                      <p className="reader-empty">
                        这道材料还没有题目。「提取题目」会把试卷自动切割成结构化题目（题干、参考答案、
                        知识点），随后可在每道题上查看原题配图、获取提示、作答批改与 AI 详解。
                      </p>
                    )}
                    <div className="prob-list">
                      {(examProblems ?? []).map((item) => (
                        <button
                          key={item.id}
                          className="prob-card"
                          onClick={() => onOpenProblem?.(item.id)}
                        >
                          <div className="prob-card-top">
                            <span className="prob-src-slim">
                              第 {item.page} 页 {item.number && `· ${item.number}`}
                            </span>
                            {item.last_verdict && (
                              <span className={`verdict-badge small ${item.last_verdict}`}>
                                {VERDICT_TEXT[item.last_verdict] ?? item.last_verdict}
                              </span>
                            )}
                          </div>
                          <div className="prob-excerpt">{item.excerpt}</div>
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
                  </div>
                ) : view === 'summary' ? (
                  <SummaryPanel
                    summary={summary}
                    onGenerate={regenerate}
                    onJump={jumpToPage}
                  />
                ) : view === 'image' ? (
                  <div className="reader-image">
                    <img
                      className="reader-page-image"
                      src={pageImageUrl(current.id, page)}
                      alt={`${current.filename} 第 ${page} 页`}
                    />
                  </div>
                ) : reading && !doc ? (
                  <p className="reader-empty">加载中…</p>
                ) : doc ? (
                  pageText ? (
                    <RichText text={pageText} />
                  ) : (
                    <p className="reader-empty">（本页没有可提取的文本，可能是扫描页或纯图片页）</p>
                  )
                ) : null}
              </article>
            </>
          ) : hits ? (
            <>
              <div className="results-head">
                <h3>
                  “{hits.query}” 共 {hits.hits.length} 处命中
                </h3>
                <button className="link" onClick={() => setHits(null)}>
                  清除
                </button>
              </div>
              {hits.hits.length === 0 && (
                <p className="empty">没有找到包含该关键词的内容，换个关键词试试（中英文均可）。</p>
              )}
              <div className="search-hits">
                {hits.hits.map((h, i) => (
                  <button key={`${h.material_id}-${h.page}-${i}`} className="search-hit" onClick={() => openHit(h)}>
                    <span className="search-hit-src">
                      {h.material} · 第 {h.page} 页
                    </span>
                    <span className="search-hit-snippet">{h.snippet}</span>
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="lib-welcome">
              <h2>课程资料</h2>
              <p>左侧选择一份材料开始逐页阅读；上方可全文搜索，或打开助教提问（回答带引用，点击引用可跳页）。</p>
              <p className="lib-welcome-sub">
                共 {materials.length} 份材料已解析入库，支持中英文混合检索。
              </p>
            </div>
          )}
        </div>
      </main>

      {askOpen && (
        <aside className="lib-ask">
          <div className="lib-ask-head">
            <span>{current ? `问助教 · ${current.filename} 第 ${page} 页` : '问助教'}</span>
            <button className="link" onClick={() => setAskOpen(false)}>
              收起
            </button>
          </div>
          <div className="ask-messages">
            {messages.length === 0 && (
              <p className="ask-welcome">
                基于全部课程材料回答；答案会标注来源，点击引用可直接跳到对应页面。
              </p>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>
                {m.citations && m.citations.length > 0 && (
                  <div className="citations">
                    {m.citations.slice(0, 4).map((c, j) => (
                      <button key={j} className="citation" title={c.snippet} onClick={() => jumpCitation(c)}>
                        {c.material} 第{c.page}页
                      </button>
                    ))}
                  </div>
                )}
                <div className="bubble">
                  {m.content ? (
                    m.role === 'assistant' ? (
                      <RichText text={m.content} />
                    ) : (
                      m.content
                    )
                  ) : busy && i === messages.length - 1 ? (
                    '…'
                  ) : (
                    ''
                  )}
                </div>
              </div>
            ))}
            <div ref={askBottomRef} />
          </div>
          <div className="ask-composer">
            <input
              placeholder={current ? `关于第 ${page} 页提问…` : '输入你的问题'}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && ask()}
            />
            <button onClick={ask} disabled={busy || !input.trim()}>
              {busy ? '…' : '发送'}
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}

function SummaryPanel({
  summary,
  onGenerate,
  onJump,
}: {
  summary: MaterialSummary | null
  onGenerate: () => void
  onJump: (p: number) => void
}) {
  if (summary === null) {
    return <p className="reader-empty">加载总结中…</p>
  }
  if (summary.status === 'generating') {
    return (
      <div className="summary-status">
        <p className="summary-hint">AI 正在总结这份材料，提取知识点并定位页码…（可先切换到原文或原页图浏览）</p>
      </div>
    )
  }
  if (summary.status === 'failed') {
    return (
      <div className="summary-status">
        <p className="summary-error">总结生成失败：{summary.error || '未知错误'}</p>
        <button className="mini" onClick={onGenerate}>
          重新生成
        </button>
      </div>
    )
  }
  if (summary.status === 'pending' || (!summary.overview && summary.key_points.length === 0)) {
    return (
      <div className="summary-status">
        <p className="summary-hint">
          这份材料还没有知识总结。生成后会得到「整体总结 + 知识点清单」，点击知识点的页码可直接跳转到原页。
        </p>
        <button className="mini" onClick={onGenerate}>
          生成知识总结
        </button>
      </div>
    )
  }
  return (
    <div className="summary-view">
      {summary.overview && (
        <section className="summary-overview">
          <div className="summary-section-title">整体总结</div>
          <RichText text={summary.overview} />
        </section>
      )}
      {summary.key_points.length > 0 && (
        <section className="summary-points">
          <div className="summary-section-title">知识点（{summary.key_points.length}）</div>
          <ul className="keypoint-list">
            {summary.key_points.map((kp, i) => (
              <li key={i} className="keypoint">
                <div className="keypoint-head">
                  <span className="keypoint-title">{kp.title}</span>
                  <span className="keypoint-pages">
                    {kp.pages.map((p) => (
                      <button
                        key={p}
                        className="page-badge"
                        title={`跳转到第 ${p} 页`}
                        onClick={() => onJump(p)}
                      >
                        第 {p} 页
                      </button>
                    ))}
                  </span>
                </div>
                <div className="keypoint-detail">
                  <RichText text={kp.detail} />
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
      <div className="summary-foot">
        <button className="mini ghost" onClick={onGenerate}>
          重新生成总结
        </button>
      </div>
    </div>
  )
}

function statusText(status: string): string {
  if (status === 'pending') return '排队中'
  if (status === 'ingesting') return '解析中'
  if (status === 'failed') return '失败'
  return status
}
