import { useEffect, useRef, useState } from 'react'
import type { Course } from './api'
import { createCourse, listCourses } from './api'
import LabPage from './components/LabPage'
import Bank from './sections/Bank'
import Compute from './sections/Compute'
import Graph from './sections/Graph'
import Library from './sections/Library'

type Tab = 'library' | 'bank' | 'compute' | 'graph' | 'lab'

interface LibraryJump {
  materialId: number
  page: number
  filename: string
  seq: number
}

interface BankJump {
  problemId: number
  seq: number
}

const TABS: { id: Tab; label: string }[] = [
  { id: 'library', label: '课程资料' },
  { id: 'bank', label: '题库与解答' },
  { id: 'compute', label: '计算台' },
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
  const [libraryJump, setLibraryJump] = useState<LibraryJump | null>(null)
  const [bankJump, setBankJump] = useState<BankJump | null>(null)
  const jumpSeq = useRef(0)

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
            onClick={() => {
              setTab(t.id)
              setLibraryJump(null)
              setBankJump(null)
            }}
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

      {tab === 'library' && (
        <Library key={activeCourseId ?? 'none'} courseId={activeCourseId} jump={libraryJump} />
      )}
      {tab === 'bank' && (
        <Bank key={activeCourseId ?? 'none'} courseId={activeCourseId} jump={bankJump} />
      )}
      {tab === 'compute' && <Compute />}
      {tab === 'lab' && <LabPage />}
      {tab === 'graph' && (
        <Graph
          key={activeCourseId ?? 'none'}
          courseId={activeCourseId}
          onJumpMaterial={(materialId, page, filename) => {
            setLibraryJump({ materialId, page, filename, seq: ++jumpSeq.current })
            setTab('library')
          }}
          onOpenProblem={(problemId) => {
            setBankJump({ problemId, seq: ++jumpSeq.current })
            setTab('bank')
          }}
        />
      )}
    </div>
  )
}
