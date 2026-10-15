import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  ChatTurn,
  Citation,
  Material,
  MaterialPages,
  SearchHit,
  SearchResponse,
} from '../api'
import { listMaterials, materialPages, searchCourse, streamChat, uploadMaterial } from '../api'

const PAGE_WINDOW = 20

interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
}

export default function Library({ courseId }: { courseId: number | null }) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [filter, setFilter] = useState('')
  const [notice, setNotice] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [current, setCurrent] = useState<Material | null>(null)
  const [doc, setDoc] = useState<MaterialPages | null>(null)
  const [page, setPage] = useState(1)
  const [jumpText, setJumpText] = useState('1')
  const [reading, setReading] = useState(false)

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

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return materials
    return materials.filter((m) => m.filename.toLowerCase().includes(q))
  }, [materials, filter])

  const pageText = useMemo(
    () => (doc ? (doc.pages.find((p) => p.page === page)?.text ?? '') : ''),
    [doc, page],
  )

  function loadWindow(materialId: number, target: number) {
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
  }

  function openMaterial(m: Material, target = 1) {
    setCurrent(m)
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

  function gotoPage(target: number) {
    if (!current || !doc) return
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
    openMaterial(
      m ?? { id: hit.material_id, filename: hit.material, status: 'ready', error: '', chunk_count: 0 },
      hit.page,
    )
  }

  function jumpCitation(c: Citation) {
    const m = materials.find((x) => x.id === c.material_id)
    openMaterial(
      m ?? { id: c.material_id, filename: c.material, status: 'ready', error: '', chunk_count: 0 },
      c.page,
    )
  }

  async function handleUpload(file: File) {
    if (courseId === null) return
    setNotice(`正在上传 ${file.name}，上传后自动解析入库…`)
    try {
      await uploadMaterial(courseId, file)
      setNotice('')
      refresh(courseId)
    } catch (e) {
      setNotice((e as Error).message)
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
        <button className="upload" onClick={() => fileRef.current?.click()}>
          上传课件（PDF / PPTX）
        </button>
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
                <h2 className="reader-title">{current.filename}</h2>
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
                {reading && !doc && <p className="reader-empty">加载中…</p>}
                {doc &&
                  (pageText ? (
                    <>{pageText}</>
                  ) : (
                    <p className="reader-empty">（本页没有可提取的文本，可能是扫描页或纯图片页）</p>
                  ))}
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
                <div className="bubble">{m.content || (busy && i === messages.length - 1 ? '…' : '')}</div>
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

function statusText(status: string): string {
  if (status === 'pending') return '排队中'
  if (status === 'ingesting') return '解析中'
  if (status === 'failed') return '失败'
  return status
}
