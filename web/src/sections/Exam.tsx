import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MockExamDetail, MockExamSummary, TagCount } from '../api'
import {
  createMockExam,
  deleteMockExam,
  enrollReview,
  getMockExam,
  listMockExams,
  listProblemTags,
  saveMockAnswer,
  startMockExam,
  submitMockExam,
} from '../api'
import RichText from '../components/RichText'

const DURATIONS = [15, 30, 45, 60, 90, 120]
const VERDICT_LABEL: Record<string, string> = {
  correct: '正确',
  partial: '部分正确',
  wrong: '错误',
  unknown: '无法判断',
  unanswered: '未作答',
}

function clockText(seconds: number): string {
  const s = Math.max(0, seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const mm = String(m).padStart(2, '0')
  const ss = String(sec).padStart(2, '0')
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export default function Exam({
  courseId,
  onOpenProblem,
}: {
  courseId: number | null
  onOpenProblem: (problemId: number) => void
}) {
  const [history, setHistory] = useState<MockExamSummary[]>([])
  const [tags, setTags] = useState<TagCount[]>([])
  const [detail, setDetail] = useState<MockExamDetail | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [saving, setSaving] = useState(false)

  const [count, setCount] = useState(5)
  const [duration, setDuration] = useState(45)
  const [knowledge, setKnowledge] = useState('')

  const [seconds, setSeconds] = useState(0)
  const [drafts, setDrafts] = useState<Record<number, string>>({})
  const saveTimers = useRef<Record<number, number>>({})

  const examId = detail?.exam.id ?? null
  const status = detail?.exam.status ?? ''

  const refreshHistory = useCallback((id: number) => {
    listMockExams(id)
      .then(setHistory)
      .catch(() => undefined)
  }, [])

  // App 用 courseId 作为 key 渲染本组件，切换课程会重新挂载，状态天然回到初始值
  useEffect(() => {
    if (courseId === null) return
    refreshHistory(courseId)
    listProblemTags(courseId)
      .then(setTags)
      .catch(() => undefined)
  }, [courseId, refreshHistory])

  // 倒计时（running）与批改进度轮询（grading）
  useEffect(() => {
    if (examId === null) return
    if (status === 'running') {
      const tick = window.setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000)
      return () => window.clearInterval(tick)
    }
    if (status === 'grading') {
      const poll = window.setInterval(() => {
        getMockExam(examId)
          .then(setDetail)
          .catch(() => undefined)
      }, 2500)
      return () => window.clearInterval(poll)
    }
    return undefined
  }, [examId, status])

  async function submit() {
    if (examId === null || busy) return
    setBusy(true)
    try {
      // 交卷前把还没落盘的草稿全部写回，避免最后几秒的输入丢失
      Object.values(saveTimers.current).forEach((t) => window.clearTimeout(t))
      await Promise.all(
        Object.entries(drafts).map(([pid, text]) => saveMockAnswer(examId, Number(pid), text)),
      )
      const next = await submitMockExam(examId)
      setDetail(await getMockExam(next.id))
      if (courseId !== null) refreshHistory(courseId)
    } catch (e) {
      setNotice((e as Error).message)
      if (courseId !== null) refreshHistory(courseId)
    } finally {
      setBusy(false)
    }
  }

  // 时间到自动交卷：先用 effect 同步最新 submit，再在归零时触发
  const submitRef = useRef(submit)
  useEffect(() => {
    submitRef.current = submit
  })
  useEffect(() => {
    if (status === 'running' && seconds === 0) void submitRef.current()
  }, [status, seconds])

  const answeredCount = useMemo(
    () => Object.values(drafts).filter((v) => v.trim()).length,
    [drafts],
  )

  function queueSave(problemId: number, text: string) {
    setDrafts((d) => ({ ...d, [problemId]: text }))
    window.clearTimeout(saveTimers.current[problemId])
    saveTimers.current[problemId] = window.setTimeout(() => {
      if (examId === null) return
      setSaving(true)
      saveMockAnswer(examId, problemId, text)
        .catch((e: Error) => setNotice(e.message))
        .finally(() => setSaving(false))
    }, 700)
  }

  async function build() {
    if (courseId === null || busy) return
    setNotice('')
    setBusy(true)
    try {
      const created = await createMockExam(courseId, { count, duration_min: duration, knowledge })
      const started = await startMockExam(created.id)
      const full = await getMockExam(started.id)
      const map: Record<number, string> = {}
      full.items.forEach((it) => {
        map[it.problem_id] = it.answer_text
      })
      setDrafts(map)
      setSeconds(full.exam.seconds_left)
      setDetail(full)
      refreshHistory(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  // 从历史里打开的未开始试卷：先开考再起倒计时
  async function begin() {
    if (examId === null || busy) return
    setNotice('')
    setBusy(true)
    try {
      const started = await startMockExam(examId)
      const full = await getMockExam(started.id)
      setSeconds(full.exam.seconds_left)
      setDetail(full)
      if (courseId !== null) refreshHistory(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  async function openExam(id: number) {
    setNotice('')
    try {
      const full = await getMockExam(id)
      const map: Record<number, string> = {}
      full.items.forEach((it) => {
        map[it.problem_id] = it.answer_text
      })
      setDrafts(map)
      setSeconds(full.exam.seconds_left)
      setDetail(full)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function drop(id: number) {
    try {
      await deleteMockExam(id)
      if (examId === id) setDetail(null)
      if (courseId !== null) refreshHistory(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function enrollWrong() {
    if (!detail) return
    const targets = detail.items.filter((i) => ['wrong', 'partial', 'unanswered'].includes(i.verdict))
    if (targets.length === 0) {
      setNotice('这次没有需要重点复习的题目。')
      return
    }
    try {
      await Promise.all(targets.map((t) => enrollReview(t.problem_id)))
      setNotice(`已把 ${targets.length} 道未掌握的题加入复习计划。`)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程。</div>
  }

  const exam = detail?.exam
  const done = status === 'done'
  const running = status === 'running'
  const counts = (verdict: string) =>
    (detail?.items ?? []).filter((i) => i.verdict === verdict).length

  return (
    <div className="exam-page">
      {exam && (
        <div className="exam-bar">
          {status === 'ready' && (
            <div className="exam-clock">
              <span className="exam-clock-label">未开始</span>
              <span className="exam-clock-num">{exam.duration_min}:00</span>
              <span className="exam-clock-hint">
                {exam.title} · {exam.count} 题；点击开始后倒计时启动，参考答案在批改完成前不会显示。
              </span>
              <button onClick={begin} disabled={busy}>
                {busy ? '开考中…' : '开始作答'}
              </button>
            </div>
          )}
          {running && (
            <div className={`exam-clock ${seconds < 60 ? 'danger' : ''}`}>
              <span className="exam-clock-label">剩余时间</span>
              <span className="exam-clock-num">{clockText(seconds)}</span>
              <span className="exam-clock-progress">
                {answeredCount} / {exam.count} 已答{saving && ' · 保存中'}
              </span>
              <button onClick={() => void submit()} disabled={busy}>
                交卷批改
              </button>
            </div>
          )}
          {status === 'grading' && (
            <div className="exam-clock grading">
              <span className="exam-clock-label">批改中</span>
              <span className="exam-clock-num">
                {exam.graded} / {exam.count}
              </span>
              <span className="exam-clock-hint">逐题步骤级批改进行中，请稍候…</span>
            </div>
          )}
          {done && (
            <div className="exam-score-band">
              <div className="exam-score">
                <span className="exam-score-num">{exam.score.toFixed(0)}</span>
                <span className="exam-score-unit">分</span>
              </div>
              <div className="exam-score-meta">
                <div className="exam-score-title">{exam.title}</div>
                <div className="exam-score-tags">
                  {['correct', 'partial', 'wrong', 'unanswered'].map((v) =>
                    counts(v) > 0 ? (
                      <span key={v} className={`verdict-badge ${v}`}>
                        {VERDICT_LABEL[v]} {counts(v)}
                      </span>
                    ) : null,
                  )}
                  {exam.late && <span className="exam-chip late">超时交卷</span>}
                </div>
              </div>
              <div className="exam-score-actions">
                <button onClick={enrollWrong}>未掌握的题加入复习计划</button>
                <button className="mini ghost" onClick={() => setDetail(null)}>
                  返回列表
                </button>
              </div>
            </div>
          )}
          {status === 'failed' && (
            <div className="exam-score-band">
              <div className="exam-score-meta">
                <div className="exam-score-title">批改失败</div>
                <div className="exam-score-tags">{exam.error || '模型调用失败，请重试或新建一场。'}</div>
              </div>
              <div className="exam-score-actions">
                <button className="mini ghost" onClick={() => setDetail(null)}>
                  返回列表
                </button>
              </div>
            </div>
          )}
          {notice && <div className="lib-notice">{notice}</div>}
        </div>
      )}

      {detail ? (
        <div className="exam-paper">
          {detail.items.map((item, index) => (
            <section key={item.problem_id} className="exam-item">
              <header className="exam-item-head">
                <span className="exam-no">{index + 1}</span>
                <span className="exam-src">
                  {item.number || '未编号'} · {item.material} 第 {item.page} 页
                </span>
                {item.knowledge.map((k) => (
                  <span key={k} className="tag">
                    {k}
                  </span>
                ))}
                {done && (
                  <span className={`verdict-badge small ${item.verdict}`}>
                    {VERDICT_LABEL[item.verdict]}
                  </span>
                )}
              </header>
              <div className="md-body bubble exam-stem">
                <RichText text={item.stem} />
              </div>
              {done ? (
                <div className="exam-answer-pair">
                  <div className="exam-mine">
                    <h4>我的作答</h4>
                    <div className="md-body">
                      <RichText text={item.answer_text || '（未作答）'} />
                    </div>
                  </div>
                  {item.answer && (
                    <div className="exam-ref">
                      <h4>参考答案</h4>
                      <div className="md-body">
                        <RichText text={item.answer} />
                      </div>
                    </div>
                  )}
                  {item.feedback && (
                    <div className="exam-feedback">
                      <h4>助教点评</h4>
                      <div className="md-body">
                        <RichText text={item.feedback} />
                      </div>
                      <button className="link" onClick={() => onOpenProblem(item.problem_id)}>
                        到题库看完整详解
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <textarea
                  className="exam-input"
                  placeholder="写出你的推导与结果，支持 LaTeX（$…$）。内容会自动保存。"
                  value={drafts[item.problem_id] ?? item.answer_text}
                  onChange={(e) => queueSave(item.problem_id, e.target.value)}
                  disabled={!running}
                />
              )}
            </section>
          ))}
        </div>
      ) : (
        <div className="exam-home">
          <div className="exam-setup">
            <h2>限时模考</h2>
            <p className="exam-sub">
              从题库随机抽题组卷，按真实考试节奏限时作答；交卷后逐题步骤级批改并给出百分制得分。
              计时以服务端为准，刷新页面不会重置倒计时，最后几秒的作答也会在交卷时一并保存。
            </p>
            <div className="exam-controls">
              <label className="exam-field">
                <span>题数</span>
                <input
                  type="number"
                  min={1}
                  max={50}
                  value={count}
                  onChange={(e) => setCount(Math.min(50, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
              <label className="exam-field">
                <span>时长</span>
                <select
                  value={duration}
                  onChange={(e) => {
                    setDuration(Number(e.target.value))
                  }}
                >
                  {DURATIONS.map((d) => (
                    <option key={d} value={d}>
                      {d} 分钟
                    </option>
                  ))}
                </select>
              </label>
              <label className="exam-field grow">
                <span>知识点范围</span>
                <select value={knowledge} onChange={(e) => setKnowledge(e.target.value)}>
                  <option value="">全部知识点</option>
                  {tags.map((t) => (
                    <option key={t.tag} value={t.tag}>
                      {t.tag}（{t.count} 题）
                    </option>
                  ))}
                </select>
              </label>
              <button className="review-start" onClick={build} disabled={busy}>
                {busy ? '组卷中…' : '开始模考'}
              </button>
            </div>
            <p className="exam-hint">
              按当前设置每题约 {Math.max(1, Math.round((duration * 60) / count))} 秒；
              只有带参考答案的题目才会进入组卷。
            </p>
            {notice && <div className="lib-notice">{notice}</div>}
          </div>

          {history.length > 0 && (
            <div className="exam-history">
              <h3>历史模考</h3>
              {history.map((h) => (
                <div key={h.id} className="exam-row">
                  <button className="exam-row-main" onClick={() => openExam(h.id)}>
                    <span className="exam-row-title">{h.title}</span>
                    <span className="exam-row-meta">
                      {h.count} 题 · {h.duration_min} 分钟 ·{' '}
                      {h.status === 'done'
                        ? `${h.score.toFixed(0)} 分${h.late ? ' · 超时' : ''}`
                        : h.status === 'grading'
                          ? '批改中'
                          : h.status === 'running'
                            ? '进行中'
                            : h.status === 'failed'
                              ? '批改失败'
                              : '未开始'}
                    </span>
                  </button>
                  <button className="mini ghost" onClick={() => drop(h.id)}>
                    删除
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
