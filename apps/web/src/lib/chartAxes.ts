/**
 * Axes of the characteristic charts (docs/projekt-kreator.md §5.1): ticks chosen for the room
 * there is, labels measured and kept inside the chart, family labels placed without collisions,
 * values read off a curve. Pure functions: the chart component only draws what they return.
 */

export const FONT = 11 // px, the same at any chart size
export const FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif'

let context: CanvasRenderingContext2D | null | undefined

/** Width of a text in pixels (canvas measure; an estimate where there is no canvas, as in tests). */
export function textWidth(text: string, size = FONT): number {
  if (context === undefined) {
    const jsdom = typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)
    context =
      jsdom || typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  }
  if (!context) return text.length * size * 0.6
  context.font = `${size}px ${FONT_FAMILY}`
  // A little more than measured: the SVG may draw with another font of the same family list.
  return context.measureText(text).width * 1.06 + 1
}

/** The axis range a set of values needs: a 5 % margin (linear) or at least a decade (log). */
export function niceRange(values: number[], log: boolean): [number, number] {
  const finite = values.filter((v) => Number.isFinite(v) && (!log || v > 0))
  if (!finite.length) return log ? [1, 10] : [0, 1]
  let lo = Math.min(...finite)
  let hi = Math.max(...finite)
  if (log) {
    if (hi / lo < 10) {
      const mid = Math.sqrt(hi * lo)
      lo = mid / 4
      hi = mid * 4
    }
    return [lo, hi]
  }
  if (lo === hi) return [lo - 1, hi + 1]
  const margin = (hi - lo) * 0.05
  return [lo > 0 && lo - margin < 0 ? 0 : lo - margin, hi + margin]
}

/** Tick values in [lo, hi], at most `count` of them: 1-2-5 steps (linear) or decades (log; the
 *  2 and 5 steps too when there are few decades, every n-th decade when there are many). */
export function ticks(lo: number, hi: number, log: boolean, count = 6): number[] {
  const most = Math.max(2, Math.floor(count))
  if (log) {
    if (!(lo > 0) || !(hi > lo)) return []
    const first = Math.ceil(Math.log10(lo) - 1e-9)
    const last = Math.floor(Math.log10(hi) + 1e-9)
    const decades: number[] = []
    for (let e = first; e <= last; e++) decades.push(10 ** e)
    if (decades.length > most) {
      const every = Math.ceil(decades.length / most)
      return decades.filter((_v, i) => (last - (first + i)) % every === 0)
    }
    const out = [...decades]
    if (decades.length < 3 && decades.length * 3 <= most + 2)
      for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++)
        for (const m of [2, 5]) {
          const v = m * 10 ** e
          if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v)
        }
    return out.sort((a, b) => a - b)
  }
  const span = hi - lo || Math.abs(hi) || 1
  const raw = span / most
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999) ?? raw
  const out: number[] = []
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9; v += step)
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v)
  return out
}

export interface PlacedLabel {
  value: number
  text: string
  left: number // x of the label's left edge
  center: number // the tick's position
}

/**
 * X tick labels that fit: fewer ticks until the labels do not overlap (8 px apart), each label
 * kept inside [0, width] (the first and last are aligned with the edge instead of centred on it).
 */
export function placeXLabels(
  lo: number,
  hi: number,
  log: boolean,
  at: (v: number) => number,
  format: (v: number) => string,
  width: number,
  plotWidth: number,
): PlacedLabel[] {
  for (let count = Math.max(2, Math.floor(plotWidth / 40)); count >= 2; count--) {
    const placed = ticks(lo, hi, log, count).map((value) => {
      const text = format(value)
      const w = textWidth(text)
      const center = at(value)
      return { value, text, center, left: Math.min(Math.max(center - w / 2, 1), width - w - 2), w }
    })
    const fits = placed.every((p, i) => i === 0 || p.left >= placed[i - 1].left + placed[i - 1].w + 8)
    if (fits || count === 2) return placed.map(({ w: _w, ...p }) => p)
  }
  return []
}

/** Y ticks for a plot `height` px tall (labels 18 px apart at least). */
export function yTicks(lo: number, hi: number, log: boolean, height: number): number[] {
  return ticks(lo, hi, log, Math.max(2, Math.floor(height / 22)))
}

/**
 * Labels at the ends of a family's curves, moved apart vertically (`gap` px) and kept between
 * `top` and `bottom` (baselines). Null when they do not fit: they go to the legend then.
 */
