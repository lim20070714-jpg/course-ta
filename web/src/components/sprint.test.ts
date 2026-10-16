import { describe, expect, it } from 'vitest'

import {
  countdownLabel,
  countdownTone,
  filterQueueByTag,
  formatSchedule,
  sprintBadge,
  sprintCta,
  toDateInputValue,
} from './sprint'
import type { SprintLike } from './sprint'

const sprintPayload = (patch: Partial<SprintLike> = {}): SprintLike => ({
  sprint: true,
  status: 'sprint',
  recommended: 12,
  due_count: 3,
  top_tags: [
    { knowledge: '戴维南定理', count: 9 },
    { knowledge: '正弦稳态', count: 6 },
  ],
  ...patch,
})

describe('countdownLabel', () => {
  it('未设置考试日期时给出提示', () => {
    expect(countdownLabel(null)).toBe('未设置考试日期')
  })

  it('考试当天显示“就是今天”', () => {
    expect(countdownLabel(0)).toBe('就是今天')
  })

  it('考试在明天时单独措辞', () => {
    expect(countdownLabel(1)).toBe('明天考试')
  })

  it('剩余多天时显示还有 N 天', () => {
    expect(countdownLabel(2)).toBe('还有 2 天')
    expect(countdownLabel(30)).toBe('还有 30 天')
  })

  it('考试已过时用过去式措辞，不显示负号', () => {
    expect(countdownLabel(-1)).toBe('考试已过 1 天')
    expect(countdownLabel(-15)).toBe('考试已过 15 天')
    expect(countdownLabel(-15)).not.toContain('-')
  })
})

describe('countdownTone', () => {
  it('未设置 / 已过 / 当天分别取独立配色', () => {
    expect(countdownTone(null)).toBe('none')
    expect(countdownTone(-3)).toBe('over')
    expect(countdownTone(0)).toBe('today')
  })

  it('一周内为紧急，更远为常规', () => {
    expect(countdownTone(1)).toBe('soon')
    expect(countdownTone(7)).toBe('soon')
    expect(countdownTone(8)).toBe('far')
    expect(countdownTone(30)).toBe('far')
  })
})

describe('sprintBadge', () => {
  it('冲刺期使用后端阶段名', () => {
    expect(sprintBadge('sprint', '强化冲刺')).toEqual({ key: 'sprint', label: '强化冲刺' })
    expect(sprintBadge('sprint', '临考突击').key).toBe('sprint')
  })

  it('冲刺期缺少阶段名时回落到“冲刺中”', () => {
    expect(sprintBadge('sprint', '').label).toBe('冲刺中')
  })

  it('超过 30 天显示常规复习', () => {
    expect(sprintBadge('normal', '')).toEqual({ key: 'normal', label: '常规复习' })
  })

  it('考试已过有独立徽章', () => {
    expect(sprintBadge('over', '')).toEqual({ key: 'over', label: '考试已过' })
  })

  it('未知状态安全回落到未开启冲刺', () => {
    expect(sprintBadge('none', '')).toEqual({ key: 'none', label: '未开启冲刺' })
    expect(sprintBadge('', '').key).toBe('none')
  })
})

describe('formatSchedule', () => {
  it('空节奏返回空串', () => {
    expect(formatSchedule([])).toBe('')
  })

  it('单个间隔也能渲染', () => {
    expect(formatSchedule([1])).toBe('1 天')
  })

  it('按后端顺序拼接压缩节奏', () => {
    expect(formatSchedule([1, 2, 4, 7])).toBe('1 天 → 2 天 → 4 天 → 7 天')
  })

  it('不重排也不去重，原样呈现后端数据', () => {
    expect(formatSchedule([7, 1, 1])).toBe('7 天 → 1 天 → 1 天')
  })
})

describe('sprintCta', () => {
  it('无冲刺数据时不显示入口', () => {
    expect(sprintCta(null)).toEqual({ show: false, label: '', hint: '' })
  })

  it('未进入冲刺窗口时不显示入口', () => {
    expect(sprintCta(sprintPayload({ sprint: false, status: 'normal' })).show).toBe(false)
  })

  it('冲刺期显示带卡片数的入口文案', () => {
    const cta = sprintCta(sprintPayload())
    expect(cta.show).toBe(true)
    expect(cta.label).toBe('开始冲刺（12 张）')
  })

  it('没有可推进卡片时不显示入口', () => {
    expect(sprintCta(sprintPayload({ recommended: 0 })).show).toBe(false)
  })

  it('命中多个高频考点时提示等 N 个考点', () => {
    const cta = sprintCta(sprintPayload())
    expect(cta.hint).toBe('优先复习「戴维南定理」等 2 个高频考点')
  })

  it('只有一个高频考点时不提“等 N 个”', () => {
    const cta = sprintCta(sprintPayload({ top_tags: [{ knowledge: '戴维南定理', count: 9 }] }))
    expect(cta.hint).toBe('优先复习「戴维南定理」')
  })

  it('没有考点标签时入口仍可用，只是不带提示', () => {
    const cta = sprintCta(sprintPayload({ top_tags: [] }))
    expect(cta.show).toBe(true)
    expect(cta.hint).toBe('')
  })
})

describe('filterQueueByTag', () => {
  const queue = [
    { problem_id: 1, knowledge: ['戴维南定理', '节点电压法'] },
    { problem_id: 2, knowledge: ['正弦稳态'] },
    { problem_id: 3, knowledge: ['戴维南定理'] },
  ]

  it('未选择标签时返回原队列', () => {
    expect(filterQueueByTag(queue, null)).toBe(queue)
  })

  it('空白标签视为未筛选', () => {
    expect(filterQueueByTag(queue, '   ')).toBe(queue)
  })

  it('按标签命中过滤并保留原顺序', () => {
    expect(filterQueueByTag(queue, '戴维南定理').map((q) => q.problem_id)).toEqual([1, 3])
  })

  it('忽略标签首尾空格', () => {
    expect(filterQueueByTag(queue, ' 正弦稳态 ').map((q) => q.problem_id)).toEqual([2])
  })

  it('没有命中时返回空数组', () => {
    expect(filterQueueByTag(queue, '不存在')).toEqual([])
  })

  it('不修改原队列', () => {
    filterQueueByTag(queue, '正弦稳态')
    expect(queue).toHaveLength(3)
  })
})

describe('toDateInputValue', () => {
  it('未设置日期返回空串', () => {
    expect(toDateInputValue(null)).toBe('')
    expect(toDateInputValue('')).toBe('')
  })

  it('日期字符串原样返回', () => {
    expect(toDateInputValue('2026-11-20')).toBe('2026-11-20')
  })

  it('后端返回 ISO 日期时间时截取日期部分', () => {
    expect(toDateInputValue('2026-11-20T00:00:00')).toBe('2026-11-20')
    expect(toDateInputValue('2026-11-20 08:30:00')).toBe('2026-11-20')
  })

  it('无法识别的字符串返回空串，避免污染输入框', () => {
    expect(toDateInputValue('2026/11/20')).toBe('')
    expect(toDateInputValue('not-a-date')).toBe('')
  })
})
