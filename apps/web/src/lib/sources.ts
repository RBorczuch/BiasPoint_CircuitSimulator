/**
 * Transient waveforms of independent sources (FR-SIM-10) as form fields and SPICE text:
 * SIN, PULSE, EXP, PWL (typed or from a CSV file / measurement), AM, FM (SFFM), noise
 * (white, 1/f, random telegraph: TRNOISE) and random levels (TRRANDOM).
 */
import { formatValue, parseValue, toSpice } from './units'

export type WaveKind =
  | 'none'
  | 'sin'
  | 'pulse'
  | 'exp'
  | 'pwl'
  | 'am'
  | 'sffm'
  | 'noise'
  | 'random'
  | 'custom'
type FormKind = Exclude<WaveKind, 'none' | 'custom' | 'pwl'>

export interface WaveField {
  key: string
  label: string
  unit: 'value' | 's' | 'Hz' | '1/s' | '' // 'value' = V or A, per source
  optional?: boolean
  hint?: string
  options?: [string, string][] // a choice instead of a number
}

/** Fields of each waveform, in the order of the SPICE arguments. */
export const WAVE_FIELDS: Record<FormKind, WaveField[]> = {
  sin: [
    { key: 'vo', label: 'Offset', unit: 'value' },
    { key: 'va', label: 'Amplitude', unit: 'value', hint: 'peak, not RMS' },
    { key: 'freq', label: 'Frequency', unit: 'Hz' },
    { key: 'td', label: 'Delay', unit: 's', optional: true },
    { key: 'theta', label: 'Damping', unit: '1/s', optional: true },
  ],
  pulse: [
    { key: 'v1', label: 'Initial', unit: 'value' },
    { key: 'v2', label: 'Pulsed', unit: 'value' },
    { key: 'td', label: 'Delay', unit: 's' },
    { key: 'tr', label: 'Rise time', unit: 's' },
    { key: 'tf', label: 'Fall time', unit: 's' },
    { key: 'pw', label: 'Pulse width', unit: 's' },
    { key: 'per', label: 'Period', unit: 's' },
  ],
  exp: [
    { key: 'v1', label: 'Initial', unit: 'value' },
    { key: 'v2', label: 'Final', unit: 'value' },
    { key: 'td1', label: 'Rise delay', unit: 's' },
    { key: 'tau1', label: 'Rise τ', unit: 's' },
    { key: 'td2', label: 'Fall delay', unit: 's' },
    { key: 'tau2', label: 'Fall τ', unit: 's' },
  ],
  // ngspice: VO + (VMO + VMA·sin(2π·FM·t))·sin(2π·FC·t)
  am: [
    { key: 'vo', label: 'Offset', unit: 'value' },
    { key: 'vmo', label: 'Carrier amplitude', unit: 'value', hint: 'peak, without modulation' },
    { key: 'vma', label: 'Modulation amplitude', unit: 'value', hint: 'equal to the carrier = 100 % depth' },
    { key: 'fm', label: 'Modulation f', unit: 'Hz' },
    { key: 'fc', label: 'Carrier f', unit: 'Hz' },
    { key: 'td', label: 'Delay', unit: 's', optional: true },
  ],
  sffm: [
    { key: 'vo', label: 'Offset', unit: 'value' },
    { key: 'va', label: 'Amplitude', unit: 'value' },
    { key: 'fc', label: 'Carrier f', unit: 'Hz' },
    { key: 'mdi', label: 'Modulation index', unit: '', hint: 'frequency deviation / modulation f' },
    { key: 'fs', label: 'Modulation f', unit: 'Hz' },
  ],
  noise: [
    { key: 'na', label: 'White (RMS)', unit: 'value' },
    { key: 'nt', label: 'Time step', unit: 's', hint: 'new noise value every step; sets the bandwidth' },
    { key: 'nalpha', label: '1/f exponent', unit: '', optional: true, hint: '0 … 2 (1 = pink)' },
    { key: 'namp', label: '1/f amplitude', unit: 'value', optional: true },
    { key: 'rtsam', label: 'RTS amplitude', unit: 'value', optional: true, hint: 'random telegraph signal' },
    { key: 'rtscapt', label: 'RTS capture τ', unit: 's', optional: true },
    { key: 'rtsemt', label: 'RTS emission τ', unit: 's', optional: true },
  ],
  random: [
    {
      key: 'type',
      label: 'Distribution',
      unit: '',
      options: [
        ['1', 'Uniform (range, offset)'],
        ['2', 'Gaussian (σ, mean)'],
        ['3', 'Exponential (mean, offset)'],
        ['4', 'Poisson (λ, offset)'],
      ],
    },
    { key: 'ts', label: 'Step', unit: 's', hint: 'a new random value every step' },
    { key: 'td', label: 'Delay', unit: 's' },
    { key: 'p1', label: 'Range / σ / mean / λ', unit: 'value' },
    { key: 'p2', label: 'Offset / mean', unit: 'value' },
  ],
}

