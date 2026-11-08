/** Axis text for plots: SI prefix per axis ("Time [ms]"), tick labels, signal grouping. */

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

/** Units that never get a prefix (dB, degrees) or have none. */
const PLAIN_UNITS = new Set(['', 'dB', '°', '%'])

/** Prefix for an axis whose ticks reach `maxAbs`: 0.0042 s -> ms (scale 1e-3). */
export function axisPrefix(maxAbs: number, unit: string): { scale: number; prefix: string } {
  if (PLAIN_UNITS.has(unit) || !Number.isFinite(maxAbs) || maxAbs === 0) return { scale: 1, prefix: '' }
  const [scale, prefix] = PREFIXES.find(([s]) => maxAbs >= s * (1 - 1e-9)) ?? PREFIXES[PREFIXES.length - 1]
  return { scale, prefix }
}

/** Tick labels for evenly spaced splits, already divided by the axis scale. */
export function tickLabels(splits: (number | null)[], scale: number): string[] {
  const values = splits.filter((v): v is number => v != null).map((v) => v / scale)
  const step = values.length > 1 ? Math.abs(values[1] - values[0]) : Math.abs(values[0] ?? 1)
  let decimals = 0 // fewest decimals that show the step exactly (0.25 -> 2, 0.5 -> 1)
  while (
    decimals < 6 &&
    step > 0 &&
    Math.abs(step * 10 ** decimals - Math.round(step * 10 ** decimals)) > 1e-6
  )
    decimals++
  return splits.map((v) => {
    if (v == null) return ''
    const text = (v / scale).toFixed(decimals)
    return /^-0\.?0*$/.test(text) ? text.slice(1) : text
  })
}

const QUANTITY: Record<string, string> = {
  V: 'Voltage',
  A: 'Current',
  W: 'Power',
  s: 'Time',
  Hz: 'Frequency',
  dB: 'Magnitude',
  '°': 'Phase',
}

/** "V(out) [mV]" for a single signal, "Voltage [mV]" for several, "Time [µs]" for the x axis. */
export function axisTitle(names: string[], unit: string, prefix: string): string {
  const what = names.length === 1 ? names[0] : (QUANTITY[unit] ?? (names.join(', ') || 'Value'))
  const full = `${prefix}${unit}`
  return full ? `${what} [${full}]` : what
}

/** Name of the swept quantity of a run: x axis title without the unit. */
export function scaleName(scale: string | null | undefined, source?: string): string {
  if (scale === 'time') return 'Time'
  if (scale === 'frequency') return 'Frequency'
  if (source?.toUpperCase() === 'TEMP') return 'Temperature'
  return source || 'Sweep'
}

export interface SignalGroup {
  title: string
  signals: string[]
}

const AUTO_NET = /^V\(N\d{3,}\)$/i
const INTERNAL = /^V\(_/

/** Signals of a run grouped for the signal browser: named nets first, then currents. */
export function groupSignals(names: string[], scale: string | null | undefined): SignalGroup[] {
  const groups: SignalGroup[] = [
    { title: 'Nets', signals: [] },
    { title: 'Currents', signals: [] },
    { title: 'Unnamed nets', signals: [] },
    { title: 'Internal nodes', signals: [] },
    { title: 'Other', signals: [] },
  ]
  for (const name of names) {
    if (name.toLowerCase() === scale?.toLowerCase()) continue
    const index = INTERNAL.test(name)
      ? 3
      : AUTO_NET.test(name)
        ? 2
        : /^V\(/i.test(name)
          ? 0
          : /^I\(/i.test(name)
            ? 1
            : 4
    groups[index].signals.push(name)
  }
  const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  for (const group of groups) group.signals.sort(natural.compare)
  return groups.filter((g) => g.signals.length > 0)
}
