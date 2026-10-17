import { describe, expect, it } from 'vitest'

import SectionBoundary from './SectionBoundary'

// 只有这条纯函数可以脱离 DOM 测；渲染兜底卡片的形状留给浏览器真机验证
describe('SectionBoundary 的错误提取', () => {
  const derive = SectionBoundary.getDerivedStateFromError

  it('把 Error 的 message 收成能给人看的一行', () => {
    expect(derive(new Error('Cannot read properties of undefined'))).toEqual({
      detail: 'Cannot read properties of undefined',
    })
  })

  it('抛出来的不是 Error 也要有字可显示，不能留个空壳', () => {
    expect(derive('字符串炸弹')).toEqual({ detail: '字符串炸弹' })
    expect(derive(undefined)).toEqual({ detail: 'undefined' })
  })

  it('正常渲染时状态为空，边界不干预', () => {
    expect(new SectionBoundary({ section: '计算台', children: null }).state).toEqual({ detail: '' })
  })
})