const KEYWORD: Record<FormKind, string> = {
  sin: 'SIN',
  pulse: 'PULSE',
  exp: 'EXP',
  am: 'AM',
  sffm: 'SFFM',
  noise: 'TRNOISE',
  random: 'TRRANDOM',
}

export const WAVE_DEFAULTS: Record<FormKind, Record<string, string>> & { pwl: Record<string, string> } = {
  sin: { vo: '0', va: '1', freq: '1k', td: '', theta: '' },
  pulse: { v1: '0', v2: '1', td: '0', tr: '1u', tf: '1u', pw: '0.5m', per: '1m' },
  exp: { v1: '0', v2: '1', td1: '0', tau1: '100u', td2: '1m', tau2: '200u' },
  am: { vo: '0', vmo: '1', vma: '0.5', fm: '1k', fc: '100k', td: '' },
  sffm: { vo: '0', va: '1', fc: '100k', mdi: '5', fs: '1k' },
  noise: { na: '10m', nt: '1u', nalpha: '', namp: '', rtsam: '', rtscapt: '', rtsemt: '' },
  random: { type: '2', ts: '10u', td: '0', p1: '0.1', p2: '0' },
  pwl: { points: '0 0\n1m 1\n2m 0', repeat: '' },
}

export const WAVE_LABELS: [WaveKind, string][] = [
  ['none', 'None (DC only)'],
  ['sin', 'Sine'],
  ['pulse', 'Pulse / square'],
  ['exp', 'Exponential (EXP)'],
  ['pwl', 'Piecewise linear / from a file'],
  ['am', 'AM modulated sine'],
  ['sffm', 'FM modulated sine (SFFM)'],
  ['noise', 'Noise (white, 1/f, RTS)'],
  ['random', 'Random levels'],
  ['custom', 'Custom (SPICE)'],
]

export interface Wave {
  kind: WaveKind
  fields: Record<string, string>
}

const BY_KEYWORD = Object.fromEntries(Object.entries(KEYWORD).map(([k, v]) => [v, k as FormKind]))

/** "PULSE(0 1 0 1n 1n 1m 2m)" -> pulse fields; anything else is kept as custom text. */
export function parseWave(text: string | undefined): Wave {
  const raw = (text ?? '').trim()
  if (!raw) return { kind: 'none', fields: {} }
  const match = /^(\w+)\s*\((.*)\)\s*(r\s*=\s*\S+)?\s*$/i.exec(raw)
  if (!match) return { kind: 'custom', fields: { text: raw } }
  const keyword = match[1].toUpperCase()
  const args = match[2]
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
  if (keyword === 'PWL') {
    if (args.length % 2 || args.some((a) => parseValue(a) === null))
      return { kind: 'custom', fields: { text: raw } }
    const pairs: string[] = []
    for (let i = 0; i < args.length; i += 2) pairs.push(`${args[i]} ${args[i + 1]}`)
    const repeat = match[3] ? match[3].split('=')[1].trim() : ''
    return { kind: 'pwl', fields: { points: pairs.join('\n'), repeat } }
  }
  const kind = BY_KEYWORD[keyword]
  if (!kind || match[3]) return { kind: 'custom', fields: { text: raw } }
  const spec = WAVE_FIELDS[kind]
  if (args.length > spec.length) return { kind: 'custom', fields: { text: raw } }
  return { kind, fields: Object.fromEntries(spec.map((f, i) => [f.key, args[i] ?? ''])) }
}

