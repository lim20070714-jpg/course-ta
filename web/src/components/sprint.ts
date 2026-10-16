/** 考试冲刺模式（考试冲刺模式）的纯展示逻辑。
 *
 * 这里只做字符串 / 数组映射与筛选，不发请求、不依赖 DOM，便于单测覆盖边界：
 * 未设置日期、考试当天、考试已过、进入 / 未进入 30 天冲刺窗口。
 */

export interface SprintTagLike {
  knowledge: string
  count: number
}

/** 冲刺入口只需要这些字段，ReviewSprint 结构上可直接传入。 */
export interface SprintLike {
  sprint: boolean
  status: string
  recommended: number
  due_count: number
  top_tags: SprintTagLike[]
}

export type SprintTone = 'none' | 'over' | 'today' | 'soon' | 'far' | 'sprint' | 'normal'

export interface SprintBadge {
  key: SprintTone
  label: string
}

export interface SprintCta {
  show: boolean
  label: string
  hint: string
}

/** 倒计时文案：0 = 就是今天，1 = 明天考试，负数 = 考试已过，N = 还有 N 天。 */
export function countdownLabel(daysLeft: number | null): string {
  if (daysLeft === null) return '未设置考试日期'
  if (daysLeft < 0) return `考试已过 ${-daysLeft} 天`
  if (daysLeft === 0) return '就是今天'
  if (daysLeft === 1) return '明天考试'
  return `还有 ${daysLeft} 天`
}

/** 倒计时紧急度，用于选择配色（不产生任何负面天数措辞）。 */
export function countdownTone(daysLeft: number | null): SprintTone {
  if (daysLeft === null) return 'none'
  if (daysLeft < 0) return 'over'
  if (daysLeft === 0) return 'today'
  if (daysLeft <= 7) return 'soon'
  return 'far'
}

/** status / stage → 徽章文案与配色键。stage 为空时回落到通用文案。 */
export function sprintBadge(status: string, stage: string): SprintBadge {
  if (status === 'sprint') return { key: 'sprint', label: stage || '冲刺中' }
  if (status === 'normal') return { key: 'normal', label: '常规复习' }
  if (status === 'over') return { key: 'over', label: '考试已过' }
  return { key: 'none', label: '未开启冲刺' }
}

/** 压缩节奏数组 → 可读中文，如 [1,2,4] → "1 天 → 2 天 → 4 天"。保持后端顺序。 */
export function formatSchedule(schedule: number[]): string {
  if (schedule.length === 0) return ''
  return schedule.map((days) => `${days} 天`).join(' → ')
}

/** 是否展示冲刺入口，以及入口文案与高频考点提示。 */
export function sprintCta(sprint: SprintLike | null): SprintCta {
  if (!sprint || !sprint.sprint || sprint.recommended <= 0) {
    return { show: false, label: '', hint: '' }
  }
  const head = sprint.top_tags[0]
  const hint = head
    ? sprint.top_tags.length > 1
      ? `优先复习「${head.knowledge}」等 ${sprint.top_tags.length} 个高频考点`
      : `优先复习「${head.knowledge}」`
    : ''
  return { show: true, label: `开始冲刺（${sprint.recommended} 张）`, hint }
}

/** 客户端按知识点筛选返回的队列；tag 为空时原样返回，不改变顺序。 */
export function filterQueueByTag<T extends { knowledge: string[] }>(
  queue: T[],
  tag: string | null,
): T[] {
  const key = tag?.trim()
  if (!key) return queue
  return queue.filter((item) => item.knowledge.some((k) => k.trim() === key))
}

/** exam_date → <input type="date"> 的 value（仅日期部分）；无法识别时返回空串。 */
export function toDateInputValue(examDate: string | null): string {
  if (!examDate) return ''
  const head = examDate.slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(head) ? head : ''
}
