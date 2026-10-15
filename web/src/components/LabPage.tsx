import { useMemo, useState } from 'react'
import { LABS, formatSi, type LabParam } from '../labs/labs'
import Plot from './Plot'
import Schematic from './Schematic'

export default function LabPage() {
  const [labId, setLabId] = useState(LABS[0].id)
  const [allParams, setAllParams] = useState<Record<string, Record<string, number>>>(() =>
    Object.fromEntries(
      LABS.map((l) => [l.id, Object.fromEntries(l.params.map((p) => [p.key, p.default]))]),
    ),
  )
  const lab = LABS.find((l) => l.id === labId) ?? LABS[0]
  const params = allParams[lab.id]

  const run = useMemo(() => {
    try {
      return { result: lab.run(params), error: '' }
    } catch (e) {
      return { result: null, error: (e as Error).message }
    }
  }, [lab, params])

  const setParam = (key: string, value: number) =>
    setAllParams((all) => ({ ...all, [lab.id]: { ...all[lab.id], [key]: value } }))

  return (
    <div className="lab-page">
      <aside className="lab-list">
        <div className="section-title">预置实验</div>
        {LABS.map((l) => (
          <button
            key={l.id}
            className={l.id === lab.id ? 'lab-item active' : 'lab-item'}
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
