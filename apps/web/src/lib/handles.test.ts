import { describe, expect, it } from 'vitest'
import { featureHandles, passiveValue, pullCurve, rdsCurve, xAt } from './handles'

const mlcc = { Cnom: 10e-6, vhalf: 6, esr: 0.01, esl: 1e-9 }
const always = () => true

describe('feature handles', () => {
  it('put the self-resonance where ESL and ESR say and invert it exactly', () => {
    const srf = featureHandles('mlcc', mlcc, {}, always).find((h) => h.label === 'SRF')
    expect(srf?.x).toBeCloseTo(1 / (2 * Math.PI * Math.sqrt(1e-14)), -2)
    const moved = srf?.apply((srf?.x ?? 0) * 2, 0.02) ?? {}
    expect(moved.esl).toBeCloseTo(0.25e-9, 15) // twice the resonance: a quarter of ESL
    expect(moved.esr).toBeCloseTo(0.02, 6)
  })
  it('set V½ and C from the half-capacitance point of an MLCC', () => {
    const h = featureHandles('mlcc', mlcc, {}, always).find((x) => x.label === 'V½')
    expect(h?.apply(3, 4e-6)).toEqual({ vhalf: 3, Cnom: 8e-6 })
  })
  it('give a diode IS, N and RS from its forward curve', () => {
    const v = { is: 2.5e-9, n: 1.75, rs: 0.5 }
    // The exact curve: V(I) for currents a few per decade, from 1 pA to 1 A.
    const amps = Array.from({ length: 121 }, (_x, i) => 10 ** (-12 + i / 10))
    const volts = amps.map((i) => v.n * 0.02585 * Math.log(i / v.is + 1) + i * v.rs)
    const handles = featureHandles('diode', v, { 'I-V forward': [{ x: volts, y: amps }] }, always)
    expect(handles.map((h) => h.label)).toEqual(expect.arrayContaining(['IS', 'N', 'RS']))
    const rs = handles.find((h) => h.label === 'RS')
    expect(rs?.params).toEqual(['rs'])
    const more = rs?.apply((rs?.x ?? 0) + 0.05, rs?.y ?? 0).rs ?? 0
    expect(more).toBeGreaterThan(v.rs) // the same current further right: more resistance
  })
})

describe('pulling a curve', () => {
  it('moves the unlocked values so the curve goes through the point', () => {
    const f = 1e6
    const before = passiveValue('capacitor', mlcc, '|Z|(f)', f) ?? 0
    const pulled = pullCurve('capacitor', mlcc, '|Z|(f)', [f, before * 3], ['esr', 'esl'], [])
    const after = passiveValue('capacitor', { ...mlcc, ...pulled }, '|Z|(f)', f) ?? 0
    expect(after / (before * 3)).toBeCloseTo(1, 1)
    expect(pulled?.Cnom).toBeUndefined() // locked: not returned
  })
  it('keeps values within their limits and returns nothing when all are locked', () => {
    const pulled = pullCurve('capacitor', mlcc, '|Z|(f)', [1e6, 1], ['esr'], [], (k) =>
      k === 'esr' ? [null, 0.05] : [null, null],
    )
    expect(pulled?.esr).toBeLessThanOrEqual(0.05)
    expect(pullCurve('capacitor', mlcc, '|Z|(f)', [1e6, 1], [], [])).toBeNull()
    expect(xAt({ x: [0, 1], y: [1, 100] }, 10)).toBeCloseTo(0.5)
  })
})

describe('RDS of a MOSFET', () => {
  const v = { vto: 2, kp: 1, rd: 0.3, rs: 0.1 }
  const gates = [3, 4, 5, 10]
  it('follows the channel plus RD and RS, for gates turned on only', () => {
    const c = rdsCurve(v, [1, 2, 3, 10])
    expect(c.x).toEqual([3, 10])
    expect(c.y[0]).toBeCloseTo(1 / (1 * 1) + 0.4, 9)
  })
  it('with THETA, a channel that resists more at high gate voltage (level 3)', () => {
    expect(rdsCurve({ ...v, theta: 0.5 }, [3]).y[0]).toBeCloseTo(1.5 / 1 + 0.4, 9)
  })
  it('takes a P-channel part in its negative voltages', () => {
    expect(rdsCurve({ ...v, vto: -2 }, [-3]).y[0]).toBeCloseTo(1.4, 9)
  })
  it('splits a dragged flat end between RD and RS and keeps the channel', () => {
    const h = featureHandles('mos', v, { 'RDS(Vgs)': [rdsCurve(v, gates)] }, always).find(
      (x) => x.label === 'RDS',
    )
    expect(h?.x).toBe(10)
    const moved = h?.apply(10, 0.525) ?? {} // the channel at 10 V is 0.125 Ω: the rest is 0.4 → 0.4
    expect(moved.rd).toBeCloseTo(0.3, 9)
    const more = h?.apply(10, 0.925) ?? {} // 0.8 Ω for RD + RS, in the same proportion
    expect(more.rd).toBeCloseTo(0.6, 9)
    expect(more.rs).toBeCloseTo(0.2, 9)
    expect(h?.apply(10, 0.05)).toEqual({}) // below the channel: out of reach
  })
})

