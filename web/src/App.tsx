import { useEffect, useState } from 'react'
import type { Course } from './api'
import { createCourse, listCourses } from './api'
import LabPage from './components/LabPage'
import Bank from './sections/Bank'
import Library from './sections/Library'

type Tab = 'library' | 'bank' | 'graph' | 'lab'

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: '课程资料' },
  { id: 'bank', label: '题库与解答' },
  { id: 'graph', label: '知识图谱' },
  { id: 'lab', label: '电路实验台' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('library')
  const [courses, setCourses] = useState<Course[]>([])
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    listCourses()
      .then((cs) => {
        setCourses(cs)
        if (cs.length > 0) setActiveCourseId((id) => id ?? cs[0].id)
      })
      .catch((e: Error) => setNotice(`加载课程失败：${e.message}`))
  }, [])

  async function handleCreate() {
    const name = newName.trim()
    if (!name) return
    try {
      const course = await createCourse(name)
      setCourses((cs) => [...cs, course])
      setActiveCourseId(course.id)
      setNewName('')
      setCreating(false)
      setNotice('')
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  return (
    <div className="app-shell">
      <nav className="topbar">
        <span className="brand-mini">CourseTA</span>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={tab === t.id ? 'tab active' : 'tab'}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        <div className="topbar-right">
          {creating ? (
            <>
              <input
                className="course-new"
                placeholder="新课程名称，如：电子电路与系统基础"
                value={newName}
                autoFocus
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
              />
              <button className="mini" onClick={handleCreate} disabled={!newName.trim()}>
                创建
              </button>
              <button
                className="mini ghost"
                onClick={() => {
                  setCreating(false)
                  setNewName('')
                }}
              >
                取消
              </button>
            </>
          ) : (
            <>
              <select
                className="course-select"
                value={activeCourseId ?? ''}
                onChange={(e) => setActiveCourseId(Number(e.target.value))}
              >
                {courses.length === 0 && <option value="">（暂无课程）</option>}
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="mini ghost" onClick={() => setCreating(true)}>
                ＋ 新建课程
              </button>
            </>
          )}
        </div>
      </nav>

      {notice && <div className="notice">{notice}</div>}

      {tab === 'library' && <Library key={activeCourseId ?? 'none'} courseId={activeCourseId} />}
      {tab === 'bank' && <Bank key={activeCourseId ?? 'none'} courseId={activeCourseId} />}
      {tab === 'lab' && <LabPage />}
      {tab === 'graph' && <Placeholder onGo={() => setTab('library')} />}
    </div>
  )
}

function Placeholder({ onGo }: { onGo: () => void }) {
  const info = {
    title: '知识图谱',
    desc: '从课件与教材中抽取概念及其前置关系，形成可交互的课程知识图谱，串联资料、题目与实验。',
    plan: [
      'LLM 抽取概念、定义与前置关系',
      '交互式图谱：缩放、拖拽、按章节着色',
      '概念页：定义、出处页码、相关题目与实验',
    ],
    note: '规划于 v0.5 实现',
  }
  return (
    <div className="placeholder-page">
      <div className="placeholder-card">
        <h2>{info.title}</h2>
        <p className="placeholder-desc">{info.desc}</p>
        <ul className="placeholder-plan">
          {info.plan.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="placeholder-note">{info.note}，当前可先使用课程资料与题库分区。</p>
        <button onClick={onGo}>去浏览课程资料</button>
      </div>
    </div>
  )
}
