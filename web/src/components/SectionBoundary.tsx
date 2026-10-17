import { Component } from 'react'
import type { ReactNode } from 'react'

interface Props {
  section: string
  children: ReactNode
}

interface State {
  detail: string
}

/**
 * 分区级错误边界：某一块渲染抛错（脏数据、懒加载失败）时只塌这一个分区。
 *
 * App 用它包住当前分区并按「分区 + 课程」加 key，所以切分区或换课程会自然重挂载；
 * 「重试」只清自己的状态，用来处理偶发的、重试一次就好的错。
 */
export default class SectionBoundary extends Component<Props, State> {
  state: State = { detail: '' }

  static getDerivedStateFromError(error: unknown): State {
    return { detail: error instanceof Error ? error.message : String(error) }
  }

  render() {
    if (!this.state.detail) return this.props.children
    return (
      <div className="section-error" role="alert">
        <p className="section-error-title">「{this.props.section}」这个分区出错了</p>
        <p className="section-error-hint">
          其他分区照常能用，课程与做题记录都没有被动。下面这行错误信息可以先留着，重试不行再反馈。
        </p>
        <pre className="section-error-detail mono">{this.state.detail}</pre>
        <button className="mini" onClick={() => this.setState({ detail: '' })}>
          重试这个分区
        </button>
      </div>
    )
  }
}