export function placeEndLabels(
  wanted: { key: string; y: number }[],
  top: number,
  bottom: number,
  gap = 11,
): Map<string, number> | null {
  if (!wanted.length) return new Map()
  if ((wanted.length - 1) * gap > bottom - top) return null
  const sorted = [...wanted]
    .sort((a, b) => a.y - b.y)
    .map((w) => ({ ...w, y: Math.min(Math.max(w.y, top), bottom) }))
  for (let i = 1; i < sorted.length; i++) sorted[i].y = Math.max(sorted[i].y, sorted[i - 1].y + gap)
  const over = sorted[sorted.length - 1].y - bottom
  if (over > 0) {
    sorted[sorted.length - 1].y = bottom
    for (let i = sorted.length - 2; i >= 0; i--) sorted[i].y = Math.min(sorted[i].y, sorted[i + 1].y - gap)
  }
  return new Map(sorted.map((s) => [s.key, s.y]))
}

/** The curve's value at x (linear between samples, in log space for log axes); null outside it. */
export function valueAt(xs: number[], ys: number[], x: number, logX: boolean, logY: boolean): number | null {
  const n = Math.min(xs.length, ys.length)
  if (n === 0) return null
  const tx = (v: number) => (logX ? Math.log10(v) : v)
  const target = tx(x)
  for (let i = 0; i < n - 1; i++) {
    const a = tx(xs[i])
    const b = tx(xs[i + 1])
    if ((target - a) * (target - b) <= 0 && Number.isFinite(a) && Number.isFinite(b)) {
      const t = b === a ? 0 : (target - a) / (b - a)
      if (logY && ys[i] > 0 && ys[i + 1] > 0)
        return 10 ** (Math.log10(ys[i]) + t * (Math.log10(ys[i + 1]) - Math.log10(ys[i])))
      return ys[i] + t * (ys[i + 1] - ys[i])
    }
  }
  return null
}

/** Slope between two points, as read on the chart: per decade on log axes ("−1.00 /dec" on a
 *  log-log chart is a value falling ten times per decade). */
export function slope(
  a: [number, number],
  b: [number, number],
  logX: boolean,
  logY: boolean,
): { value: number; per: 'dec' | 'unit'; ratio: boolean } | null {
  const dx = logX ? Math.log10(b[0] / a[0]) : b[0] - a[0]
  if (!Number.isFinite(dx) || dx === 0) return null
  const dy = logY ? Math.log10(b[1] / a[1]) : b[1] - a[1]
  if (!Number.isFinite(dy)) return null
  return { value: dy / dx, per: logX ? 'dec' : 'unit', ratio: logY }
}

/** Zoom a range around `at` by `factor` (< 1: in), in log space for a log axis. */
export function zoomRange(
  lo: number,
  hi: number,
  at: number,
  factor: number,
  log: boolean,
): [number, number] {
  if (log) {
    const [l, h, c] = [Math.log10(lo), Math.log10(hi), Math.log10(at)]
    return [10 ** (c - (c - l) * factor), 10 ** (c + (h - c) * factor)]
  }
  return [at - (at - lo) * factor, at + (hi - at) * factor]
}

/** Shift a range by `fraction` of its span (in log space for a log axis). */
export function panRange(lo: number, hi: number, fraction: number, log: boolean): [number, number] {
  if (log) {
    const d = (Math.log10(hi) - Math.log10(lo)) * fraction
    return [lo * 10 ** d, hi * 10 ** d]
  }
  const d = (hi - lo) * fraction
  return [lo + d, hi + d]
}

/**
 * The x of a curve's resonance: a dip or a peak standing out from both of its ends (5 % of the
 * curve's span; on a log scale when all the values are positive). The one nearest to `near`, or
 * the deepest dip, or the highest peak; null when the curve has none.
 */
export function resonanceOf(xs: number[], ys: number[], near: number | null = null): number | null {
  const points = xs
    .map((x, i) => [x, ys[i]] as const)
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y))
  if (points.length < 3) return null
  const log = points.every(([, y]) => y > 0)
  const v = points.map(([, y]) => (log ? Math.log10(y) : y))
  const margin = 0.05 * (Math.max(...v) - Math.min(...v))
  const [first, last] = [v[0], v[v.length - 1]]
  const dips: number[] = []
  const peaks: number[] = []
  for (let i = 1; i < v.length - 1; i++) {
    if (v[i] <= v[i - 1] && v[i] < v[i + 1] && v[i] < Math.min(first, last) - margin) dips.push(i)
    if (v[i] >= v[i - 1] && v[i] > v[i + 1] && v[i] > Math.max(first, last) + margin) peaks.push(i)
  }
  const all = [...dips, ...peaks]
  if (!all.length) return null
  if (near !== null) {
    const off = (i: number) =>
      Math.abs(log && near > 0 && points[i][0] > 0 ? Math.log(points[i][0] / near) : points[i][0] - near)
    return points[all.reduce((best, i) => (off(i) < off(best) ? i : best))][0]
  }
  const best = dips.length
    ? dips.reduce((m, i) => (v[i] < v[m] ? i : m))
    : peaks.reduce((m, i) => (v[i] > v[m] ? i : m))
  return points[best][0]
}