describe('the fall of a BJT gain at low current', () => {
  const v = { is: 1e-14, bf: 300, ise: 1e-14, ne: 1.5 }
  const gainAt = (values: typeof v, ic: number) =>
    1 / (1 / values.bf + (values.ise * (ic / values.is) ** (1 / values.ne)) / ic)
  const amps = Array.from({ length: 61 }, (_x, i) => 10 ** (-7 + i / 10))
  const curve = { x: amps, y: amps.map((i) => gainAt(v, i)) }
  const handles = featureHandles('bjt', v, { 'hFE(Ic)': [curve] }, always)
  it('ISE puts the curve through the dropped point', () => {
    const h = handles.find((x) => x.label === 'ISE')
    expect(h?.params).toEqual(['ise'])
    const moved = h?.apply(h.x, h.y * 0.8) ?? {}
    expect(gainAt({ ...v, ise: moved.ise }, h?.x ?? 0)).toBeCloseTo((h?.y ?? 0) * 0.8, 3)
    expect(moved.ise).toBeGreaterThan(v.ise) // less gain: more leakage
    expect(h?.apply(h.x, 1000)).toEqual({}) // above BF: out of reach
  })
  it('NE puts it through both handles', () => {
    const ise = handles.find((x) => x.label === 'ISE')
    const ne = handles.find((x) => x.label === 'NE')
    const moved = ne?.apply(ne.x, (ne?.y ?? 0) * 0.7) ?? {}
    const after = { ...v, ise: moved.ise, ne: moved.ne }
    expect(gainAt(after, ne?.x ?? 0) / ((ne?.y ?? 0) * 0.7)).toBeCloseTo(1, 2)
    expect(gainAt(after, ise?.x ?? 0) / (ise?.y ?? 1)).toBeCloseTo(1, 2)
  })
})

describe('the models without a formula: handles on their simulated curves', () => {
  const logs = (from: number, to: number, y: (f: number) => number) => {
    const x = Array.from({ length: (to - from) * 10 + 1 }, (_i, i) => 10 ** (from + i / 10))
    return { x, y: x.map(y) }
  }
  it('a resistor: its value on the flat part', () => {
    const curve = logs(1, 8, () => 1000)
    const h = featureHandles('resistor', { Rnom: 1000 }, { '|Z|(f)': [curve] }, always)[0]
    expect(h.label).toBe('R')
    expect(h.apply(h.x, 2000).Rnom).toBeCloseTo(2000, 6)
  })
  it('a transformer: the ratio in mid-band and Lp from an inductive point', () => {
    const v = { lp: 1e-3, n: 0.5, rp: 0.2, rcore: 50e3 }
    const handles = featureHandles(
      'tpl:Standard templates/Real transformer',
      v,
      {
        'Ratio(f)': [logs(1, 8, () => 0.5)],
        '|Zin|(f)': [logs(1, 8, (f) => 2 * Math.PI * f * 1e-3)],
      },
      always,
    )
    const ratio = handles.find((h) => h.label === 'ratio')
    expect(ratio?.apply(ratio.x, 1).n).toBeCloseTo(1, 6)
    const lp = handles.find((h) => h.label === 'Lp')
    expect(lp?.x).toBeCloseTo(100 / (2 * Math.PI * 1e-3), 0) // √(0.2·50k) = 100 Ω of reactance
    expect(lp?.apply(lp.x, (lp?.y ?? 0) * 2).lp).toBeCloseTo(2e-3, 6) // twice the reactance
    expect(lp?.apply((lp?.x ?? 0) * 2, lp?.y ?? 0).lp).toBeCloseTo(0.5e-3, 6) // the same at twice f
  })
  it('an op-amp: the DC gain in dB and GBW where the gain crosses 0 dB', () => {
    const v = { aol: 100e3, gbw: 1e6 }
    const db = (f: number) => 100 - 10 * Math.log10(1 + (f / 10) ** 2)
    const handles = featureHandles(
      'tpl:Standard templates/Op-amp macromodel',
      v,
      { 'Aol(f)': [logs(-1, 8, db)] },
      always,
    )
    const aol = handles.find((h) => h.label === 'Aol')
    expect(aol?.apply(aol.x, (aol?.y ?? 0) + 20).aol).toBeCloseTo(1e6, 3) // 20 dB more: ten times
    const gbw = handles.find((h) => h.label === 'GBW')
    expect(gbw?.x).toBeGreaterThan(0.8e6)
    expect(gbw?.x).toBeLessThan(1.2e6)
    expect(gbw?.apply((gbw?.x ?? 0) * 2, 0).gbw).toBeCloseTo(2e6, 3)
  })
})
