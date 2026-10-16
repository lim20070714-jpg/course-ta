import { useCallback, useEffect, useState } from 'react'
import type { ProblemDetail, ReviewDueItem, ReviewStats } from '../api'
import {
  getProblem,
  getReviewCards,
  getReviewDue,
  getReviewStats,
  gradeReview,
  removeReview,
} from '../api'
import RichText from '../components/RichText'

// 自评分 → SM-2 质量分（<3 视为遗忘）
const GRADES: { quality: number; label: string; hint: string }[] = [
  { quality: 1, label: '忘了', hint: '明天重来' },
  { quality: 3, label: '困难', hint: '间隔缩短' },
  { quality: 4, label: '良好', hint: '正常推进' },
  { quality: 5, label: '轻松', hint: '间隔拉长' },
]

const DAY_MS = 86400000

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

  // 会话状态
  const [queue, setQueue] = useState<ReviewDueItem[]>([])
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

  function startSession() {
    if (courseId === null) return
    setNotice('')
    getReviewDue(courseId)
      .then((due) => {
        if (due.length === 0) {
          setNotice('现在没有到期的卡片，稍后再来。')
          return
        }
        setQueue(due)
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

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程。</div>
  }

  const inSession = queue.length > 0
  const finished = inSession && idx >= queue.length

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
                    </span>
                  </div>
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
                        {detail.answer ? (
                          <div className="md-body bubble review-answer">
                            <RichText text={detail.answer} />
                          </div>
                        ) : (
                          <div className="review-answer-missing">
                            材料未附带解答。
                            <button className="link" onClick={() => onOpenProblem(detail.id)}>
                              去题库看 AI 详解
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
              {stats && stats.due_now > 0 && (
                <button className="review-start" onClick={startSession}>
                  开始复习（{stats.due_now} 张到期）
                </button>
              )}
            </div>

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

            <div className="review-list">
              {cards.map((c) => {
                const overdue = new Date(c.due_at).getTime() <= nowMs
                return (
                  <div key={c.problem_id} className="review-row">
                    <button className="review-row-main" onClick={() => onOpenProblem(c.problem_id)}>
                      <span className="prob-src-slim">
                        {c.material} · 第 {c.page} 页 {c.number && `· ${c.number}`}
                      </span>
                      <span className="prob-excerpt">{c.excerpt}</span>
                    </button>
                    <div className="review-row-side">
                      <span className={`review-due ${overdue ? 'overdue' : ''}`}>
                        {dueLabel(c.due_at)}
                      </span>
                      <span className="review-meta">
                        间隔 {intervalLabel(c.interval_days)} · 连对 {c.reps}
                        {c.lapses > 0 && ` · 忘过 ${c.lapses} 次`}
                      </span>
                      <button className="mini ghost" onClick={() => removeCard(c.problem_id)}>
                        移出计划
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
