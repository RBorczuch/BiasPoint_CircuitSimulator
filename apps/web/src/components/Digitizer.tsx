/**
 * Chart picture helpers for tracing datasheet charts (PictureTrace): the chart's frame found on
 * the picture, a curve followed by its colour, a pixel's value on a calibrated axis.
 */
export type DataPoint = [number, number]
type Pixel = [number, number]

interface Axis {
  p1: number | null // pixel position of the first known value
  p2: number | null
  v1: string
  v2: string
  log: boolean
}

import { parseValue } from '@/lib/units'

/** Pixel -> value along one axis (null until the axis is calibrated). */
export function axisValue(axis: Axis, p: number): number | null {
  const v1 = parseValue(axis.v1)
  const v2 = parseValue(axis.v2)
  if (axis.p1 === null || axis.p2 === null || v1 === null || v2 === null || axis.p1 === axis.p2) return null
  const t = (p - axis.p1) / (axis.p2 - axis.p1)
  if (axis.log) {
    if (v1 <= 0 || v2 <= 0) return null
    return 10 ** (Math.log10(v1) + t * (Math.log10(v2) - Math.log10(v1)))
  }
  return v1 + t * (v2 - v1)
}

/** Columns of pixels close to ``color``: one point per column (the median row). */
export function traceColor(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  color: [number, number, number],
  tolerance: number,
  columns: [number, number],
  every: number,
): Pixel[] {
  const out: Pixel[] = []
  const [from, to] = [Math.max(0, Math.min(...columns)), Math.min(width - 1, Math.max(...columns))]
  for (let x = Math.round(from); x <= to; x += every) {
    const rows: number[] = []
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4
      const d =
        Math.abs(data[i] - color[0]) + Math.abs(data[i + 1] - color[1]) + Math.abs(data[i + 2] - color[2])
      if (d <= tolerance && data[i + 3] > 128) rows.push(y)
    }
    if (rows.length) out.push([x, rows[Math.floor(rows.length / 2)]])
  }
  return out
}

export interface Frame {
  left: number
  right: number
  top: number
  bottom: number
}

/** Runs of dark pixels along one line: [start, end] pairs at least `min` long (gaps of two
 *  pixels are bridged, as anti-aliasing and dashed grids leave them). */
function darkRuns(dark: (k: number) => boolean, length: number, min: number): [number, number][] {
  const out: [number, number][] = []
  let start = -1
  let last = -10
  for (let k = 0; k <= length; k++) {
    if (k < length && dark(k)) {
      if (k - last > 3) {
        if (start >= 0 && last - start >= min) out.push([start, last])
        start = k
      }
      last = k
    }
  }
  if (start >= 0 && last - start >= min) out.push([start, last])
  return out
}

/**
 * The chart's frame: the bottom axis (a long dark horizontal line) with the left axis (a
 * vertical one) meeting it at its left end; the frame reaches to the end of both. A full box
 * and bare L-shaped axes are both found, grid lines inside are not taken for the frame (they do
 * not end in its corner). With `inside`, only a frame around that pixel (a page with several
 * charts); else the largest.
 */
export function findFrame(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  inside?: Pixel,
): Frame | null {
  const dark = (x: number, y: number) => {
    const i = (y * width + x) * 4
    return data[i + 3] > 128 && 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2] < 110
  }
  const tol = Math.max(3, Math.round(0.01 * Math.max(width, height)))
  const rows: { y: number; x0: number; x1: number }[] = []
  for (let y = 0; y < height; y++)
    for (const [x0, x1] of darkRuns((x) => dark(x, y), width, 0.15 * width)) rows.push({ y, x0, x1 })
  const cols: { x: number; y0: number; y1: number }[] = []
  for (let x = 0; x < width; x++)
    for (const [y0, y1] of darkRuns((y) => dark(x, y), height, 0.15 * height)) cols.push({ x, y0, y1 })
  let best: Frame | null = null
  for (const h of rows)
    for (const v of cols) {
      if (Math.abs(v.x - h.x0) > tol || Math.abs(v.y1 - h.y) > tol) continue
      const frame = { left: v.x, right: h.x1, top: v.y0, bottom: h.y }
      if (
        inside &&
        !(
          inside[0] > frame.left &&
          inside[0] < frame.right &&
          inside[1] > frame.top &&
          inside[1] < frame.bottom
        )
      )
        continue
      const area = (frame.right - frame.left) * (frame.bottom - frame.top)
      if (!best || area > (best.right - best.left) * (best.bottom - best.top)) best = frame
    }
  if (!best) return null
  // A thick line: its middle, not the edge where the scan met it (a 2 pt axis is 4 px at 2×).
  // Sampled at three places along the edge, the thinnest wins (a grid line or the curve
  // crossing at one of them would look like a thick axis).
  const { left, right, top, bottom } = best
  const along = (a: number, b: number) => [0.3, 0.5, 0.7].map((t) => Math.round(a + t * (b - a)))
  const middle = (at: number, step: number, isDark: (k: number, s: number) => boolean, samples: number[]) => {
    const thickness = (s: number) => {
      if (!isDark(at, s)) return 0
      let k = 0
      while (k < tol && isDark(at + step * (k + 1), s)) k++
      return k
    }
    return at + (step * Math.min(...samples.map(thickness))) / 2
  }
  const inside2 = (x: number, y: number) => x >= 0 && x < width && y >= 0 && y < height && dark(x, y)
  const rows3 = along(top, bottom)
  const cols3 = along(left, right)
  return {
    left: middle(left, 1, (x, y) => inside2(x, y), rows3),
    right: middle(right, -1, (x, y) => inside2(x, y), rows3),
    top: middle(top, 1, (y, x) => inside2(x, y), cols3),
    bottom: middle(bottom, -1, (y, x) => inside2(x, y), cols3),
  }
}
