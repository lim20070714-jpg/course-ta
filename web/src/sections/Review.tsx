import { useCallback, useEffect, useState } from 'react'
import type { ProblemDetail, ReviewDueItem, ReviewSprint, ReviewStats } from '../api'
import {
  getProblem,
  getReviewCards,
  getReviewDue,
  getReviewSprint,
  getReviewStats,
  gradeReview,
  removeReview,
  setExamDate,
} from '../api'
import RichText from '../components/RichText'
import {
  countdownLabel,
  countdownTone,
  filterQueueByTag,
  formatSchedule,
  sprintBadge,
  sprintCta,
  toDateInputValue,
} from '../components/sprint'

// 自评分 → SM-2 质量分（<3 视为遗忘）
const GRADES: { quality: number; label: string; hint: string }[] = [
  { quality: 1, label: '忘了', hint: '明天重来' },
  { quality: 3, label: '困难', hint: '间隔缩短' },
  { quality: 4, label: '良好', hint: '正常推进' },
  { quality: 5, label: '轻松', hint: '间隔拉长' },
]

const DAY_MS = 86400000
const DUE_LIMIT = 100
const MAX_LIMIT = 500

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function dueLabel(dueAt: string): string {
  const due = new Date(dueAt)
  const now = new Date()
  const days = Math.round((startOfDay(due) - startOfDay(now)) / DAY_MS)
  if (days < 0) return `逾期 ${-days} 天`
  if (days === 0) return '今天'
  if (days === 1) return '明天'
  return `${days} 天后`
}

function intervalLabel(days: number): string {
  if (days < 1) return '当天'
  if (days < 30) return `${Math.round(days)} 天`
  if (days < 365) return `${(days / 30).toFixed(1)} 个月`
  return `${(days / 365).toFixed(1)} 年`
}

