import { useMemo, useState } from 'react'
import { LABS, formatSi, type LabParam } from '../labs/labs'
import CircuitBuilder from './CircuitBuilder'
import Plot from './Plot'
import Schematic from './Schematic'

const FREE_ID = '__free'
const NO_PARAMS: Record<string, number> = {}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

export default function LabPage() {
  const [labId, setLabId] = useState(LABS[0].id)
  const [allParams, setAllParams] = useState<Record<string, Record<string, number>>>(() =>
    Object.fromEntries(
      LABS.map((l) => [l.id, Object.fromEntries(l.params.map((p) => [p.key, p.default]))]),
    ),
  )
  const [flash, setFlash] = useState('')
  const lab = LABS.find((l) => l.id === labId)
  const params = lab ? allParams[lab.id] : NO_PARAMS

  const run = useMemo(() => {
    if (!lab) return { result: null, error: '' }
    try {
      return { result: lab.run(params), error: '' }
    } catch (e) {
      return { result: null, error: (e as Error).message }
    }
  }, [lab, params])

  const setParam = (key: string, value: number) =>
    setAllParams((all) => ({ ...all, [labId]: { ...all[labId], [key]: value } }))

  const resetLab = () => {
    if (!lab) return
    setAllParams((all) => ({
      ...all,
      [lab.id]: Object.fromEntries(lab.params.map((p) => [p.key, p.default])),
    }))
    setFlash('已恢复默认参数')
    window.setTimeout(() => setFlash(''), 1500)
  }

  return (
    <div className="lab-page">
      <aside className="lab-list">
        <div className="section-title">自由搭建</div>
        <button
          className={labId === FREE_ID ? 'lab-item active' : 'lab-item'}
          onClick={() => setLabId(FREE_ID)}
        >
          <span className="lab-title">电路画板</span>
          <span className="lab-chapter">任意组合元件 · 自建电路</span>
        </button>
        <div className="section-title lab-sep">参数实验场</div>
        {LABS.map((l, i) => (
          <button
            key={l.id}
            className={l.id === labId ? 'lab-item active stagger-item' : 'lab-item stagger-item'}
            style={{ '--i': i } as React.CSSProperties}
            aria-current={l.id === labId}
            onClick={() => setLabId(l.id)}
          >
            <span className="lab-title">{l.title}</span>
            <span className="lab-chapter">{l.chapter}</span>
          </button>
        ))}
        <p className="lab-tip">
          8 个参数实验 + 自由画板共用同一自研 MNA 内核，曲线随滑块实时重算（直流 / 瞬态 / 交流扫频），
          与手算及教材结论一致，见 web/src/circuit 单元测试。
        </p>
      </aside>

      <section className="lab-main">
        {lab ? (
          <div className="lab-fade" key={lab.id}>
            <header className="lab-head">
              <div className="lab-head-row">
                <h2>{lab.title}</h2>
                <span className="lab-badge">{lab.chapter}</span>
              </div>
              <p>{lab.description}</p>
            </header>

            <div className="lab-grid">
              <div className="lab-col">
                <div className="schematic-card lab-schematic">
                  <Schematic labId={lab.id} params={params} />
                </div>
                <div className="sliders">
                  <div className="lab-panel-head">
                    <span className="lab-panel-title">参数</span>
                    <button type="button" className="mini ghost" onClick={resetLab}>
                      恢复默认
                    </button>
                  </div>
                  {lab.params.map((p, i) => (
                    <Slider
                      key={p.key}
                      index={i}
                      param={p}
                      value={params[p.key]}
                      onChange={(v) => setParam(p.key, v)}
                    />
                  ))}
                  <p className="lab-kbd-tip">
                    滑块聚焦后：←/→ 微调 · Shift 加速 ×10 · Alt 精调（Shift+Alt 反向）
                  </p>
                  <p className="lab-flash" role="status">
                    {flash}
                  </p>
                </div>
              </div>

              <div className="lab-col">
                {run.error !== '' ? (
                  <div className="lab-error">仿真失败：{run.error}</div>
                ) : run.result !== null ? (
                  <>
                    <Plot
                      series={run.result.series}
                      xLabel={run.result.xLabel}
                      yLabel={run.result.yLabel}
                      xLog={run.result.xLog}
                    />
                    <section className="lab-readouts">
                      <div className="lab-panel-head">
                        <span className="lab-panel-title">读数</span>
                        <span className="lab-sub">随参数实时重算 · 刻度与曲线可平滑跟随</span>
                      </div>
                      <div className="readouts">
                        {run.result.readouts.map((r, i) => (
                          <div
                            key={r.label}
                            className="readout stagger-item"
                            style={{ '--i': i } as React.CSSProperties}
                          >
                            <span className="readout-label">{r.label}</span>
                            <span className="readout-value">{r.value}</span>
                          </div>
                        ))}
                      </div>
                    </section>
                  </>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          <div className="lab-fade" key={FREE_ID}>
            <header className="lab-head">
              <div className="lab-head-row">
                <h2>自由搭建</h2>
                <span className="lab-badge">画板模式</span>
              </div>
              <p>
                从上方元件面板中选电阻、电容、电感、电压源、电流源、理想运放与接地，在网格画布上点击放置；
                拖动元件可移动，从端子拉出导线可串联成电路。右侧同款 MNA 内核实时给出直流工作点、瞬态曲线与频响扫频；
                内容会自动保存在本地，随时可继续搭建。
              </p>
            </header>
            <CircuitBuilder />
          </div>
        )}
      </section>
    </div>
  )
}

function Slider({
  param,
  value,
  index,
  onChange,
}: {
  param: LabParam
  value: number
  index: number
  onChange: (v: number) => void
}) {
  const toSlider = (v: number) => (param.log ? Math.log10(v) : v)
  const fromSlider = (v: number) => (param.log ? Math.pow(10, v) : v)
  const lo = toSlider(param.min)
  const hi = toSlider(param.max)
  const step = param.log ? (hi - lo) / 240 : param.step
  const sliderValue = toSlider(value)
  const fill = hi > lo ? clamp(((sliderValue - lo) / (hi - lo)) * 100, 0, 100) : 0

  /** 键盘微调：方向键 / PageUp·PageDown，Shift 加速、Alt 精调 */
  const nudge = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const factor = e.shiftKey && e.altKey ? 0.2 : e.shiftKey ? 10 : e.altKey ? 0.2 : 1
    let delta = 0
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') delta = -step * factor
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') delta = step * factor
    else if (e.key === 'PageDown') delta = -step * 10
    else if (e.key === 'PageUp') delta = step * 10
    else return
    e.preventDefault()
    const raw = clamp(sliderValue + delta, lo, hi)
    const snapped = param.log ? raw : Math.round(raw / param.step) * param.step
    onChange(fromSlider(clamp(snapped, lo, hi)))
  }

  return (
    <div className="slider-row stagger-item" style={{ '--i': index } as React.CSSProperties}>
      <div className="slider-head">
        <span className="slider-label">{param.label}</span>
        <span className="slider-value">{formatSi(value, param.unit)}</span>
      </div>
      <input
        type="range"
        aria-label={param.label}
        aria-valuetext={formatSi(value, param.unit)}
        min={lo}
        max={hi}
        step={step}
        value={sliderValue}
        style={{ '--lab-fill': `${fill}%` } as React.CSSProperties}
        onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
        onKeyDown={nudge}
        onDoubleClick={() => onChange(param.default)}
        title="双击恢复默认值"
      />
      <div className="slider-foot">
        <span className="slider-min">{formatSi(param.min, param.unit)}</span>
        <span className="slider-scale">{param.log ? '对数刻度' : '线性刻度'}</span>
        <span className="slider-max">{formatSi(param.max, param.unit)}</span>
      </div>
    </div>
  )
}
