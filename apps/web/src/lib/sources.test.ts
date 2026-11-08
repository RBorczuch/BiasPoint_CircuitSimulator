import { describe, expect, it } from 'vitest'
import { composeWave, dbmToPeak, parseWave, shortWave } from './sources'

describe('source waveforms', () => {
  it('parses SIN and PULSE into fields', () => {
    expect(parseWave('SIN(0 1 1k)')).toEqual({
      kind: 'sin',
      fields: { vo: '0', va: '1', freq: '1k', td: '', theta: '' },
    })
    expect(parseWave('pulse(0, 5, 0, 1n, 1n, 1m, 2m)').fields.per).toBe('2m')
    expect(parseWave('')).toEqual({ kind: 'none', fields: {} })
  })

  it('parses PWL, noise and modulated sources', () => {
    expect(parseWave('PWL(0 0 1m 1) r=0')).toEqual({
      kind: 'pwl',
      fields: { points: '0 0\n1m 1', repeat: '0' },
    })
    expect(parseWave('PWL(0 0 1m {x})').kind).toBe('custom')
    expect(parseWave('TRNOISE(10m 1u 1 5m)').fields).toMatchObject({ na: '10m', nalpha: '1', rtsam: '' })
    expect(parseWave('SFFM(0 1 100k 5 1k)').kind).toBe('sffm')
    expect(parseWave('AM(1 1 1k 100k)').kind).toBe('am')
  })

  it('composes SPICE text, converting units and dropping unused optional fields', () => {
    expect(composeWave({ kind: 'sin', fields: { vo: '0', va: '1 V', freq: '1 kHz' } }, 'V')).toBe(
      'SIN(0 1 1k)',
    )
    expect(
      composeWave(
        {
          kind: 'pulse',
          fields: { v1: '0', v2: '5', td: '', tr: '10 ns', tf: '10ns', pw: '1 ms', per: '2 ms' },
        },
        'V',
      ),
    ).toBe('PULSE(0 5 0 10n 10n 1m 2m)')
    expect(composeWave({ kind: 'none', fields: {} }, 'V')).toBeNull()
    expect(
      composeWave({ kind: 'pwl', fields: { points: 'time;value\n0;0\n0,5m;1,5', repeat: '' } }, 'V'),
    ).toBe('PWL(0 0 0.5m 1.5)')
    expect(composeWave({ kind: 'noise', fields: { na: '1 mV', nt: '1 µs' } }, 'V')).toBe('TRNOISE(1m 1u)')
    expect(composeWave({ kind: 'random', fields: { ts: '10u', td: '0', p1: '1', p2: '0' } }, 'V')).toBe(
      'TRRANDOM(1 10u 0 1 0)',
    )
  })

  it('converts power in dBm to a peak amplitude', () => {
    expect(dbmToPeak(0, 50, 'V')).toBeCloseTo(0.3162, 4) // 1 mW into 50 Ω
    expect(dbmToPeak(30, 50, 'A')).toBeCloseTo(0.2, 4) // 1 W into 50 Ω
  })

  it('says a waveform in a few words for the schematic', () => {
    expect(shortWave('SIN(0 10 50)', 'V')).toBe('SIN 10 V 50 Hz')
    expect(shortWave('PULSE(0 1 0 1u 1u 5m 10m)', 'V')).toBe('PULSE 0 V→1 V 10 ms')
    expect(shortWave('PWL(0 0 1m 1 2m 0) r=0', 'A')).toBe('PWL 3 points repeated')
    expect(shortWave('SIN(2.5 1 1k)', 'V')).toBe('2.5 V + SIN 1 V 1 kHz')
  })
})
