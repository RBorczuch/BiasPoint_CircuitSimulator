import { describe, expect, it } from 'vitest'
import { axisPrefix, axisTitle, groupSignals, tickLabels } from './format'

describe('plot axes', () => {
  it('picks one SI prefix per axis', () => {
    expect(axisPrefix(0.0042, 's')).toEqual({ scale: 1e-3, prefix: 'm' })
    expect(axisPrefix(2.5e6, 'Hz')).toEqual({ scale: 1e6, prefix: 'M' })
    expect(axisPrefix(999, 'V')).toEqual({ scale: 1, prefix: '' })
    expect(axisPrefix(-40, 'dB')).toEqual({ scale: 1, prefix: '' })
    expect(axisPrefix(0, 'A')).toEqual({ scale: 1, prefix: '' })
  })

  it('labels ticks with just enough decimals', () => {
    expect(tickLabels([0, 0.0005, 0.001, 0.0015], 1e-3)).toEqual(['0.0', '0.5', '1.0', '1.5'])
    expect(tickLabels([0, 200, 400, null], 1)).toEqual(['0', '200', '400', ''])
    expect(tickLabels([-1e-17, 0.25], 1)).toEqual(['0.00', '0.25'])
  })

  it('titles axes with quantity and unit', () => {
    expect(axisTitle(['V(out)'], 'V', 'm')).toBe('V(out) [mV]')
    expect(axisTitle(['V(in)', 'V(out)'], 'V', '')).toBe('Voltage [V]')
    expect(axisTitle(['Time'], 's', 'µ')).toBe('Time [µs]')
  })
})

describe('signal browser', () => {
  it('groups named nets, currents and unnamed nets', () => {
    const groups = groupSignals(
      ['time', 'V(N002)', 'I(R1)', 'V(out)', 'V(in)', 'V(_c1_esr)', 'I(V1)'],
      'time',
    )
    expect(groups).toEqual([
      { title: 'Nets', signals: ['V(in)', 'V(out)'] },
      { title: 'Currents', signals: ['I(R1)', 'I(V1)'] },
      { title: 'Unnamed nets', signals: ['V(N002)'] },
      { title: 'Internal nodes', signals: ['V(_c1_esr)'] },
    ])
  })
})
