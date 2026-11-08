import { describe, expect, it } from 'vitest'
import type { PlotSeries } from '@/api/types'
import { onRight, paneGroups, parseLines } from './plotLayout'

const s = (name: string, unit: string, family = ''): PlotSeries => ({
  name: family ? `${name} [${family}]` : name,
  family,
  x_name: 'time',
  x_unit: 's',
  unit,
  x: [0, 1],
  min: null,
  max: [0, 1],
  re: null,
  im: null,
})
const unit = (x: PlotSeries) => x.unit

describe('plot layout', () => {
  const traces = [s('V(in)', 'V'), s('V(out)', 'V', 'R=1k'), s('V(out)', 'V', 'R=2k'), s('I(R1)', 'A')]

  it('splits traces into panels by unit, by signal or by the groups written', () => {
    expect(paneGroups(traces, 'one', '', unit)).toHaveLength(1)
    expect(paneGroups(traces, 'per unit', '', unit).map((p) => p.length)).toEqual([3, 1])
    expect(paneGroups(traces, 'per signal', '', unit).map((p) => p.length)).toEqual([1, 2, 1])
    const custom = paneGroups(traces, 'custom', 'I(*); V(out)', unit)
    expect(custom.map((p) => p.map((x) => x.name))).toEqual([
      ['I(R1)'],
      ['V(in)', 'V(out) [R=1k]', 'V(out) [R=2k]'], // V(in) matches no group: the last panel
    ])
  })

  it('puts the traces asked for on the right-hand axis', () => {
    expect(traces.filter((t) => onRight(t, 'v(in)|I(*)')).map((t) => t.name)).toEqual(['V(in)', 'I(R1)'])
    expect(onRight(traces[0], '')).toBe(false)
  })

  it('reads reference lines with units, vertical ones with x =', () => {
    expect(parseLines('3.3 V; 1.65; x = 2 ms; 10 mA; nonsense')).toEqual([
      { axis: 'y', value: 3.3, unit: 'V', label: '3.3 V' },
      { axis: 'y', value: 1.65, unit: '', label: '1.65' },
      { axis: 'x', value: 0.002, unit: 's', label: 'x = 2 ms' },
      { axis: 'y', value: 0.01, unit: 'A', label: '10 mA' },
    ])
  })
})
