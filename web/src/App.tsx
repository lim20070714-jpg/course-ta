import { useEffect, useRef, useState } from 'react'
import type { ChatTurn, Citation, Course, Material } from './api'
import {
  createCourse,
  listCourses,
  listMaterials,
  streamChat,
  uploadMaterial,
} from './api'
import LabPage from './components/LabPage'

interface Message {
  role: 'user' | 'assistant'
  content: string
  citations?: Citation[]
}

export default function App() {
  const [tab, setTab] = useState<'chat' | 'lab'>('chat')
  const [courses, setCourses] = useState<Course[]>([])
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null)
  const [materials, setMaterials] = useState<Material[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [newCourseName, setNewCourseName] = useState('')
  const [notice, setNotice] = useState('')
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    listCourses()
      .then((cs) => {
        setCourses(cs)
        if (cs.length > 0) setActiveCourseId((id) => id ?? cs[0].id)
      })
      .catch((e: Error) => setNotice(`加载课程失败：${e.message}`))
  }, [])

  useEffect(() => {
    if (activeCourseId !== null) refreshMaterials(activeCourseId)
  }, [activeCourseId])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  function selectCourse(id: number) {
    setActiveCourseId(id)
    setMessages([])
  }

  function refreshMaterials(courseId: number) {
    listMaterials(courseId)
      .then(setMaterials)
      .catch((e: Error) => setNotice(`加载材料失败：${e.message}`))
  }

  async function handleCreateCourse() {
    const name = newCourseName.trim()
    if (!name) return
    try {
      const course = await createCourse(name)
      setCourses((cs) => [...cs, course])
      selectCourse(course.id)
      setNewCourseName('')
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function handleUpload(file: File) {
    if (activeCourseId === null) return
    setNotice(`正在上传 ${file.name}，上传后自动解析入库…`)
    try {
      await uploadMaterial(activeCourseId, file)
      setNotice('')
      setTimeout(() => refreshMaterials(activeCourseId), 1500)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function handleSend() {
    const question = input.trim()
    if (!question || busy || activeCourseId === null) return
    const history: ChatTurn[] = messages
      .filter((m) => m.content)
      .map((m) => ({ role: m.role, content: m.content }))
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
        courseId: activeCourseId,
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

  return (
    <div className="app-shell">
      <nav className="topbar">
        <span className="brand-mini">CourseTA</span>
        <button
          className={tab === 'chat' ? 'tab active' : 'tab'}
          onClick={() => setTab('chat')}
        >
          AI 助教
        </button>
        <button className={tab === 'lab' ? 'tab active' : 'tab'} onClick={() => setTab('lab')}>
          电路实验台
        </button>
      </nav>

      {tab === 'lab' && <LabPage />}

      {tab === 'chat' && (
        <div className="app">
          <aside className="sidebar">
            <p className="brand-sub">课程 AI 助教 · 回答带引用</p>

            <div className="section-title">课程</div>
            <ul className="course-list">
              {courses.map((c) => (
                <li key={c.id}>
                  <button
                    className={c.id === activeCourseId ? 'course active' : 'course'}
                    onClick={() => selectCourse(c.id)}
                  >
                    {c.name}
                  </button>
                </li>
              ))}
            </ul>
            <div className="row">
              <input
                placeholder="新建课程，如：电子电路与系统基础"
                value={newCourseName}
                onChange={(e) => setNewCourseName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateCourse()}
              />
              <button onClick={handleCreateCourse}>新建</button>
            </div>

            <div className="section-title">
              材料
              <button
                className="link"
                onClick={() => activeCourseId !== null && refreshMaterials(activeCourseId)}
              >
                刷新
              </button>
            </div>
            <ul className="material-list">
              {materials.map((m) => (
                <li key={m.id} title={m.error || m.filename}>
                  <span className={`dot ${m.status}`} />
                  <span className="material-name">{m.filename}</span>
                  <span className="material-status">
                    {m.status === 'ready' ? `${m.chunk_count} 块` : statusText(m.status)}
                  </span>
                </li>
              ))}
              {materials.length === 0 && <li className="empty">还没有材料，先上传课件</li>}
            </ul>
            <button
              className="upload"
              disabled={activeCourseId === null}
              onClick={() => fileInputRef.current?.click()}
            >
              上传课件（PDF / PPTX）
            </button>
            <input
              ref={fileInputRef}
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

          <main className="chat">
            {notice && <div className="notice">{notice}</div>}
            <div className="messages">
              {messages.length === 0 && (
                <div className="welcome">
                  <p>选一门课，上传课件，然后直接提问。</p>
                  <p className="welcome-sub">答案会标注 [来源: 文件名 第X页]，请核对后使用。</p>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={i} className={`message ${m.role}`}>
                  {m.citations && m.citations.length > 0 && (
                    <div className="citations">
                      {m.citations.slice(0, 4).map((c, j) => (
                        <span key={j} className="citation" title={c.snippet}>
                          {c.material} 第{c.page}页
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="bubble">
                    {m.content || (busy && i === messages.length - 1 ? '…' : '')}
                  </div>
                </div>
              ))}
              <div ref={bottomRef} />
            </div>
            <div className="composer">
              <input
                placeholder={
                  activeCourseId === null ? '先在左侧选择或新建课程' : '输入你的问题，回车发送'
                }
                value={input}
                disabled={activeCourseId === null}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              />
              <button onClick={handleSend} disabled={busy || !input.trim()}>
                {busy ? '回答中…' : '发送'}
              </button>
            </div>
          </main>
        </div>
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
