import { describe, expect, it } from 'vitest'
import {
  decimalPoint,
  decimalPoints,
  formatValue,
  parseQuantity,
  parseValue,
  signalUnit,
  spiceNumber,
  toSpice,
  valueHint,
} from './units'

describe('formatValue', () => {
  it('uses SI prefixes', () => {
    expect(formatValue(4700, 'Ω')).toBe('4.7 kΩ')
    expect(formatValue(-0.0025, 'A')).toBe('-2.5 mA')
    expect(formatValue(7.5, 'V')).toBe('7.5 V')
    expect(formatValue(0, 'V')).toBe('0 V')
    expect(formatValue(1.23456e-9, 's', 3)).toBe('1.23 ns')
  })

  it('knows signal units', () => {
    expect(signalUnit('V(out)')).toBe('V')
    expect(signalUnit('I(Q1.C)')).toBe('A')
    expect(signalUnit('time')).toBe('')
  })
})

describe('parseValue (same cases as backend tests/test_units.py)', () => {
  it.each([
    ['10', 10],
    ['-2.5', -2.5],
    ['1e-3', 1e-3],
    ['10k', 10e3],
    ['1meg', 1e6],
    ['1M', 1e-3],
    ['100mA', 0.1],
    ['10kΩ', 10e3],
    ['2.2uF', 2.2e-6],
    ['2.2µF', 2.2e-6],
    ['4k7', 4.7e3],
    ['2u2', 2.2e-6],
    ['1meg5', 1.5e6],
    ['1R5', 1.5],
    ['3V3', 3.3],
    ['-4k7', -4.7e3],
    ['10mil', 254e-6],
    [' 47 n ', 47e-9],
  ])('%s', (text, expected) => {
    expect(parseValue(text)).toBeCloseTo(expected, 12)
  })

  it.each(['', 'abc', '{R*2}', '1..2', 'k10', '4k7k3'])('rejects %s', (text) => {
    expect(parseValue(text)).toBeNull()
  })

  it('hints', () => {
    expect(valueHint('4k7', 'Ω')).toEqual({ ok: true, hint: '= 4.7 kΩ' })
    expect(valueHint('1M', 'Ω').hint).toContain('meg')
    expect(valueHint('{R*2}').ok).toBe(true)
    expect(valueHint('x').ok).toBe(false)
  })
})

describe('parseQuantity', () => {
  it('accepts units, with SI prefixes when the unit is written', () => {
    expect(parseQuantity('10 ms', 's')).toBeCloseTo(0.01)
    expect(parseQuantity('1MHz', 'Hz')).toBe(1e6)
    expect(parseQuantity('1 mHz', 'Hz')).toBeCloseTo(1e-3)
    expect(parseQuantity('10µs', 's')).toBeCloseTo(1e-5)
    expect(parseQuantity('1meg', 'Hz')).toBe(1e6)
    expect(parseQuantity('5', 'V')).toBe(5)
    expect(parseQuantity('abc', 's')).toBeNull()
  })
})

describe('spiceNumber / toSpice', () => {
  it('writes SPICE notation', () => {
    expect(spiceNumber(0.01)).toBe('10m')
    expect(spiceNumber(1e6)).toBe('1meg')
    expect(spiceNumber(2.5e-6)).toBe('2.5u')
    expect(toSpice('1 MHz', 'Hz')).toBe('1meg')
    expect(toSpice('{Tstop}', 's')).toBe('{Tstop}')
  })
})

describe('formatValue rounding', () => {
  it('rounds before choosing the prefix', () => {
    expect(formatValue(0.99999, 'V')).toBe('1 V')
  })
})

describe('decimal comma', () => {
  it('reads a comma as the decimal point in one value', () => {
    expect(parseValue('1,5k')).toBeCloseTo(1500)
    expect(parseQuantity('4,7 nF', 'F')).toBeCloseTo(4.7e-9)
    expect(decimalPoint('1,5k')).toBe('1.5k')
    expect(decimalPoint('{R*2}')).toBe('{R*2}')
    expect(decimalPoints('R1 a b 4,7k; C1 b 0 2,2u')).toBe('R1 a b 4.7k; C1 b 0 2.2u')
    expect(decimalPoints('V1 a 0 PULSE(0 1,5 0)')).toBe('V1 a 0 PULSE(0 1.5 0)')
  })
})
