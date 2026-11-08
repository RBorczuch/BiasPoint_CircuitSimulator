/** Characteristic points typed or pasted as text (datasheets, CSV, measurements). */
import { decimalPoint, parseValue, spiceNumber } from './units'

/** "x y" / "x;y" / "x<tab>y" / "x,y" lines (a CSV header is skipped) -> points, sorted by x.
 *  With ";" or tab separators or spaces, a comma is a decimal comma (1,5k); SI suffixes work,
 *  and a capital M is mega as in datasheets ("1M" = 1 MHz), m is milli. */
export function parsePoints(text: string): [number, number][] {
  const out: [number, number][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = /[;\t]/.test(line)
      ? line.split(/[;\t]/)
      : /\s/.test(line)
        ? line.split(/\s+/)
        : line.split(',')
    if (parts.length < 2) continue
    const x = parseValue(datasheetValue(parts[0]))
    const y = parseValue(datasheetValue(parts[1]))
    if (x !== null && y !== null) out.push([x, y])
  }
  return out.sort((a, b) => a[0] - b[0])
}

/** Points with an optional third column: the weight of each point in a fit (1 when absent; 0 =
 *  shown but not fitted, e.g. a digitizing slip). `weights` is empty when no line has one. */
export function parseWeightedPoints(text: string): { points: [number, number][]; weights: number[] } {
  const rows: [number, number, number | null][] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const parts = /[;\t]/.test(line)
      ? line.split(/[;\t]/)
      : /\s/.test(line)
        ? line.split(/\s+/)
        : line.split(',')
    if (parts.length < 2) continue
    const x = parseValue(datasheetValue(parts[0]))
    const y = parseValue(datasheetValue(parts[1]))
    const w = parts.length > 2 ? parseValue(parts[2]) : null
    if (x !== null && y !== null) rows.push([x, y, w !== null && w >= 0 ? w : null])
  }
  rows.sort((a, b) => a[0] - b[0])
  const weighted = rows.some((r) => r[2] !== null)
  return { points: rows.map((r) => [r[0], r[1]]), weights: weighted ? rows.map((r) => r[2] ?? 1) : [] }
}

/** "1M" / "2.2M" (datasheet mega) -> "1meg"; everything else as SPICE reads it. */
function datasheetValue(text: string): string {
  return decimalPoint(text).replace(/^([+-]?[\d.]+(?:e[+-]?\d+)?)M$/, '$1meg')
}

/** C(V) points typed as ΔC % (as datasheets plot the DC bias) -> capacitance, C·(1 + ΔC/100);
 *  the other columns (bias, weight) and lines without a number are kept. */
export function percentToFarads(text: string, c: number): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const cols = line.trim().split(/[\s;]+/)
      const d = cols.length >= 2 ? parseValue(datasheetValue(cols[1].replace('%', ''))) : null
      if (d === null || line.trim().startsWith('#')) return line
      cols[1] = spiceNumber(Number((c * (1 + d / 100)).toPrecision(4)))
      return cols.join(' ')
    })
    .join('\n')
}

/** The columns of one points line, split as `parsePoints` splits it. */
export function splitPointLine(line: string): string[] {
  const text = line.trim()
  return /[;\t]/.test(text)
    ? text.split(/[;\t]/).map((c) => c.trim())
    : /\s/.test(text)
      ? text.split(/\s+/)
      : text.split(',')
}

export interface PointRow {
  line: number // the line of the text it is on
  cols: string[] // x, y, weight as typed
  x: number | null
  y: number | null
  weight: number // 1 when not given; 0: shown, not fitted
  error: string // why the row is not a point ("" = it is one)
}

/** Every point line of a points text, with its values or why they are not numbers (for the table). */
export function pointRows(text: string): PointRow[] {
  const out: PointRow[] = []
  text.split(/\r?\n/).forEach((raw, line) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#')) return
    const cols = splitPointLine(trimmed)
    const x = cols[0] !== undefined ? parseValue(datasheetValue(cols[0])) : null
    const y = cols[1] !== undefined ? parseValue(datasheetValue(cols[1])) : null
    const w = cols.length > 2 ? parseValue(cols[2]) : null
    const error =
      cols.length < 2
        ? 'two numbers are needed: x and y'
        : x === null
          ? `“${cols[0]}” is not a number`
          : y === null
            ? `“${cols[1]}” is not a number`
            : ''
    out.push({ line, cols, x, y, weight: w !== null && w >= 0 ? w : 1, error })
  })
  return out
}

/** The text with line `line` replaced (or removed with null). */
export function withLine(text: string, line: number, value: string | null): string {
  const lines = text.split(/\r?\n/)
  if (value === null) lines.splice(line, 1)
  else lines[line] = value
  return lines.join('\n')
}

/** The text with a point's line added in the order of x (at the end when the rows are not ordered
 *  up to there): points added on a chart read in order in the table. */
export function insertPoint(text: string, x: number, line: string): string {
  if (!text.trim()) return line
  const after = pointRows(text).find((r) => !r.error && (r.x as number) > x)
  const lines = text.replace(/\s+$/, '').split(/\r?\n/)
  if (after) lines.splice(after.line, 0, line)
  else lines.push(line)
  return lines.join('\n')
}
