/**
 * How a Plot node lays out its traces (graf.md §15 item 3): panels, a second Y axis and
 * reference lines. Pure functions of the node's parameters, shared by the preview, the
 * full-screen viewer and the tests.
 */
import type { PlotSeries } from '@/api/types'
import { parseQuantity, parseValue } from '@/lib/units'

/** A glob ("V(*)", "I(R?)") as a case-insensitive test of a whole name. */
export function globTest(pattern: string): (name: string) => boolean {
  const body = pattern
    .trim()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  const re = new RegExp(`^${body}$`, 'i')
  return (name) => re.test(name)
}

/** The name a trace is matched by: without the sweep point of a family member. */
export function baseName(s: PlotSeries): string {
  return s.family ? s.name.slice(0, s.name.length - s.family.length - 3) : s.name
}

function patternsOf(text: string): ((name: string) => boolean)[] {
  return text
    .split('|')
    .map((p) => p.trim())
    .filter(Boolean)
    .map(globTest)
}

/**
 * Traces split into panels, top to bottom: one panel, a panel per unit, per signal, or as the
 * user grouped them ("V(*); I(*)": panels separated by ';', patterns in one by '|'). A trace
 * no group matches goes to the last panel.
 */
export function paneGroups(
  series: PlotSeries[],
  mode: string,
  groups: string,
  unitOf: (s: PlotSeries) => string,
) {
  if (mode === 'per unit') {
    const units = [...new Set(series.map(unitOf))]
    return units.map((u) => series.filter((s) => unitOf(s) === u))
  }
  if (mode === 'per signal') {
    const names = [...new Set(series.map(baseName))]
    return names.map((n) => series.filter((s) => baseName(s) === n))
  }
  if (mode === 'custom') {
    const tests = groups
      .split(';')
      .map(patternsOf)
      .filter((t) => t.length)
    if (!tests.length) return [series]
    const panes: PlotSeries[][] = tests.map(() => [])
    for (const s of series) {
      const k = tests.findIndex((t) => t.some((test) => test(baseName(s))))
      panes[k < 0 ? panes.length - 1 : k].push(s)
    }
    return panes.filter((p) => p.length)
  }
  return [series]
}

/** Is this trace drawn against the right-hand axis ("V(in)|I(*)")? */
export function onRight(s: PlotSeries, right: string): boolean {
  return patternsOf(right).some((test) => test(baseName(s)))
}

export interface RefLine {
  axis: 'x' | 'y'
  value: number
  unit: string // empty: any panel's first scale
  label: string
}

const UNIT_AT_END = /^(.*?)\s*(V|A|W|Ω|Hz|dB|s|°|%)?$/

/** "3.3 V; 1.65; x = 2 ms" -> lines; parts that are not values are left out. */
export function parseLines(text: string): RefLine[] {
  const out: RefLine[] = []
  for (const raw of text.split(';')) {
    const part = raw.trim()
    if (!part) continue
    const vertical = /^x\s*=\s*/i.exec(part)
    const body = vertical ? part.slice(vertical[0].length) : part.replace(/^y\s*=\s*/i, '')
    const match = UNIT_AT_END.exec(body)
    const unit = match?.[2] ?? ''
    const value = unit ? (parseQuantity(body, unit) ?? parseValue(body)) : parseValue(body)
    if (value === null || !Number.isFinite(value)) continue
    out.push({ axis: vertical ? 'x' : 'y', value, unit, label: part })
  }
  return out
}
