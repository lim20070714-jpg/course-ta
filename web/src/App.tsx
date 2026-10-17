import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import type { Course } from './api'
import { createCourse, listCourses, updateCourse } from './api'
import CommandPalette from './components/CommandPalette'
import { checkCourseName } from './components/rename'
import type { Command } from './components/quickSearch'
import SectionBoundary from './components/SectionBoundary'
import SettingsPanel from './components/SettingsPanel'
import type { LlmCredentials } from './llmKey'
import { hasCredentials, loadCredentials } from './llmKey'

// 8 个分区各自一个 chunk：计算台的 KaTeX、实验台的仿真引擎、图谱的布局不该压在首屏上
const LabPage = lazy(() => import('./components/LabPage'))
const Bank = lazy(() => import('./sections/Bank'))
const Compute = lazy(() => import('./sections/Compute'))
const Exam = lazy(() => import('./sections/Exam'))
const Graph = lazy(() => import('./sections/Graph'))
const Library = lazy(() => import('./sections/Library'))
const Review = lazy(() => import('./sections/Review'))
const Trace = lazy(() => import('./sections/Trace'))

type Tab = 'library' | 'bank' | 'review' | 'exam' | 'compute' | 'graph' | 'lab' | 'trace'

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
  { id: 'trace', label: '做题足迹' },
  { id: 'review', label: '复习计划' },
  { id: 'exam', label: '限时模考' },
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
  const [renamingCourse, setRenamingCourse] = useState(false)
  const [courseDraft, setCourseDraft] = useState('')
  const [notice, setNotice] = useState('')
  const [libraryJump, setLibraryJump] = useState<LibraryJump | null>(null)
  const [bankJump, setBankJump] = useState<BankJump | null>(null)
  const [paletteOpen, setPaletteOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [credentials, setCredentials] = useState<LlmCredentials>(loadCredentials)
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

  // 课程名出现在顶栏、模考试卷与导出物里；改名不会级联重写已经生成的这些内容。
  async function handleRenameCourse() {
    const active = courses.find((c) => c.id === activeCourseId)
    if (!active) return
    const check = checkCourseName(courseDraft)
    if (!check.ok) {
      setNotice(check.message)
      return
    }
    if (check.value === active.name) {
      setRenamingCourse(false)
      return
    }
    try {
      const updated = await updateCourse(active.id, { name: check.value })
      setCourses((cs) => cs.map((c) => (c.id === updated.id ? updated : c)))
      setRenamingCourse(false)
      setNotice(`课程已改名为「${updated.name}」`)
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

  const sectionLabel = TABS.find((t) => t.id === tab)?.label ?? '分区'
  // 计算台与实验台不属于任何一门课，换课程时不该把它们重挂载（那会丢掉当前算式和图纸）
  const boundaryKey = tab === 'compute' || tab === 'lab' ? tab : `${tab}:${activeCourseId ?? 'none'}`

  const section =
    tab === 'library' ? (
      <Library
        key={activeCourseId ?? 'none'}
        courseId={activeCourseId}
        jump={libraryJump}
        onOpenProblem={(problemId) => {
          setBankJump({ problemId, seq: ++jumpSeq.current })
          setTab('bank')
        }}
      />
    ) : tab === 'bank' ? (
      <Bank key={activeCourseId ?? 'none'} courseId={activeCourseId} jump={bankJump} />
    ) : tab === 'trace' ? (
      <Trace
        key={activeCourseId ?? 'none'}
        courseId={activeCourseId}
        onOpenProblem={(problemId) => {
          setBankJump({ problemId, seq: ++jumpSeq.current })
          setTab('bank')
        }}
        onOpenBank={() => setTab('bank')}
      />
    ) : tab === 'review' ? (
      <Review
        key={activeCourseId ?? 'none'}
        courseId={activeCourseId}
        onOpenProblem={(problemId) => {
          setBankJump({ problemId, seq: ++jumpSeq.current })
          setTab('bank')
        }}
      />
    ) : tab === 'exam' ? (
      <Exam
        key={activeCourseId ?? 'none'}
        courseId={activeCourseId}
        onOpenProblem={(problemId) => {
          setBankJump({ problemId, seq: ++jumpSeq.current })
          setTab('bank')
        }}
      />
    ) : tab === 'compute' ? (
      <Compute />
    ) : tab === 'lab' ? (
      <LabPage />
    ) : (
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
    )

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
            className="mini ghost topbar-settings"
            onClick={() => setSettingsOpen(true)}
            title="设置：AI 密钥（自带密钥可不消耗部署者额度）"
            aria-label="设置"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <circle cx="8" cy="8" r="2.6" fill="none" stroke="currentColor" strokeWidth="1.6" />
              <path
                d="M8 1.4v2M8 12.6v2M1.4 8h2M12.6 8h2M3.3 3.3l1.4 1.4M11.3 11.3l1.4 1.4M12.7 3.3l-1.4 1.4M4.7 11.3l-1.4 1.4"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
              />
            </svg>
            {hasCredentials(credentials) && <span className="topbar-key-dot" aria-hidden="true" />}
          </button>
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
              {renamingCourse ? (
                <>
                  <input
                    className="course-new"
                    aria-label="课程新名称"
                    value={courseDraft}
                    autoFocus
                    onChange={(e) => setCourseDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleRenameCourse()
                      if (e.key === 'Escape') setRenamingCourse(false)
                    }}
                  />
                  <button
                    className="mini"
                    disabled={!checkCourseName(courseDraft).ok}
                    onClick={() => void handleRenameCourse()}
                  >
                    保存
                  </button>
                  <button className="mini ghost" onClick={() => setRenamingCourse(false)}>
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
                  <button
                    className="mini ghost"
                    disabled={activeCourseId === null}
                    title="改这门课的名字"
                    onClick={() => {
                      setCourseDraft(courses.find((c) => c.id === activeCourseId)?.name ?? '')
                      setRenamingCourse(true)
                    }}
                  >
                    改名
                  </button>
                  <button className="mini ghost" onClick={() => setCreating(true)}>
                    ＋ 新建课程
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </nav>

      {notice && <div className="notice">{notice}</div>}

      <SectionBoundary key={boundaryKey} section={sectionLabel}>
        <Suspense fallback={<div className="section-loading">正在加载「{sectionLabel}」…</div>}>
          {section}
        </Suspense>
      </SectionBoundary>

      {paletteOpen && (
        <CommandPalette commands={commands} onClose={() => setPaletteOpen(false)} />
      )}
      {settingsOpen && (
        <SettingsPanel
          credentials={credentials}
          onChange={setCredentials}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  )
}
