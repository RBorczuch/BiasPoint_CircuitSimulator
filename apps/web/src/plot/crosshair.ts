/**
 * Crosshairs (graf.md §18.1): where the vertical cursor crosses a trace, a horizontal line with
 * the value at the right edge, in every pane the cursor is synchronised with. DOM elements in
 * the plot's overlay moved on each cursor move (no redraw of the canvas).
 */
import type uPlot from 'uplot'

/** Traces beyond this many get no line (the plot would be striped). */
const MOST = 8

/** ``format`` gives the label of a series' value, or null for no line (a previous run, an envelope). */
export function crosshairPlugin(format: (seriesIndex: number, value: number) => string | null): uPlot.Plugin {
  let lines: HTMLDivElement[] = []
  return {
    hooks: {
      init: (u) => {
        lines = u.series.slice(1).map((s) => {
          const line = document.createElement('div')
          line.className = 'bpt-crosshair'
          line.dataset.testid = 'plot-crosshair'
          Object.assign(line.style, {
            position: 'absolute',
            left: '0',
            right: '0',
            top: '0',
            height: '0',
            borderTop: `1px dashed ${typeof s.stroke === 'string' ? s.stroke : 'currentColor'}`,
            opacity: '0.7',
            pointerEvents: 'none',
            display: 'none',
          })
          const label = document.createElement('span')
          Object.assign(label.style, {
            position: 'absolute',
            right: '2px',
            bottom: '1px',
            font: '10px Inter, "Segoe UI", sans-serif',
            color: typeof s.stroke === 'string' ? s.stroke : 'currentColor',
            whiteSpace: 'nowrap',
          })
          line.appendChild(label)
          u.over.appendChild(line)
          return line
        })
      },
      setCursor: (u) => {
        const i = u.cursor.idx
        const shown = u.series.slice(1).filter((s) => s.show !== false).length
        u.series.slice(1).forEach((s, k) => {
          const line = lines[k]
          if (!line) return
          const v = i == null || shown > MOST || s.show === false ? null : u.data[k + 1]?.[i]
          if (v == null || !s.scale) {
            line.style.display = 'none'
            return
          }
          const top = u.valToPos(v, s.scale)
          if (!Number.isFinite(top) || top < 0 || top > u.over.clientHeight) {
            line.style.display = 'none'
            return
          }
          const text = format(k + 1, v)
          if (text === null) {
            line.style.display = 'none'
            return
          }
          line.style.display = ''
          line.style.transform = `translateY(${top}px)`
          ;(line.firstChild as HTMLSpanElement).textContent = text
        })
      },
    },
  }
}
