import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '@/api/types'
import { useSettings } from '@/store/settings'
import { drawn, lookName } from './looks'

const box = { kind: 'rect', start: [-1, -1], end: [1, 1], fill: false } as const
const zigzag = {
  kind: 'polyline',
  points: [
    [0, -1],
    [1, 0],
    [0, 1],
  ],
  fill: false,
} as const
const resistor = {
  id: 'bpt:resistor',
  graphics: [box],
  pins: [],
  looks: [
    { name: 'ansi', label: 'Zigzag', standard: 'ansi', graphics: [zigzag] },
    { name: 'thin', label: 'Thin', standard: null, graphics: [] },
  ],
} as unknown as SymbolDef

describe('symbol looks', () => {
  it('follows the standard unless the part has a look of its own', () => {
    useSettings.setState({ symbolStandard: 'iec' })
    expect(drawn(resistor)).toBe(resistor)
    useSettings.setState({ symbolStandard: 'ansi' })
    expect(drawn(resistor).graphics).toEqual([zigzag])
    expect(drawn(resistor)).toBe(drawn(resistor)) // cached: the renderer keys on it
    expect(lookName(drawn(resistor))).toBe('ansi')
    expect(drawn(resistor, 'thin').graphics).toEqual([])
    expect(drawn(resistor, 'base')).toBe(resistor) // the basic drawing, whatever the standard
    useSettings.setState({ symbolStandard: 'iec' })
  })
})

describe('signal looks', () => {
  it('draw a source by its waveform unless it has a look of its own', () => {
    const sine = { kind: 'circle', center: [0, 0], radius: 1, fill: false } as const
    const source = {
      id: 'bpt:vsource',
      graphics: [box],
      pins: [],
      looks: [{ name: 'sine', label: 'Sine', standard: null, signal: 'SIN', graphics: [sine] }],
    } as unknown as SymbolDef
    expect(drawn(source, null, 'SIN(0 1 1k)').graphics).toEqual([sine])
    expect(drawn(source, null, 'PULSE(0 5 0 1n 1n 1u 2u)')).toBe(source)
    expect(drawn(source, null, '')).toBe(source)
    expect(drawn(source, 'base', 'SIN(0 1 1k)')).toBe(source)
  })
})