export default function Review({
  courseId,
  onOpenProblem,
}: {
  courseId: number | null
  onOpenProblem: (problemId: number) => void
}) {
  const [stats, setStats] = useState<ReviewStats | null>(null)
  const [cards, setCards] = useState<ReviewDueItem[]>([])
  const [nowMs, setNowMs] = useState(0)
  const [loaded, setLoaded] = useState(false)
  const [notice, setNotice] = useState('')

  // 冲刺模式（考试日期 / 倒计时 / 高频考点）；请求失败时为 null，界面按原有形态工作。
  // 数据带上所属课程 id，切换课程时在渲染期自然失效，无需在 effect 里同步重置。
  const [sprintState, setSprintState] = useState<{
    course: number
    data: ReviewSprint | null
  } | null>(null)
  const [examSaving, setExamSaving] = useState(false)
  const [tagFilterState, setTagFilterState] = useState<{ course: number; tag: string } | null>(null)

  // 会话状态
  const [queue, setQueue] = useState<ReviewDueItem[]>([])
  const [sessionMode, setSessionMode] = useState<'due' | 'sprint'>('due')
  const [idx, setIdx] = useState(0)
  const [detail, setDetail] = useState<ProblemDetail | null>(null)
  const [revealed, setRevealed] = useState(false)
  const [grading, setGrading] = useState(false)
  const [lastResult, setLastResult] = useState('')
  const [reviewed, setReviewed] = useState(0)

  const refresh = useCallback((id: number) => {
    getReviewStats(id)
      .then(setStats)
      .catch(() => undefined)
    getReviewSprint(id)
      .then((data) => setSprintState({ course: id, data }))
      .catch(() => setSprintState({ course: id, data: null }))
    getReviewCards(id)
      .then((rows) => {
        setNowMs(Date.now())
        setCards(rows)
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [])

  useEffect(() => {
    if (courseId !== null) refresh(courseId)
  }, [courseId, refresh])

  const loadDetail = useCallback((id: number) => {
    setDetail(null)
    setRevealed(false)
    setLastResult('')
    getProblem(id)
      .then(setDetail)
      .catch((e: Error) => setNotice(e.message))
  }, [])

  function startSession(mode: 'due' | 'sprint' = 'due') {
    if (courseId === null) return
    setNotice('')
    // 冲刺队列由后端按权重排好序，这里只负责原样呈现，不做任何重排
    const wantSprint = mode === 'sprint' && sprint !== null && sprint.sprint
    const limit = wantSprint
      ? Math.min(MAX_LIMIT, Math.max(DUE_LIMIT, sprint.recommended))
      : DUE_LIMIT
    getReviewDue(courseId, limit, wantSprint)
      .then((due) => {
        if (due.length === 0) {
          setNotice(wantSprint ? '冲刺队列暂时没有可复习的卡片。' : '现在没有到期的卡片，稍后再来。')
          return
        }
        setQueue(due)
        setSessionMode(wantSprint ? 'sprint' : 'due')
        setIdx(0)
        setReviewed(0)
        loadDetail(due[0].problem_id)
      })
      .catch((e: Error) => setNotice(e.message))
  }

  function exitSession() {
    setQueue([])
    setDetail(null)
    if (courseId !== null) refresh(courseId)
  }

  function skip() {
    const next = idx + 1
    setLastResult('')
    if (next < queue.length) {
      setIdx(next)
      loadDetail(queue[next].problem_id)
    } else {
      setIdx(next)
    }
  }

  async function grade(quality: number) {
    if (!detail || grading) return
    setGrading(true)
    setNotice('')
    try {
      const card = await gradeReview(detail.id, quality)
      setLastResult(
        quality < 3
          ? '已安排明天再见一次。'
          : `记得不错，下次复习安排在 ${intervalLabel(card.interval_days)}后。`,
      )
      setReviewed((n) => n + 1)
      if (courseId !== null) getReviewStats(courseId).then(setStats).catch(() => undefined)
      const next = idx + 1
      if (next < queue.length) {
        setTimeout(() => {
          setIdx(next)
          loadDetail(queue[next].problem_id)
        }, 650)
      } else {
        setTimeout(() => setIdx(next), 650)
      }
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setGrading(false)
    }
  }

  async function removeCard(id: number) {
    try {
      await removeReview(id)
      setCards((rows) => rows.filter((c) => c.problem_id !== id))
      if (courseId !== null) getReviewStats(courseId).then(setStats).catch(() => undefined)
    } catch (e) {
      setNotice((e as Error).message)
    }
  }

  async function changeExamDate(value: string) {
    if (courseId === null || examSaving) return
    setExamSaving(true)
    setNotice('')
    try {
      await setExamDate(courseId, value ? value : null)
      setTagFilterState(null)
      refresh(courseId)
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setExamSaving(false)
    }
  }

  function toggleTag(tag: string) {
    const id = courseId
    if (id === null) return
    setTagFilterState((cur) =>
      cur !== null && cur.course === id && cur.tag === tag ? { course: id, tag: '' } : { course: id, tag },
    )
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程。</div>
  }

  const inSession = queue.length > 0
  const finished = inSession && idx >= queue.length
  const sprint = sprintState !== null && sprintState.course === courseId ? sprintState.data : null
  const tagFilter =
    tagFilterState !== null && tagFilterState.course === courseId ? tagFilterState.tag : null
  const cta = sprintCta(sprint)
  const badge = sprint && sprint.exam_date ? sprintBadge(sprint.status, sprint.stage) : null
  const visibleCards = filterQueueByTag(cards, tagFilter)

  return (
    <div className="review-page">
      <main className="lib-main">
        {notice && <div className="lib-notice">{notice}</div>}

        {inSession ? (
          finished ? (
            <div className="review-session">
              <div className="review-done">
                <h2>本次复习完成</h2>
                <p>共复习 {reviewed} 张卡片{queue.length - reviewed > 0 && `，跳过 ${queue.length - reviewed} 张`}。</p>
                <div className="review-done-actions">
                  <button onClick={exitSession}>返回复习计划</button>
                </div>
              </div>
            </div>
          ) : (
            <div className="review-session">
              {sessionMode === 'sprint' && (
                <div className="review-sprint-banner">
                  <span className="sprint-badge tone-sprint">冲刺模式</span>
                  <span>队列已按考频权重排好序，先做最值钱的题。</span>
                </div>
              )}
              <div className="review-session-head">
                <span className="review-progress">
                  {idx + 1} / {queue.length}
                </span>
                <div className="review-progress-bar">
                  <div
                    className="review-progress-fill"
                    style={{ width: `${(idx / queue.length) * 100}%` }}
                  />
                </div>
                <button className="mini ghost" onClick={exitSession}>
                  结束本次
                </button>
              </div>
              {detail ? (
                <div className="review-card">
                  <div className="prob-card-top">
                    <span className="prob-src-slim">
                      {detail.material} · 第 {detail.page} 页
                      {detail.number && ` · ${detail.number}`}
                    </span>
                    <span className="review-meta">
                      已连对 {queue[idx].reps} 次 · 间隔 {intervalLabel(queue[idx].interval_days)}
                      {typeof queue[idx].weight === 'number' &&
                        queue[idx].weight > 0 &&
                        ` · 权重 ${queue[idx].weight.toFixed(1)}`}
                    </span>
                  </div>
                  {(queue[idx].reasons?.length ?? 0) > 0 && (
                    <div className="review-reasons">
                      {queue[idx].reasons?.map((reason) => (
                        <span key={reason} className="review-reason">
                          {reason}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="prob-tags">
                    {detail.knowledge.map((tag) => (
                      <span key={tag} className="tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className={revealed ? 'flip-box flipped' : 'flip-box'}>
                    <div className="flip-inner">
                      <div className="flip-face flip-front">
                        <div className="md-body bubble prob-stem">
                          <RichText text={detail.stem} />
                        </div>
                      </div>
                      <div className="flip-face flip-back">
                        {detail.answer || detail.solution ? (
                          <div className="md-body bubble review-answer">
                            <RichText text={detail.answer || detail.solution} />
                          </div>
                        ) : (
                          <div className="review-answer-missing">
                            材料未附带解答。
                            <button className="link" onClick={() => onOpenProblem(detail.id)}>
                              去题库看 AI 草稿
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                  {revealed ? (
                    <>
                      {lastResult && <p className="review-result">{lastResult}</p>}
                      <div className="review-grades">
                        {GRADES.map((g) => (
                          <button
                            key={g.quality}
                            className={`review-grade g${g.quality}`}
                            onClick={() => grade(g.quality)}
                            disabled={grading || !!lastResult}
                          >
                            <span className="review-grade-label">{g.label}</span>
                            <span className="review-grade-hint">{g.hint}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  ) : (
                    <div className="review-actions">
                      <button onClick={() => setRevealed(true)}>显示答案</button>
                      <button className="ghost-btn" onClick={skip}>
                        想不起来，跳过
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <p className="empty">加载题目中…</p>
              )}
            </div>
          )
        ) : (
          <>
            <div className="review-head">
              <div>
                <h2>复习计划</h2>
                <p className="review-sub">
                  按 SM-2 间隔重复安排：在题库题目页点「加入复习计划」，到期题目会出现在这里。
                </p>
              </div>
              <div className="review-head-actions">
                {cta.show && (
                  <button className="review-start sprint-start" onClick={() => startSession('sprint')}>
                    {cta.label}
                  </button>
                )}
                {stats && stats.due_now > 0 && (
                  <button
                    className={cta.show ? 'review-start ghost-btn' : 'review-start'}
                    onClick={() => startSession('due')}
                  >
                    开始复习（{stats.due_now} 张到期）
                  </button>
                )}
              </div>
            </div>

            {sprint && (
              <section className={sprint.sprint ? 'sprint-panel active' : 'sprint-panel'}>
                <div className="sprint-panel-head">
                  <div className="sprint-panel-title">
                    <h3>考试冲刺</h3>
                    <p className="sprint-sub">
                      {sprint.exam_date ? sprint.message : '设置考试日期后可开启冲刺模式'}
                    </p>
                  </div>
                  <div className="sprint-date-row">
                    <label className="sprint-date">
                      <span>考试日期</span>
                      <input
                        type="date"
                        value={toDateInputValue(sprint.exam_date)}
                        disabled={examSaving}
                        onChange={(e) => changeExamDate(e.target.value)}
                      />
                    </label>
                    {sprint.exam_date && (
                      <button
                        className="mini ghost"
                        disabled={examSaving}
                        onClick={() => changeExamDate('')}
                      >
                        清除
                      </button>
                    )}
                  </div>
                </div>

                {sprint.exam_date && (
                  <>
                    <div className="sprint-metrics">
                      <div className={`sprint-countdown tone-${countdownTone(sprint.days_left)}`}>
                        <span className="sprint-countdown-num">
                          {countdownLabel(sprint.days_left)}
                        </span>
                        {badge && (
                          <span className={`sprint-badge tone-${badge.key}`}>{badge.label}</span>
                        )}
                      </div>
                      <div className="sprint-facts">
                        <span>计划 {sprint.sprint_pool} 张</span>
                        <span>已到期 {sprint.due_count} 张</span>
                        {sprint.sprint && <span>冲刺队列 {sprint.recommended} 张</span>}
                        <span>知识点 {sprint.tag_total} 个</span>
                      </div>
                    </div>

                    {sprint.status === 'over' ? (
                      <p className="sprint-note warn">
                        {`${countdownLabel(sprint.days_left)}：可把日期更新为下一次考试重新开启冲刺，或清除日期恢复常规复习。`}
                      </p>
                    ) : sprint.sprint && sprint.schedule.length > 0 ? (
                      <p className="sprint-schedule">
                        复习节奏 {formatSchedule(sprint.schedule)}
                      </p>
                    ) : (
                      <p className="sprint-note">
                        超过 30 天，暂未进入冲刺模式。
                        {sprint.schedule.length > 0 &&
                          `进入冲刺后复习节奏将压缩为 ${formatSchedule(sprint.schedule)}。`}
                      </p>
                    )}

                    {sprint.sprint && cta.show && cta.hint && (
                      <p className="sprint-note">{cta.hint}</p>
                    )}

                    {sprint.top_tags.length > 0 && (
                      <div className="sprint-tags">
                        <span className="sprint-tags-label">高频考点</span>
                        <div className="sprint-tag-list">
                          {sprint.top_tags.map((tag, i) => (
                            <button
                              key={tag.knowledge}
                              className={`sprint-tag${tagFilter === tag.knowledge ? ' active' : ''}`}
                              title={`命中 ${tag.count} 道题`}
                              onClick={() => toggleTag(tag.knowledge)}
                            >
                              <span className="sprint-tag-rank">{i + 1}</span>
                              <span className="sprint-tag-name">{tag.knowledge}</span>
                              <span className="sprint-tag-count">{tag.count} 题</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </section>
            )}

            {stats && (
              <div className="review-stats">
                <div className="review-stat">
                  <span className="review-stat-num">{stats.due_now}</span>
                  <span className="review-stat-label">今日到期</span>
                </div>
                <div className="review-stat">
                  <span className="review-stat-num">{stats.card_count}</span>
                  <span className="review-stat-label">计划中的题目</span>
                </div>
                <div className="review-stat">
                  <span className="review-stat-num">{stats.reviewed_today}</span>
                  <span className="review-stat-label">今日已复习</span>
                </div>
                <div className="review-forecast">
                  <span className="review-stat-label">未来 7 天到期</span>
                  <div className="review-bars">
                    {stats.forecast.map((d) => {
                      const max = Math.max(...stats.forecast.map((x) => x.count), 1)
                      return (
                        <div key={d.date} className="review-bar-col" title={`${d.date}：${d.count} 张`}>
                          <div className="review-bar" style={{ height: `${(d.count / max) * 56}px` }} />
                          <span className="review-bar-label">{d.date.slice(5)}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            )}

            {stats && stats.card_count > 0 && stats.due_now === 0 && cards.length > 0 && (
              <div className="review-clear">
                今天的卡片都复习完了。下一张到期：{dueLabel(cards[0].due_at)}
              </div>
            )}

            {!loaded && <p className="empty">加载中…</p>}
            {loaded && cards.length === 0 && (
              <div className="lib-welcome">
                <h2>复习计划还是空的</h2>
                <p>
                  到「题库与解答」打开任意题目，点「加入复习计划」；做错的题会自动进入错题本，也建议加入计划定期回顾。
                </p>
              </div>
            )}

            {tagFilter && (
              <div className="review-filter-bar">
                <span>
                  只看「{tagFilter}」：{visibleCards.length} / {cards.length} 张
                </span>
                <button className="mini ghost" onClick={() => setTagFilterState(null)}>
                  清除筛选
                </button>
              </div>
            )}

            <div className="review-list">
              {visibleCards.map((c) => {
                const overdue = new Date(c.due_at).getTime() <= nowMs
                return (
                  <div key={c.problem_id} className="review-row">
                    <button className="review-row-main" onClick={() => onOpenProblem(c.problem_id)}>
                      <span className="prob-src-slim">
                        {c.material} · 第 {c.page} 页 {c.number && `· ${c.number}`}
                      </span>
                      <span className="prob-excerpt">{c.excerpt}</span>
                      {(c.reasons?.length ?? 0) > 0 && (
                        <span className="review-reasons">
                          {c.reasons?.map((reason) => (
                            <span key={reason} className="review-reason">
                              {reason}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                    <div className="review-row-side">
                      <span className={`review-due ${overdue ? 'overdue' : ''}`}>
                        {dueLabel(c.due_at)}
                      </span>
                      <span className="review-meta">
                        间隔 {intervalLabel(c.interval_days)} · 连对 {c.reps}
                        {c.lapses > 0 && ` · 忘过 ${c.lapses} 次`}
                        {typeof c.weight === 'number' && c.weight > 0 && ` · 权重 ${c.weight.toFixed(1)}`}
                      </span>
                      <button className="mini ghost" onClick={() => removeCard(c.problem_id)}>
                        移出计划
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>

            {loaded && cards.length > 0 && visibleCards.length === 0 && (
              <p className="empty">该考点暂无计划中的卡片。</p>
            )}
          </>
        )}
      </main>
    </div>
  )
}
