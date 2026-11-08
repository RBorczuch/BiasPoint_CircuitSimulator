/**
 * Markers on a plot (graf.md §18.2): points of a trace with their values, put by hand (Alt+click
 * on a trace) or found automatically (peak, minimum, -3 dB, 0 dB, harmonics). Drawn by a uPlot
 * plugin on the canvas, so they are also in exported pictures made from it.
 */
import type uPlot from 'uplot'

export interface PlotMarker {
  id: string // M1, M2…
  pane: string // the plot it belongs to (a pane number, "db" or "phase")
  series: string // the trace (its id)
  x: number
  y: number
  label: string // "1.2 ms, 3.3 V"
  color: string
  unit: string // of y (a delta between markers of one unit)
}

type Column = ArrayLike<number | null | undefined>

function finite(ys: Column): number[] {
  const idx: number[] = []
  for (let i = 0; i < ys.length; i++) if (ys[i] != null && Number.isFinite(ys[i] as number)) idx.push(i)
  return idx
}

/** Index of the largest (or smallest) value. */
export function extremeIndex(ys: Column, largest = true): number | null {
  let best: number | null = null
  for (const i of finite(ys)) {
    const v = ys[i] as number
    if (best === null || (largest ? v > (ys[best] as number) : v < (ys[best] as number))) best = i
  }
  return best
}

/** x where the curve crosses ``level`` (interpolated), in order. */
export function crossings(xs: Column, ys: Column, level: number): number[] {
  const out: number[] = []
  const idx = finite(ys)
  for (let k = 1; k < idx.length; k++) {
    const [i, j] = [idx[k - 1], idx[k]]
    const [y0, y1] = [ys[i] as number, ys[j] as number]
    const [x0, x1] = [xs[i] as number, xs[j] as number]
    if ((y0 - level) * (y1 - level) < 0 || (y1 === level && y0 !== level))
      out.push(y1 === y0 ? x1 : x0 + ((level - y0) * (x1 - x0)) / (y1 - y0))
  }
  return out
}

/** Indices of the ``count`` highest local maxima (harmonics of a spectrum), by x. */
export function topPeaks(ys: Column, count: number): number[] {
  const peaks: number[] = []
  for (let i = 1; i < ys.length - 1; i++) {
    const [a, b, c] = [ys[i - 1], ys[i], ys[i + 1]]
    if (a != null && b != null && c != null && b > a && b >= c) peaks.push(i)
  }
  return peaks
    .sort((i, j) => (ys[j] as number) - (ys[i] as number))
    .slice(0, count)
    .sort((i, j) => i - j)
}

/** Linear interpolation of y at x (the samples' x ascending). */
export function valueAt(xs: Column, ys: Column, x: number): number | null {
  for (let i = 1; i < xs.length; i++) {
    const [x0, x1] = [xs[i - 1] as number, xs[i] as number]
    if ((x0 <= x && x <= x1) || (x1 <= x && x <= x0)) {
      const [y0, y1] = [ys[i - 1], ys[i]]
      if (y0 == null || y1 == null) return null
      return x1 === x0 ? y0 : y0 + ((x - x0) * (y1 - y0)) / (x1 - x0)
    }
  }
  return null
}

/** The trace point nearest to a click (in pixels): [series index, sample index]. */
export function nearestPoint(u: uPlot, left: number, top: number): [number, number] | null {
  const i = u.posToIdx(left)
  let best: [number, number] | null = null
  let distance = Number.POSITIVE_INFINITY
  u.series.forEach((s, k) => {
    if (k === 0 || s.show === false || !s.scale) return
    // A few samples either side: the curve may pass closer next to the click.
    for (let j = Math.max(0, i - 3); j <= Math.min(u.data[0].length - 1, i + 3); j++) {
      const v = u.data[k]?.[j]
      if (v == null) continue
      const d = Math.hypot(u.valToPos(u.data[0][j] as number, 'x') - left, u.valToPos(v, s.scale) - top)
      if (d < distance) [distance, best] = [d, [k, j]]
    }
  })
  return distance <= 24 ? best : null
}

/** Draws the markers of one plot: a ring on the trace and its name with the values. */
export function markersPlugin(
  pane: string,
  get: () => PlotMarker[],
  scaleOf: (series: string) => string | undefined,
  background: string,
  onPick?: (seriesIndex: number, index: number) => void,
): uPlot.Plugin {
  return {
    hooks: {
      draw: (u) => {
        const ctx = u.ctx
        const ratio = devicePixelRatio
        ctx.save()
        ctx.font = `${10 * ratio}px Inter, "Segoe UI", sans-serif`
        ctx.textAlign = 'left' // (uPlot leaves the axes' alignment set)
        ctx.textBaseline = 'alphabetic'
        const taken: [number, number, number, number][] = [] // labels drawn: x, y, w, h
        for (const m of get()) {
          const scale = m.pane === pane ? scaleOf(m.series) : undefined
          if (!scale || !u.scales[scale]) continue
          const px = u.valToPos(m.x, 'x', true)
          const py = u.valToPos(m.y, scale, true)
          const { left, top, width, height } = u.bbox
          if (px < left || px > left + width || py < top || py > top + height) continue
          ctx.strokeStyle = m.color
          ctx.lineWidth = 2 * ratio
          ctx.beginPath()
          ctx.arc(px, py, 4 * ratio, 0, 2 * Math.PI)
          ctx.stroke()
          const text = `${m.id}  ${m.label}`
          const w = ctx.measureText(text).width + 6 * ratio
          const h = 14 * ratio
          let lx = px + 7 * ratio
          if (lx + w > left + width) lx = px - 7 * ratio - w
          let ly = Math.max(top, py - h - 4 * ratio)
          // Markers close together: their labels go one under another.
          const overlaps = () =>
            taken.some(([x, y, tw, th]) => lx < x + tw && x < lx + w && ly < y + th && y < ly + h)
          for (let k = 0; k < 8 && overlaps(); k++) ly += h + 2 * ratio
          taken.push([lx, ly, w, h])
          ctx.fillStyle = background
          ctx.fillRect(lx, ly, w, h)
          ctx.fillStyle = m.color
          ctx.fillText(text, lx + 3 * ratio, ly + 10.5 * ratio)
        }
        ctx.restore()
      },
      init: (u) => {
        if (!onPick) return
        u.over.addEventListener('click', (e) => {
          if (!e.altKey) return
          e.stopPropagation()
          const hit = nearestPoint(u, e.offsetX, e.offsetY)
          if (hit) onPick(hit[0], hit[1])
        })
      },
    },
  }
}
