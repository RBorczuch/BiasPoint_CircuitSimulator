/** Analysis cards <-> form fields (the project stores analyses as SPICE cards). */
import type { AnalysisKind } from '@/api/types'
import { toSpice } from './units'

export interface FieldDef {
  key: string
  label: string
  placeholder?: string
  options?: string[]
  optional?: boolean
  unit?: string // 'source' / 'source2': V, A, Ω or °C from what the sweep varies
  second?: boolean // a field of the DC sweep's second source (shown when it has one)
}

export const FIELDS: Record<AnalysisKind, FieldDef[]> = {
  op: [],
  dc: [
    { key: 'source', label: 'Source' },
    { key: 'start', label: 'Start', placeholder: '0', unit: 'source' },
    { key: 'stop', label: 'Stop', placeholder: '5', unit: 'source' },
    { key: 'step', label: 'Step', placeholder: '0.1', unit: 'source' },
    { key: 'source2', label: 'Then sweep', second: true },
    { key: 'start2', label: 'Start', placeholder: '0', unit: 'source2', second: true },
    { key: 'stop2', label: 'Stop', placeholder: '5', unit: 'source2', second: true },
    { key: 'step2', label: 'Step', placeholder: '1', unit: 'source2', second: true },
  ],
  ac: [
    { key: 'variation', label: 'Sweep', options: ['dec', 'oct', 'lin'] },
    { key: 'points', label: 'Points', placeholder: '20' },
    { key: 'fstart', label: 'Start freq.', placeholder: '10', unit: 'Hz' },
    { key: 'fstop', label: 'Stop freq.', placeholder: '1 MHz', unit: 'Hz' },
  ],
  tran: [
    { key: 'tstop', label: 'Stop time', placeholder: '10 ms', unit: 's' },
    { key: 'tstep', label: 'Time step', placeholder: '10 µs', unit: 's' },
    { key: 'tstart', label: 'Save from', placeholder: '0', optional: true, unit: 's' },
    { key: 'tmax', label: 'Max step', placeholder: 'auto', optional: true, unit: 's' },
    { key: 'uic', label: 'Skip OP (uic)', options: ['no', 'yes'] },
  ],
}

export function parseCard(kind: AnalysisKind, card: string): Record<string, string> {
  const tokens = card.trim().split(/\s+/).slice(1)
  switch (kind) {
    case 'dc': {
      const [source = 'V1', start = '0', stop = '5', step = '0.1'] = tokens
      const [source2 = '', start2 = '', stop2 = '', step2 = ''] = tokens.slice(4)
      return { source, start, stop, step, source2, start2, stop2, step2 }
    }
    case 'ac': {
      const [variation = 'dec', points = '20', fstart = '10', fstop = '1meg'] = tokens
      return { variation, points, fstart, fstop }
    }
    case 'tran': {
      const uic = tokens.some((t) => t.toLowerCase() === 'uic')
      const [tstep = '10u', tstop = '10m', tstart = '', tmax = ''] = tokens.filter(
        (t) => t.toLowerCase() !== 'uic',
      )
      return { tstep, tstop, tstart: tstart === '0' ? '' : tstart, tmax, uic: uic ? 'yes' : 'no' }
    }
    default:
      return {}
  }
}

/** Unit of what a DC sweep varies: a voltage or current source, a resistor, TEMP. */
export function sweepUnit(name: string | undefined): string {
  const upper = (name ?? '').trim().toUpperCase()
  if (upper === 'TEMP') return '°C'
  return { V: 'V', I: 'A', R: 'Ω' }[upper[0]] ?? ''
}

/** Unit of a field: 'source' / 'source2' resolve from what that sweep varies. */
export function fieldUnit(field: FieldDef, values: Record<string, string>): string {
  if (field.unit === 'source') return sweepUnit(values.source)
  if (field.unit === 'source2') return sweepUnit(values.source2)
  return field.unit ?? ''
}

export function buildCard(kind: AnalysisKind, fields: Record<string, string>): string {
  // Quantities typed with units ("10 ms", "1 MHz") become SPICE numbers ("10m", "1meg").
  const f: Record<string, string> = { ...fields }
  for (const field of FIELDS[kind]) {
    if (field.unit && f[field.key]) f[field.key] = toSpice(f[field.key], fieldUnit(field, fields))
  }
  switch (kind) {
    case 'dc': {
      const first = `.dc ${f.source} ${f.start} ${f.stop} ${f.step}`
      const second = f.source2 && f.start2 && f.stop2 && f.step2
      return second ? `${first} ${f.source2} ${f.start2} ${f.stop2} ${f.step2}` : first
    }
    case 'ac':
      return `.ac ${f.variation} ${f.points} ${f.fstart} ${f.fstop}`
    case 'tran': {
      const parts = ['.tran', f.tstep || '10u', f.tstop || '10m']
      if (f.tstart || f.tmax) parts.push(f.tstart || '0')
      if (f.tmax) parts.push(f.tmax)
      if (f.uic === 'yes') parts.push('uic')
      return parts.join(' ')
    }
    default:
      return '.op'
  }
}
