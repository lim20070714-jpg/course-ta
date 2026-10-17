import { useCallback, useEffect, useState } from 'react'
import type { AttemptHistory } from '../api'
import { getAttemptHistory } from '../api'
import type { TraceDay, VerdictKey } from '../components/traceGroups'
import {
  VERDICT_FILTERS,
  VERDICT_KEYS,
  VERDICT_LABELS,
  groupByDay,
  localTimeLabel,
  streakDays,
  verdictLabel,
} from '../components/traceGroups'

const PAGE = 200

/**
 * 做题足迹：这门课所有作答记录的时间线。
 * 题库告诉你某题最近做得怎样，这里回答的是「我这段时间到底练了什么、卡在哪」。
 */
export default function Trace({
  courseId,
  onOpenProblem,
  onOpenBank,
}: {
  courseId: number | null
  onOpenProblem?: (problemId: number) => void
  onOpenBank?: () => void
}) {
  const [data, setData] = useState<AttemptHistory | null>(null)
  const [verdict, setVerdict] = useState<'' | VerdictKey>('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(false)

  // 加载本身不置 loading：effect 里同步 setState 会多走一轮渲染，
  // 「读取中」的显示条件就是 data 还没到（首次或切换筛选后由点击事件清空）。
  const refresh = useCallback((id: number, filter: string) => {
    getAttemptHistory(id, { verdict: filter, limit: PAGE })
      .then(setData)
      .catch((e: Error) => {
        setData(null)
        setNotice(e.message)
      })
  }, [])

  useEffect(() => {
    if (courseId !== null) refresh(courseId, verdict)
  }, [courseId, verdict, refresh])

  async function loadMore() {
    if (courseId === null || !data) return
    setLoading(true)
    try {
      const next = await getAttemptHistory(courseId, {
        verdict,
        offset: data.items.length,
        limit: PAGE,
      })
      setData({ ...data, items: [...data.items, ...next.items] })
    } catch (e) {
      setNotice((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  if (courseId === null) {
    return <div className="lib-empty">还没有课程。请先在右上角新建一门课程。</div>
  }

  const counts = data?.counts ?? null
  const days: TraceDay[] = groupByDay(data?.items ?? [])
  const more = (data?.filtered ?? 0) - (data?.items.length ?? 0)

  return (
    <div className="trace-page">
      <main className="lib-main">
        {notice && <div className="lib-notice">{notice}</div>}

        <div className="trace-stats">
          {counts === null ? (
            <span className="trace-muted">读取作答记录…</span>
          ) : (
            <>
              <span className="trace-stat">
                作答 <b>{counts.total}</b> 次
              </span>
              <span className="trace-stat">
                练过 <b>{counts.problems_touched}</b> 道题
              </span>
              <span className="trace-stat">
                错过 <b>{counts.problems_ever_wrong}</b> 道
              </span>
              <span className="trace-stat">
                连续 <b>{streakDays(days)}</b> 天
              </span>
              <span className="trace-days">
                {VERDICT_KEYS.map((v) => (
                  <span key={v} className={`verdict-badge ${v}`}>
                    {VERDICT_LABELS[v]} {counts[v]}
                  </span>
                ))}
              </span>
            </>
          )}
        </div>

        <div className="trace-filters" role="tablist" aria-label="按判定筛选">
          {VERDICT_FILTERS.map((v) => (
            <button
              key={v || 'all'}
              role="tab"
              aria-selected={verdict === v}
              className={verdict === v ? 'trace-filter active' : 'trace-filter'}
              onClick={() => {
                setVerdict(v)
                setData(null)
                setNotice('')
              }}
            >
              {v === '' ? '全部' : VERDICT_LABELS[v]}
            </button>
          ))}
        </div>

        {data !== null && data.items.length === 0 && (
          <div className="lib-empty">
            {verdict
              ? `这门课还没有「${VERDICT_LABELS[verdict]}」的记录。`
              : '还没有作答记录。去题库挑一道题开始，这里的时间线就会长出来。'}
            {onOpenBank && (
              <button className="mini" onClick={onOpenBank}>
                去题库
              </button>
            )}
          </div>
        )}

        {days.map((day) => (
          <section key={day.key} className="trace-day">
            <header className="trace-day-head">
              <h3>{day.label}</h3>
              <span className="trace-day-meta">
                {day.items.length} 次作答 ·{' '}
                {VERDICT_KEYS.filter((v) => day.counts[v] > 0)
                  .map((v) => `${VERDICT_LABELS[v]} ${day.counts[v]}`)
                  .join(' · ') || '无判定'}
              </span>
            </header>
            <ul className="trace-list">
              {day.items.map((item) => (
                <li key={item.attempt_id}>
                  <span className="trace-time">{localTimeLabel(item.created_at)}</span>
                  <span className={`verdict-badge ${item.verdict}`}>
                    {verdictLabel(item.verdict)}
                  </span>
                  <span className="trace-body">
                    <span className="trace-title">
                      {item.number || '题目'} · {item.material} 第 {item.page} 页
                    </span>
                    <span className="trace-excerpt">{item.excerpt}</span>
                    {item.feedback && <span className="trace-feedback">{item.feedback}</span>}
                  </span>
                  {onOpenProblem && (
                    <button
                      className="mini ghost"
                      title="在题库里打开这道题的详解与作答"
                      onClick={() => onOpenProblem(item.problem_id)}
                    >
                      详解
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        ))}

        {more > 0 && (
          <button className="zone-empty" disabled={loading} onClick={() => void loadMore()}>
            {loading ? '读取中…' : `载入更早的 ${more} 条`}
          </button>
        )}
      </main>
    </div>
  )
}