/** Fields -> SPICE text; quantities may carry units ("1 kHz", "10 µs"). */
export function composeWave(wave: Wave, valueUnit: 'V' | 'A'): string | null {
  if (wave.kind === 'none') return null
  if (wave.kind === 'custom') return wave.fields.text?.trim() || null
  if (wave.kind === 'pwl') {
    const points = pwlPoints(wave.fields.points ?? '')
    if (!points.length) return null
    const repeat = (wave.fields.repeat ?? '').trim()
    return `PWL(${points.map(([t, v]) => `${t} ${v}`).join(' ')})${repeat ? ` r=${toSpice(repeat, 's')}` : ''}`
  }
  const spec = WAVE_FIELDS[wave.kind]
  const args = spec.map((f) => {
    const text = (wave.fields[f.key] ?? '').trim()
    if (f.options) return text || f.options[0][0]
    const unit = f.unit === 'value' ? valueUnit : f.unit === '1/s' ? '' : f.unit
    return text ? toSpice(text, unit) : f.optional ? '' : '0'
  })
  while (args.length && args[args.length - 1] === '' && spec[args.length - 1].optional) args.pop()
  return `${KEYWORD[wave.kind]}(${args.map((a) => a || '0').join(' ')})`
}

/** "t v" lines (spaces, commas, semicolons or tabs; decimal commas with ; or tabs) -> SPICE pairs. */
export function pwlPoints(text: string): [string, string][] {
  const out: [string, string][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = /[;\t]/.test(line)
      ? line.split(/[;\t]/).map((p) => p.trim().replace(/^([+-]?\d+),(\d)/, '$1.$2'))
      : line.split(/[\s,]+/)
    if (parts.length < 2) continue
    const t = parseValue(parts[0])
    const v = parseValue(parts[1])
    if (t === null || v === null) continue // a header line
    out.push([toSpice(parts[0]), toSpice(parts[1])])
  }
  return out
}

/** Peak amplitude of a sine delivering ``dbm`` into ``ohms`` (volts, or amperes). */
export function dbmToPeak(dbm: number, ohms: number, unit: 'V' | 'A'): number {
  const watts = 10 ** ((dbm - 30) / 10)
  return unit === 'V' ? Math.sqrt(2 * watts * ohms) : Math.sqrt((2 * watts) / ohms)
}

/**
 * A waveform in a few words for the schematic ("SIN 10 V 50 Hz", "PULSE 0→5 V 1 ms"): the full
 * SPICE text is long enough to run over the neighbouring parts. Unknown text stays as it is.
 */
export function shortWave(text: string, unit: 'V' | 'A'): string {
  const wave = parseWave(text)
  const f = wave.fields
  const v = (key: string, u: string = unit) => {
    const n = parseValue(f[key] ?? '')
    return n === null ? (f[key] ?? '') : formatValue(n, u, 3)
  }
  switch (wave.kind) {
    case 'sin': {
      const offset = parseValue(f.vo ?? '') ? `${v('vo')} + ` : ''
      return `${offset}SIN ${v('va')} ${v('freq', 'Hz')}`
    }
    case 'pulse': {
      const period = parseValue(f.per ?? '') ? ` ${v('per', 's')}` : ''
      return `PULSE ${v('v1')}→${v('v2')}${period}`
    }
    case 'exp':
      return `EXP ${v('v1')}→${v('v2')}`
    case 'pwl': {
      const n = pwlPoints(f.points ?? '').length
      return `PWL ${n} points${f.repeat ? ' repeated' : ''}`
    }
    case 'am':
      return `AM ${v('vmo')} ${v('fc', 'Hz')}`
    case 'sffm':
      return `FM ${v('va')} ${v('fc', 'Hz')}`
    case 'noise':
      return `noise ${v('na')} rms`
    case 'random':
      return 'random levels'
    default:
      return text.length > 24 ? `${text.slice(0, 22)}…` : text
  }
}
