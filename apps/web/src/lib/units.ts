/** Engineering formatting of values (mirrors bpt.units.format_value). */

const PREFIXES: [number, string][] = [
  [1e12, 'T'],
  [1e9, 'G'],
  [1e6, 'M'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'µ'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
]

const NO_PREFIX = new Set(['%', 'dB', '°', 'deg'])

/** "4.7 kΩ", "2.5 mA", "0 V"; `digits` significant digits. */
export function formatValue(value: number, unit = '', digits = 4): string {
  if (!Number.isFinite(value)) return `${value} ${unit}`.trim()
  if (value === 0) return `0 ${unit}`.trim()
  // Percent, dB and degrees never take an SI prefix ("1k%" would be nonsense).
  if (NO_PREFIX.has(unit)) return `${Number(value.toPrecision(digits))} ${unit}`.trim()
  // Round first: 0.99999 V shown with 4 digits is "1 V", not "1000 mV".
  value = Number(value.toPrecision(digits))
  const magnitude = Math.abs(value)
  for (const [scale, prefix] of PREFIXES) {
    if (magnitude >= scale * (1 - 1e-12)) {
      return `${Number((value / scale).toPrecision(digits))} ${prefix}${unit}`.trim()
    }
  }
  return `${Number((value / 1e-15).toPrecision(digits))} f${unit}`.trim()
}

/** Unit of a signal name: V(..) -> V, I(..) -> A. */
export function signalUnit(signal: string): string {
  if (/^V\(/i.test(signal)) return 'V'
  if (/^I\(/i.test(signal)) return 'A'
  if (/^P\(/i.test(signal)) return 'W'
  return ''
}

// -- parsing (mirrors bpt/units.py: SPICE suffixes, M = milli, meg = mega, 4k7 notation) --------

const SCALE: Record<string, number> = {
  t: 1e12,
  g: 1e9,
  meg: 1e6,
  k: 1e3,
  m: 1e-3,
  mil: 25.4e-6,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  n: 1e-9,
  p: 1e-12,
  f: 1e-15,
}
const SUFFIXES = Object.keys(SCALE).sort((a, b) => b.length - a.length)
const UNIT_DECIMAL = new Set(['r', 'v', 'a'])
const PLAIN = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(.*)$/i
const EURO = /^([+-]?\d+)(meg|[tgkmuµμnpfrva])(\d+)(.*)$/i

export const isExpression = (text: string): boolean => /^\s*\{.*\}\s*$/.test(text)

/** A decimal comma as a point: "1,5k" -> "1.5k", "4,7 nF" -> "4.7 nF" (one value, not a list). */
export const decimalPoint = (text: string): string => text.trim().replace(/^([+-]?\d+),(\d)/, '$1.$2')

/** The same for every value in a SPICE line ("R1 a b 4,7k" -> "R1 a b 4.7k"). */
export const decimalPoints = (line: string): string => line.replace(/(^|[\s=(])([+-]?\d+),(\d)/g, '$1$2.$3')

/** Parse a component value ("4k7", "10uF", "1meg"); null if it is not a number. */
export function parseValue(text: string): number | null {
  const raw = decimalPoint(text).replace(/ /g, '')
  if (!raw || isExpression(raw)) return null
  const euro = EURO.exec(raw)
  if (euro) {
    const [, whole, suffix, frac, rest] = euro
    if (/\d/.test(rest)) return null
    const s = suffix.toLowerCase()
    const scale = UNIT_DECIMAL.has(s) ? 1 : SCALE[s]
    const sign = whole.startsWith('-') ? -1 : 1
    return sign * (Math.abs(Number(whole)) + Number(`0.${frac}`)) * scale
  }
  const plain = PLAIN.exec(raw)
  if (!plain) return null
  const [, number, rest] = plain
  if (rest && (/\d/.test(rest) || !/^[a-zµμΩ°%]/i.test(rest))) return null
  const lowered = rest.toLowerCase()
  const suffix = SUFFIXES.find((s) => lowered.startsWith(s))
  return Number(number) * (suffix ? SCALE[suffix] : 1)
}

/** Validation message for a value field: null = OK (numbers and {expressions}). */
export function valueHint(text: string, unit = ''): { ok: boolean; hint: string } {
  if (isExpression(text)) return { ok: true, hint: 'parameter expression' }
  const value = parseValue(text)
  if (value === null) return { ok: false, hint: 'not a value (e.g. 4k7, 100n, 1meg, {R*2})' }
  const warning = /^[+-]?[\d.]+M(?!eg)/.test(text.trim()) ? ' – M means milli; use meg for mega' : ''
  return { ok: true, hint: `= ${formatValue(value, unit)}${warning}` }
}

/** Run time for status lines: "12 ms", "3.40 s". */
export function formatDuration(seconds: number): string {
  return seconds < 1 ? `${Math.max(0, Math.round(seconds * 1000))} ms` : `${seconds.toFixed(2)} s`
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A quantity typed by the user ("10 ms", "1 kHz", "1MHz", "4k7"). With the unit written
 * out, SI rules apply ("M" before the unit is mega); without it SPICE rules ("M" = milli).
 */
export function parseQuantity(text: string, unit = ''): number | null {
  let t = decimalPoint(text).replace(/\s+/g, '')
  if (unit && t.length > unit.length && new RegExp(`${escapeRegex(unit)}$`, 'i').test(t)) {
    t = t.slice(0, -unit.length).replace(/M$/, 'meg')
  }
  return parseValue(t)
}

const SPICE_SUFFIXES: [number, string][] = [
  [1e12, 't'],
  [1e9, 'g'],
  [1e6, 'meg'],
  [1e3, 'k'],
  [1, ''],
  [1e-3, 'm'],
  [1e-6, 'u'],
  [1e-9, 'n'],
  [1e-12, 'p'],
  [1e-15, 'f'],
]

const SPICE_TOKEN = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:meg|[tgkmunpf])?$/i

/** A number in SPICE notation without units: 0.01 -> "10m", 1e6 -> "1meg". */
export function spiceNumber(value: number): string {
  if (value === 0 || !Number.isFinite(value)) return String(value)
  const magnitude = Math.abs(value)
  const [scale, suffix] = SPICE_SUFFIXES.find(([s]) => magnitude >= s * (1 - 1e-12)) ?? [1e-15, 'f']
  return `${Number((value / scale).toPrecision(6))}${suffix}`
}

/** Field text -> SPICE token: quantities are normalised, anything else ({expr}, names) kept. */
export function toSpice(text: string, unit = ''): string {
  if (SPICE_TOKEN.test(text.trim())) return text.trim() // already SPICE: keep what was written
  const value = parseQuantity(text, unit)
  return value === null ? text.trim() : spiceNumber(value)
}

/** Hint under a quantity field: "= 10 ms", or why it is not understood. */
export function quantityHint(text: string, unit = ''): { ok: boolean; hint: string } {
  if (!text.trim()) return { ok: true, hint: '' }
  if (isExpression(text)) return { ok: true, hint: 'parameter expression' }
  const value = parseQuantity(text, unit)
  if (value === null)
    return { ok: false, hint: `not a value (e.g. 10 ms, 1 kHz, 4k7${unit ? '' : ', 1meg'})` }
  const ambiguous = /^[+-]?[\d.]+M$/.test(text.trim()) ? ' – M alone means milli; write MHz or meg' : ''
  return { ok: true, hint: `= ${formatValue(value, unit)}${ambiguous}` }
}
