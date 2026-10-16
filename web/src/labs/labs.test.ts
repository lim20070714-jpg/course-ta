import { describe, expect, it } from 'vitest'
import { LABS } from './labs'

describe('参数实验场', () => {
  for (const lab of LABS) {
    it(`${lab.title}：默认参数可运行且数值全部有限`, () => {
      const params = Object.fromEntries(lab.params.map((p) => [p.key, p.default] as const))
      const run = lab.run(params)
      expect(run.series.length).toBeGreaterThan(0)
      expect(run.readouts.length).toBeGreaterThan(0)
      for (const s of run.series) {
        expect(s.x.length).toBe(s.y.length)
        expect(s.x.length).toBeGreaterThan(0)
        for (const v of s.y) expect(Number.isFinite(v)).toBe(true)
      }
    })

    it(`${lab.title}：参数取极值时不报错`, () => {
      for (const p of lab.params) {
        const params = Object.fromEntries(
          lab.params.map((q) => [q.key, q.default] as const),
        )
        params[p.key] = p.min
        expect(() => lab.run(params)).not.toThrow()
        params[p.key] = p.max
        expect(() => lab.run(params)).not.toThrow()
      }
    })
  }

  it('分压器：12V / 1kΩ / 2kΩ → 工作点 8V', () => {
    const lab = LABS.find((l) => l.id === 'divider')
    expect(lab).toBeDefined()
    const run = lab!.run({ vin: 12, r1: 1000, r2: 2000 })
    const marker = run.series.find((s) => s.marker)
    expect(marker).toBeDefined()
    expect(marker!.y[0]).toBeCloseTo(8, 6)
  })

  it('RC：默认 τ=1ms，τ 时刻 v_C≈3.16V（63.2% 充电）', () => {
    const lab = LABS.find((l) => l.id === 'rc')!
    const run = lab.run({ v: 5, r: 1000, c: 1e-6 })
    const vc = run.series[0].y
    // x 轴为 ms，τ=1ms 对应索引 400（5τ 共 2000 步）
    expect(vc[400]).toBeGreaterThan(3.1)
    expect(vc[400]).toBeLessThan(3.22)
    expect(vc[vc.length - 1]).toBeCloseTo(5, 1)
  })

  it('RC 低通：f_c 处约 -3dB，100·f_c 处约 -40dB', () => {
    const lab = LABS.find((l) => l.id === 'rc-lowpass')!
    const run = lab.run({ r: 1000, c: 1e-6 })
    const magDb = run.series[0].y
    expect(magDb[60]).toBeCloseTo(-3.0103, 2)
    expect(magDb[120]).toBeCloseTo(-40, 0)
  })

  it('RLC：谐振峰约 Q=10 → 20dB', () => {
    const lab = LABS.find((l) => l.id === 'rlc')!
    const run = lab.run({ r: 10, l: 0.01, c: 1e-6 })
    const peak = run.series.find((s) => s.marker)!
    expect(peak.y[0]).toBeCloseTo(20, 0)
  })

  it('RLC 阶跃：ζ=0.05 欠阻尼，峰值≈1.85 且带包络线，稳态回 1', () => {
    const lab = LABS.find((l) => l.id === 'rlc-step')!
    const run = lab.run({ r: 10, l: 0.01, c: 1e-6 })
    const vc = run.series[0].y
    expect(Math.max(...vc)).toBeGreaterThan(1.7)
    expect(Math.max(...vc)).toBeLessThan(1.95)
    expect(vc[vc.length - 1]).toBeCloseTo(1, 1)
    expect(run.series.some((s) => s.label === '包络 +')).toBe(true)
  })

  it('RLC 阶跃：R=1kΩ 过阻尼，单调上升无超调', () => {
    const lab = LABS.find((l) => l.id === 'rlc-step')!
    const run = lab.run({ r: 1000, l: 0.01, c: 1e-6 })
    const vc = run.series[0].y
    expect(vc[vc.length - 1]).toBeCloseTo(1, 1)
    for (let i = 1; i < vc.length; i++) {
      expect(vc[i]).toBeGreaterThanOrEqual(vc[i - 1] - 1e-9)
    }
  })

  it('RC 方波：τ≪T 跟随方波（0↔5V），τ≫T 纹波极小（积分）', () => {
    const lab = LABS.find((l) => l.id === 'square-rc')!
    const diff = lab.run({ r: 1e3, c: 1e-8, f: 100 })
    const vcd = diff.series[0].y
    expect(Math.max(...vcd)).toBeGreaterThan(4.9)
    expect(Math.min(...vcd)).toBeLessThan(0.1)
    const integ = lab.run({ r: 1e3, c: 1e-5, f: 1e4 })
    const vci = integ.series[0].y
    expect(Math.max(...vci) - Math.min(...vci)).toBeLessThan(0.15)
  })

  it('Sallen-Key：默认 C₁=2C₂ 为 Butterworth 无峰，100·f₀ 处 −80dB（二阶 ×2 个十倍频程）', () => {
    const lab = LABS.find((l) => l.id === 'sallen-key')!
    const run = lab.run({ r: 1e4, c1: 2e-7, c2: 1e-7 })
    const db = run.series[0].y
    expect(Math.max(...db)).toBeLessThan(0.5)
    expect(db[240]).toBeCloseTo(-80, 0)
  })

  it('Sallen-Key：C₁=100·C₂ 时 Q=5，峰值增益 13–15dB', () => {
    const lab = LABS.find((l) => l.id === 'sallen-key')!
    const run = lab.run({ r: 1e4, c1: 1e-6, c2: 1e-8 })
    const db = run.series[0].y
    const peak = Math.max(...db)
    expect(peak).toBeGreaterThan(13)
    expect(peak).toBeLessThan(15)
  })
})
