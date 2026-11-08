import { describe, expect, it } from 'vitest'
import { buildCard, parseCard, sweepUnit } from './cards'

describe('analysis cards', () => {
  it('round-trips form fields', () => {
    for (const [kind, card] of [
      ['dc', '.dc V1 0 5 0.1'],
      ['ac', '.ac dec 20 10 1meg'],
      ['tran', '.tran 10u 10m'],
      ['tran', '.tran 1u 5m 4m 100n uic'],
    ] as const) {
      expect(buildCard(kind, parseCard(kind, card))).toBe(card)
    }
  })

  it('keeps tstart when only tmax is given', () => {
    expect(buildCard('tran', { tstep: '1u', tstop: '1m', tstart: '', tmax: '10n', uic: 'no' })).toBe(
      '.tran 1u 1m 0 10n',
    )
  })
})

describe('cards with units', () => {
  it('converts typed quantities', () => {
    expect(buildCard('tran', { tstep: '10 µs', tstop: '5 ms' })).toBe('.tran 10u 5m')
    expect(buildCard('ac', { variation: 'dec', points: '20', fstart: '10 Hz', fstop: '1 MHz' })).toBe(
      '.ac dec 20 10 1meg',
    )
    expect(buildCard('dc', { source: 'I1', start: '0', stop: '10 mA', step: '1mA' })).toBe('.dc I1 0 10m 1m')
  })
})

describe('DC sweeps', () => {
  it('keeps a second source (a family of curves)', () => {
    const card = '.dc VC 0 10 0.1 IB 0 50u 10u'
    expect(parseCard('dc', card).source2).toBe('IB')
    expect(buildCard('dc', parseCard('dc', card))).toBe(card)
    expect(buildCard('dc', { ...parseCard('dc', card), source2: '' })).toBe('.dc VC 0 10 0.1')
  })

  it('sweeps resistors and the temperature in their units', () => {
    expect(sweepUnit('R2')).toBe('Ω')
    expect(sweepUnit('temp')).toBe('°C')
    expect(sweepUnit('I1')).toBe('A')
    expect(buildCard('dc', { source: 'R1', start: '1 kΩ', stop: '10 kΩ', step: '1k' })).toBe(
      '.dc R1 1k 10k 1k',
    )
    expect(buildCard('dc', { source: 'TEMP', start: '-40', stop: '125 °C', step: '5' })).toBe(
      '.dc TEMP -40 125 5',
    )
  })
})
