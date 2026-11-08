/**
 * Cursor of the uPlot charts (analysis graph plots, waveform viewer).
 *
 * * Scale: inside an analysis graph node React Flow zooms the plot with a CSS transform. uPlot
 *   measures the mouse in screen pixels against its own layout pixels, so the cursor drifted
 *   from the mouse (10 px at 83 % zoom, 40 px zoomed out) and selections landed beside the
 *   dragged range. Positions are divided by the real scale; the plot's position is measured
 *   again each time the mouse enters it.
 * * Snap: the crosshair goes through the curve, not through the mouse – vertically to the
 *   sample under the mouse, horizontally to the value of the curve nearest to the mouse
 *   (the horizontal line used to sit at the mouse height, beside the point).
 */
import type uPlot from 'uplot'

/** Rendered size / layout size of the plot area (1 without a transform). */
function scaleOf(u: uPlot): number {
  const width = u.over.offsetWidth
  return width ? u.over.getBoundingClientRect().width / width || 1 : 1
}

/** Mouse position in the plot's pixels, snapped to the nearest curve's sample. */
export const scaledMove: uPlot.Cursor.MousePosRefiner = (u, left, top) => {
  const k = scaleOf(u)
  const [x, y] = [left / k, top / k]
  // XY charts (mode 2, Nyquist) have no sample index: no snapping.
  if (x < 0 || y < 0 || (u as unknown as { mode?: number }).mode === 2) return [x, y]
  const xs = u.data[0]
  const i = u.posToIdx(x)
  if (i == null || i < 0 || i >= xs.length) return [x, y]
  let best: number | null = null
  for (let s = 1; s < u.series.length; s++) {
    const series = u.series[s]
    const value = u.data[s]?.[i]
    if (!series.show || value == null || !series.scale) continue
    const pos = u.valToPos(value, series.scale)
    if (Number.isFinite(pos) && (best === null || Math.abs(pos - y) < Math.abs(best - y))) best = pos
  }
  if (best === null) return [x, y]
  return [u.valToPos(xs[i] as number, 'x'), best]
}

/** Hook: re-measure the plot's position when the mouse enters (the node may have moved). */
export function syncOnEnter(u: uPlot): void {
  u.over.addEventListener('mouseenter', () => u.syncRect())
}

const pressedAt = new WeakMap<uPlot, [number, number]>()

/** Hook (init): remember where the mouse button went down on the plot. */
export function trackPress(u: uPlot): void {
  u.over.addEventListener('mousedown', (e) => pressedAt.set(u, [e.clientX, e.clientY]), true)
}

/**
 * ``cursor.drag.click``: uPlot swallows the click that ends a drag, and it takes a moved cursor
 * for a drag. With the cursor snapped to the curve (``scaledMove``) every click looked like one,
 * so clicks (cursors A/B, markers) never arrived. Only a real drag of the mouse is swallowed.
 */
export function dragClick(u: uPlot, e: MouseEvent): void {
  const at = pressedAt.get(u)
  if (at && Math.hypot(e.clientX - at[0], e.clientY - at[1]) <= 3) return
  e.stopPropagation()
  e.stopImmediatePropagation()
}
