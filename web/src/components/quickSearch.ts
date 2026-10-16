/**
 * 命令面板（⌘/Ctrl + K）的纯逻辑：模糊匹配、排序、键盘导航。
 *
 * 抽出来单独测的原因：面板本身的正确性几乎全在"匹配到哪些、选中第几个、
 * 回车执行哪一个"这几件事上，和 DOM 无关。
 */

export interface Command {
  id: string
  /** 主标题，例如「复习计划」 */
  label: string
  /** 分组标题，例如「前往」「课程」「操作」 */
  group: string
  /** 右侧灰色提示，例如快捷键 Cmd+K */
  hint?: string
  /** 参与匹配的额外关键词（拼音、别名、英文） */
  keywords?: string[]
  /** 执行动作 */
  run: () => void
}

/** 子序列匹配：query 的字符需按顺序出现在 text 中；返回匹配位置（用于高亮与打分），不匹配返回 null。 */
export function subsequenceMatch(text: string, query: string): number[] | null {
  if (!query) return []
  const hay = text.toLowerCase()
  const needle = query.toLowerCase()
  const positions: number[] = []
  let cursor = 0
  for (const ch of needle) {
    if (ch === ' ') continue
    const found = hay.indexOf(ch, cursor)
    if (found < 0) return null
    positions.push(found)
    cursor = found + 1
  }
  return positions
}

/**
 * 打分：越高越靠前。
 * - 连续命中、前缀命中、标题命中都要加分；
 * - 关键词命中算但不强于标题命中；
 * - 命中位置越靠前越好。
 */
export function scoreCommand(cmd: Command, query: string): number | null {
  const q = query.trim()
  if (!q) return 0

  const labelPositions = subsequenceMatch(cmd.label, q)
  let best: number | null = null
  if (labelPositions) {
    let score = 100 - labelPositions[0] * 2
    if (labelPositions[0] === 0) score += 40
    // 连续片段加成
    let run = 1
    for (let i = 1; i < labelPositions.length; i += 1) {
      if (labelPositions[i] === labelPositions[i - 1] + 1) run += 1
      else run = 1
      score += run * 2
    }
    best = score
  }

  for (const keyword of cmd.keywords ?? []) {
    const kwPositions = subsequenceMatch(keyword, q)
    if (kwPositions) {
      let score = 60 - kwPositions[0]
      if (kwPositions[0] === 0) score += 20
      best = best === null ? score : Math.max(best, score - 15) // 关键词略低于标题
    }
  }
  return best
}

/** 过滤 + 排序；空查询返回原顺序（给"刚打开面板"用）。 */
export function filterCommands(commands: Command[], query: string): Command[] {
  const q = query.trim()
  if (!q) return [...commands]
  const scored: { cmd: Command; score: number }[] = []
  for (const cmd of commands) {
    const score = scoreCommand(cmd, q)
    if (score !== null) scored.push({ cmd, score })
  }
  scored.sort((a, b) => b.score - a.score || a.cmd.label.localeCompare(b.cmd.label, 'zh'))
  return scored.map((row) => row.cmd)
}

/** 把候选按 group 归组，保持组内顺序；组顺序按首次出现顺序。 */
export function groupCommands(commands: Command[]): { group: string; items: Command[] }[] {
  const order: string[] = []
  const buckets = new Map<string, Command[]>()
  for (const cmd of commands) {
    if (!buckets.has(cmd.group)) {
      buckets.set(cmd.group, [])
      order.push(cmd.group)
    }
    buckets.get(cmd.group)!.push(cmd)
  }
  return order.map((group) => ({ group, items: buckets.get(group)! }))
}

/**
 * 键盘导航：在长度为 size 的列表里移动选中项。
 * 环绕（到底回到开头），size 为 0 时恒返回 0。
 */
export function moveSelection(current: number, delta: number, size: number): number {
  if (size <= 0) return 0
  const base = current < 0 ? (delta > 0 ? -1 : 0) : current
  return (((base + delta) % size) + size) % size
}

export const CMDK_PLACEHOLDER = '搜索功能、课程、操作…'

/** 面板底部快捷键提示（按平台给出 ⌘ 或 Ctrl）。 */
export function shortcutHints(isMac: boolean): { keys: string; label: string }[] {
  const mod = isMac ? '⌘' : 'Ctrl'
  return [
    { keys: '↑↓', label: '选择' },
    { keys: '↵', label: '执行' },
    { keys: 'Esc', label: '关闭' },
    { keys: `${mod}+K`, label: '打开/关闭' },
  ]
}
