/**
 * Tracing a datasheet chart picture (docs/projekt-modele.md §2): the chart's axes are a frame
 * on the picture whose edges carry known values, each axis linear or logarithmic. Pixels and
 * values convert both ways; a line drawn along the curve becomes points spread evenly in the
 * axis' scale (per decade on a log axis).
 */
import { parseValue } from '@/lib/units'

export type Pixel = [number, number]

/** One axis of the picture: pixel positions of its two edges (left / right, bottom / top) and
 *  the values typed at them. */
export interface TraceAxis {
  a: number
  b: number
  va: string
  vb: string
  log: boolean
}

function ends(axis: TraceAxis): [number, number] | null {
  const va = parseValue(axis.va)
  const vb = parseValue(axis.vb)
  if (va === null || vb === null || va === vb || axis.a === axis.b) return null
  if (axis.log && (va <= 0 || vb <= 0)) return null
  return axis.log ? [Math.log10(va), Math.log10(vb)] : [va, vb]
}

/** Pixel -> value along the axis (null until both edge values are known). */
export function toValue(axis: TraceAxis, p: number): number | null {
  const e = ends(axis)
  if (!e) return null
  const v = e[0] + ((p - axis.a) / (axis.b - axis.a)) * (e[1] - e[0])
  return axis.log ? 10 ** v : v
}

/** Value -> pixel along the axis (null when uncalibrated, or not positive on a log axis). */
export function toPixel(axis: TraceAxis, v: number): number | null {
  const e = ends(axis)
  if (!e || !Number.isFinite(v) || (axis.log && v <= 0)) return null
  const u = axis.log ? Math.log10(v) : v
  return axis.a + ((u - e[0]) / (e[1] - e[0])) * (axis.b - axis.a)
}

/** The edge values span a decade or more on a linear axis: it is probably logarithmic. */
export function looksLog(axis: TraceAxis): boolean {
  const va = parseValue(axis.va)
  const vb = parseValue(axis.vb)
  return (
    !axis.log && va !== null && vb !== null && va > 0 && vb > 0 && Math.max(va, vb) / Math.min(va, vb) >= 10
  )
}

/**
 * A line drawn along the curve as points evenly spaced across it (in pixels, which are even in
 * the axis' own scale): about `perFrame` points over the whole frame width, at least 2. The line
 * is read as a function of x (where it doubles back, the mean height at each x).
 */
export function resample(stroke: Pixel[], frameWidth: number, perFrame = 40): Pixel[] {
  if (stroke.length < 2) return stroke.map((p) => [p[0], p[1]])
  const sorted = [...stroke].sort((p, q) => p[0] - q[0])
  // Points at (almost) the same x merge into one at their mean height.
  const merged: Pixel[] = []
  for (const p of sorted) {
    const last = merged.at(-1)
    if (last && Math.abs(p[0] - last[0]) < 0.5) last[1] = (last[1] + p[1]) / 2
    else merged.push([p[0], p[1]])
  }
  const x0 = merged[0][0]
  const x1 = merged[merged.length - 1][0]
  if (x1 - x0 < 1) return [merged[0]]
  const n = Math.max(2, Math.min(200, Math.round(((x1 - x0) / Math.max(frameWidth, 1)) * perFrame) + 1))
  const out: Pixel[] = []
  let k = 0
  for (let i = 0; i < n; i++) {
    const x = x0 + ((x1 - x0) * i) / (n - 1)
    while (k < merged.length - 2 && merged[k + 1][0] < x) k++
    const [ax, ay] = merged[k]
    const [bx, by] = merged[k + 1]
    const t = bx === ax ? 0 : (x - ax) / (bx - ax)
    out.push([x, ay + t * (by - ay)])
  }
  return out
}

/** Points with those between `from` and `to` (pixel x) replaced by `added`: drawing over a part
 *  of the curve again redraws that part. */
export function replaceBetween(points: Pixel[], added: Pixel[], from: number, to: number): Pixel[] {
  const [lo, hi] = [Math.min(from, to), Math.max(from, to)]
  return [...points.filter((p) => p[0] < lo || p[0] > hi), ...added].sort((p, q) => p[0] - q[0])
}
