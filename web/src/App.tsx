import { useEffect, useMemo, useRef, useState } from 'react'
import type { Course } from './api'
import { createCourse, listCourses } from './api'
import CommandPalette from './components/CommandPalette'
import type { Command } from './components/quickSearch'
import LabPage from './components/LabPage'
import Bank from './sections/Bank'
import Compute from './sections/Compute'
import Graph from './sections/Graph'
import Library from './sections/Library'
import Review from './sections/Review'

type Tab = 'library' | 'bank' | 'review' | 'compute' | 'graph' | 'lab'

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
  { id: 'review', label: '复习计划' },
  { id: 'compute', label: '计算台' },
  { id: 'graph', label: '知识图谱' },
  { id: 'lab', label: '电路实验台' },
]

export default function App() {
  const [tab, setTab] = useState<Tab>('library')
  const [theme, setTheme] = useState<'light' | 'dark'>(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  )
  const [courses, setCourses] = useState<Course[]>([])
  const [activeCourseId, setActiveCourseId] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [notice, setNotice] = useState('')
  const [libraryJump, setLibraryJump] = useState<LibraryJump | null>(null)
  const [bankJump, setBankJump] = useState<BankJump | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const jumpSeq = useRef(0)

  const isMac =
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
  const modKey = isMac ? '⌘' : 'Ctrl'

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

  const toggleTheme = () =>
    setTheme((t) => {
      const next = t === 'dark' ? 'light' : 'dark'
      if (next === 'dark') document.documentElement.dataset.theme = 'dark'
      else delete document.documentElement.dataset.theme
      localStorage.setItem('courseta.theme', next)
      return next
    })

  function goTab(id: Tab) {
    setTab(id)
    setLibraryJump(null)
    setBankJump(null)
  }

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = TABS.map((t, index) => ({
      id: `tab:${t.id}`,
      label: t.label,
      group: '前往',
      hint: `${modKey}+${index + 1}`,
      keywords: [t.id],
      run: () => goTab(t.id),
    }))
    for (const c of courses) {
      list.push({
        id: `course:${c.id}`,
        label: `切换到课程：${c.name}`,
        group: '课程',
        hint: c.id === activeCourseId ? '当前' : undefined,
        keywords: [c.name, 'course', '切换'],
        run: () => setActiveCourseId(c.id),
      })
    }
    list.push(
      {
        id: 'action:new-course',
        label: '新建课程',
        group: '操作',
        keywords: ['create', 'xinjian', '添加'],
        run: () => setCreating(true),
      },
      {
        id: 'action:theme',
        label: theme === 'dark' ? '切换到浅色模式' : '切换到深色模式',
        group: '操作',
        keywords: ['theme', 'dark', 'light', '主题', '深色', '浅色'],
        run: toggleTheme,
      },
      {
        id: 'action:review',
        label: '开始复习 / 考试冲刺',
        group: '操作',
        keywords: ['review', 'fuxi', '冲刺', '考试', '复习计划'],
        run: () => goTab('review'),
      },
      {
        id: 'action:layout',
        label: '到「课程资料」上传材料（PDF / Word / 图片）',
        group: '操作',
        keywords: ['upload', 'shangchuan', '材料', '上传', 'docx', '图片'],
        run: () => goTab('library'),
      },
    )
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [courses, activeCourseId, theme, modKey])

  // ⌘/Ctrl+K 打开命令面板；⌘/Ctrl+1..6 直接切分区
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
        return
      }
      const digit = Number(e.key)
      if (digit >= 1 && digit <= TABS.length) {
        e.preventDefault()
        const target = TABS[digit - 1]
        setTab(target.id)
        setLibraryJump(null)
        setBankJump(null)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="app-shell">
      <nav className="topbar">
        <span className="brand-mini">CourseTA</span>
        <button
          type="button"
          className="mini ghost topbar-search"
          onClick={() => setPaletteOpen(true)}
          title={`搜索功能、课程与操作（${modKey}+K）`}
          aria-label="搜索功能、课程与操作"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="6.8" cy="6.8" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
            <path
              d="M10.4 10.4 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          <span className="topbar-kbd">{modKey} K</span>
        </button>
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
          <button
            className="mini ghost theme-toggle"
            onClick={toggleTheme}
            title={theme === 'dark' ? '切换到浅色模式' : '切换到深色模式'}
          >
            {theme === 'dark' ? '浅色' : '深色'}
          </button>
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
        <Library
          key={activeCourseId ?? 'none'}
          courseId={activeCourseId}
          jump={libraryJump}
          onOpenProblem={(problemId) => {
            setBankJump({ problemId, seq: ++jumpSeq.current })
            setTab('bank')
          }}
        />
      )}
      {tab === 'bank' && (
        <Bank key={activeCourseId ?? 'none'} courseId={activeCourseId} jump={bankJump} />
      )}
      {tab === 'review' && (
        <Review
          key={activeCourseId ?? 'none'}
          courseId={activeCourseId}
          onOpenProblem={(problemId) => {
            setBankJump({ problemId, seq: ++jumpSeq.current })
            setTab('bank')
          }}
        />
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

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}
    </div>
  )
}
