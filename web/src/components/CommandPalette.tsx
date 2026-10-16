import { useEffect, useMemo, useRef, useState } from 'react'
import type { Command } from './quickSearch'
import { CMDK_PLACEHOLDER, filterCommands, groupCommands, moveSelection, shortcutHints } from './quickSearch'

/**
 * 命令面板：⌘/Ctrl + K 打开，模糊搜索所有功能、课程与操作。
 *
 * 由父组件在打开时才挂载（`{open && <CommandPalette … />}`），因此查询词、
 * 选中项都是"挂载即初始化"，不需要任何重置用的 effect —— 少一轮渲染，
 * 打开动画也更干净。匹配与导航逻辑全在 quickSearch.ts 里，这里只管渲染与事件。
 */
export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[]
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)

  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
  const results = useMemo(() => filterCommands(commands, query), [commands, query])
  const groups = useMemo(() => groupCommands(results), [results])
  // 结果变少时把选中项夹回范围内：渲染期直接推导，不用 effect 再触发一轮渲染
  const active = results.length === 0 ? -1 : Math.min(cursor, results.length - 1)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
        return
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setCursor(moveSelection(active, delta, results.length))
        return
      }
      if (e.key === 'Home') {
        e.preventDefault()
        setCursor(0)
        return
      }
      if (e.key === 'End') {
        e.preventDefault()
        setCursor(Math.max(0, results.length - 1))
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const target = results[active]
        if (target) {
          onClose()
          target.run()
        }
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [results, active, onClose])

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-cmd-index="${active}"]`)?.scrollIntoView({
      block: 'nearest',
    })
  }, [active])

  const hints = shortcutHints(isMac)
  // 扁平序号在渲染前算好：渲染期不得改变量（React Compiler 的不可变约定）
  const indexOf = useMemo(() => {
    const map = new Map<string, number>()
    let i = 0
    for (const group of groups) {
      for (const cmd of group.items) {
        map.set(cmd.id, i)
        i += 1
      }
    }
    return map
  }, [groups])

  return (
    <div className="cmdk-backdrop" onMouseDown={onClose}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="cmdk-input"
          value={query}
          placeholder={CMDK_PLACEHOLDER}
          onChange={(e) => {
            setQuery(e.target.value)
            setCursor(0)
          }}
          aria-label="搜索命令"
        />
        {results.length === 0 ? (
          <p className="cmdk-empty">没有匹配的功能，换个词试试</p>
        ) : (
          <ul className="cmdk-list" ref={listRef}>
            {groups.map((group) => (
              <li key={group.group}>
                <div className="cmdk-group">{group.group}</div>
                {group.items.map((cmd) => {
                  const index = indexOf.get(cmd.id) ?? 0
                  return (
                    <button
                      key={cmd.id}
                      type="button"
                      className="cmdk-item"
                      data-cmd-index={index}
                      aria-selected={index === active}
                      onMouseEnter={() => setCursor(index)}
                      onClick={() => {
                        onClose()
                        cmd.run()
                      }}
                    >
                      <span>{cmd.label}</span>
                      {cmd.hint && <span className="cmdk-item-hint">{cmd.hint}</span>}
                    </button>
                  )
                })}
              </li>
            ))}
          </ul>
        )}
        <div className="cmdk-foot">
          {hints.map((h) => (
            <span key={h.keys}>
              <span className="cmdk-kbd">{h.keys}</span> {h.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
