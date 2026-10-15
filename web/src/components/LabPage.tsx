import { useMemo, useState } from 'react'
import { LABS, formatSi, type LabParam } from '../labs/labs'
import CircuitBuilder from './CircuitBuilder'
import Plot from './Plot'
import Schematic from './Schematic'

const FREE_ID = '__free'
const NO_PARAMS: Record<string, number> = {}

export default function LabPage() {
  const [labId, setLabId] = useState(LABS[0].id)
  const [allParams, setAllParams] = useState<Record<string, Record<string, number>>>(() =>
    Object.fromEntries(
      LABS.map((l) => [l.id, Object.fromEntries(l.params.map((p) => [p.key, p.default]))]),
    ),
  )
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
        <div className="section-title lab-sep">预置实验</div>
        {LABS.map((l) => (
          <button
            key={l.id}
            className={l.id === labId ? 'lab-item active' : 'lab-item'}
            onClick={() => setLabId(l.id)}
          >
            <span className="lab-title">{l.title}</span>
            <span className="lab-chapter">{l.chapter}</span>
          </button>
        ))}
        <p className="lab-tip">
          数值由自研 MNA 仿真内核计算（直流 / 瞬态 / 交流），与手算及教材结论一致，见
          web/src/circuit 单元测试。
        </p>
      </aside>

      <section className="lab-main">
        {lab ? (
          <>
            <header className="lab-head">
              <h2>{lab.title}</h2>
              <p>{lab.description}</p>
            </header>

            <div className="lab-grid">
              <div className="lab-col">
                <div className="schematic-card">
                  <Schematic labId={lab.id} />
                </div>
                <div className="sliders">
                  {lab.params.map((p) => (
                    <Slider
                      key={p.key}
                      param={p}
                      value={params[p.key]}
                      onChange={(v) => setParam(p.key, v)}
                    />
                  ))}
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
                    <div className="readouts">
                      {run.result.readouts.map((r) => (
                        <div key={r.label} className="readout">
                          <span className="readout-label">{r.label}</span>
                          <span className="readout-value">{r.value}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <>
            <header className="lab-head">
              <h2>自由搭建</h2>
              <p>
                从上方元件面板中选电阻、电容、电感、电压源、电流源、理想运放与接地，在网格画布上点击放置；
                拖动元件可移动，从端子拉出导线可串联成电路。右侧同款 MNA 内核实时给出直流工作点、瞬态曲线与频响扫频；
                内容会自动保存在本地，随时可继续搭建。
              </p>
            </header>
            <CircuitBuilder />
          </>
        )}
      </section>
    </div>
  )
}

function Slider({
  param,
  value,
  onChange,
}: {
  param: LabParam
  value: number
  onChange: (v: number) => void
}) {
  const toSlider = (v: number) => (param.log ? Math.log10(v) : v)
  const fromSlider = (v: number) => (param.log ? Math.pow(10, v) : v)
  const step = param.log ? (toSlider(param.max) - toSlider(param.min)) / 240 : param.step
  return (
    <div className="slider-row">
      <div className="slider-head">
        <span>{param.label}</span>
        <span className="slider-value">{formatSi(value, param.unit)}</span>
      </div>
      <input
        type="range"
        min={toSlider(param.min)}
        max={toSlider(param.max)}
        step={step}
        value={toSlider(value)}
        onChange={(e) => onChange(fromSlider(Number(e.target.value)))}
      />
    </div>
  )
}
