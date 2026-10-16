import { describe, expect, it, vi } from 'vitest'
import type { Command } from './quickSearch'
import {
  CMDK_PLACEHOLDER,
  filterCommands,
  groupCommands,
  moveSelection,
  scoreCommand,
  shortcutHints,
  subsequenceMatch,
} from './quickSearch'

function cmd(id: string, label: string, group = '前往', keywords?: string[]): Command {
  return { id, label, group, keywords, run: vi.fn() }
}

describe('subsequenceMatch', () => {
  it('空查询匹配一切并返回空位置', () => {
    expect(subsequenceMatch('复习计划', '')).toEqual([])
  })

  it('按顺序匹配并返回位置', () => {
    expect(subsequenceMatch('复习计划', '复习')).toEqual([0, 1])
    expect(subsequenceMatch('复习计划', '复计')).toEqual([0, 2])
  })

  it('忽略空格', () => {
    expect(subsequenceMatch('知识图谱', '知 图')).toEqual([0, 2])
  })

  it('顺序不对则不匹配', () => {
    expect(subsequenceMatch('复习计划', '计复')).toBeNull()
    expect(subsequenceMatch('abc', 'ba')).toBeNull()
  })

  it('大小写不敏感', () => {
    expect(subsequenceMatch('Review Plan', 'rp')).toEqual([0, 7])
  })
})

describe('scoreCommand', () => {
  it('空查询得 0 分（都保留）', () => {
    expect(scoreCommand(cmd('a', '复习计划'), '   ')).toBe(0)
  })

  it('前缀命中比中段命中得分高', () => {
    const prefix = scoreCommand(cmd('a', '复习计划'), '复')
    const middle = scoreCommand(cmd('b', '计划复习'), '复')
    expect(prefix).toBeGreaterThan(middle as number)
  })

  it('连续命中比分散命中得分高', () => {
    const consecutive = scoreCommand(cmd('a', '复习计划'), '复习')
    const scattered = scoreCommand(cmd('b', '复某某习'), '复习')
    expect(consecutive).toBeGreaterThan(scattered as number)
  })

  it('标题命中优于关键词命中', () => {
    const byLabel = scoreCommand(cmd('a', '复习计划'), '复习')
    const byKeyword = scoreCommand(cmd('b', '考试冲刺', '操作', ['复习']), '复习')
    expect(byLabel).toBeGreaterThan(byKeyword as number)
  })

  it('关键词可命中', () => {
    const score = scoreCommand(cmd('a', '考试冲刺', '操作', ['fuxi', '复习']), 'fuxi')
    expect(score).not.toBeNull()
  })

  it('完全不匹配返回 null', () => {
    expect(scoreCommand(cmd('a', '复习计划'), 'zzzz')).toBeNull()
  })
})

describe('filterCommands', () => {
  const commands = [
    cmd('tab:library', '课程资料'),
    cmd('tab:review', '复习计划'),
    cmd('tab:graph', '知识图谱'),
    cmd('action:theme', '切换到深色模式', '操作', ['theme', '深色']),
    cmd('course:1', '切换到课程：电子电路与系统基础', '课程', ['电路']),
  ]

  it('空查询保持原顺序', () => {
    expect(filterCommands(commands, '').map((c) => c.id)).toEqual(commands.map((c) => c.id))
  })

  it('按中文匹配', () => {
    const ids = filterCommands(commands, '复习').map((c) => c.id)
    expect(ids[0]).toBe('tab:review')
  })

  it('按关键词/拼音匹配', () => {
    expect(filterCommands(commands, 'theme').map((c) => c.id)).toContain('action:theme')
    expect(filterCommands(commands, '电路').map((c) => c.id)).toContain('course:1')
  })

  it('高相关度排在最前', () => {
    expect(filterCommands(commands, '图谱')[0].id).toBe('tab:graph')
  })

  it('无匹配返回空数组', () => {
    expect(filterCommands(commands, 'qqqq')).toEqual([])
  })

  it('返回新数组，不改动入参', () => {
    const out = filterCommands(commands, '')
    expect(out).not.toBe(commands)
    expect(commands.length).toBe(5)
  })
})

describe('groupCommands', () => {
  it('按首次出现顺序分组并保持组内顺序', () => {
    const groups = groupCommands([
      cmd('a', 'A', '前往'),
      cmd('b', 'B', '操作'),
      cmd('c', 'C', '前往'),
    ])
    expect(groups.map((g) => g.group)).toEqual(['前往', '操作'])
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'c'])
    expect(groups[1].items.map((i) => i.id)).toEqual(['b'])
  })

  it('空输入返回空数组', () => {
    expect(groupCommands([])).toEqual([])
  })
})

describe('moveSelection', () => {
  it('向下移动', () => {
    expect(moveSelection(0, 1, 3)).toBe(1)
  })

  it('到底环绕回开头', () => {
    expect(moveSelection(2, 1, 3)).toBe(0)
  })

  it('从开头向上环绕到末尾', () => {
    expect(moveSelection(0, -1, 3)).toBe(2)
  })

  it('列表为空时恒为 0', () => {
    expect(moveSelection(0, 1, 0)).toBe(0)
    expect(moveSelection(5, -1, 0)).toBe(0)
  })

  it('从 -1 起向下先到 0', () => {
    expect(moveSelection(-1, 1, 3)).toBe(0)
  })

  it('大跨度取模正确', () => {
    expect(moveSelection(0, 7, 3)).toBe(1)
    expect(moveSelection(1, -7, 3)).toBe(0)
  })
})

describe('shortcutHints', () => {
  it('Mac 用 ⌘，其余用 Ctrl', () => {
    expect(shortcutHints(true)[3].keys).toBe('⌘+K')
    expect(shortcutHints(false)[3].keys).toBe('Ctrl+K')
  })

  it('始终给出四条提示', () => {
    expect(shortcutHints(true)).toHaveLength(4)
  })
})

describe('CMDK_PLACEHOLDER', () => {
  it('非空且为中文提示', () => {
    expect(CMDK_PLACEHOLDER.length).toBeGreaterThan(0)
    expect(CMDK_PLACEHOLDER).toContain('搜索')
  })
})
