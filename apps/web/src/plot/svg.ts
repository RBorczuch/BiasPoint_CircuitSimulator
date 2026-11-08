/**
 * Vector export of the waveform viewer: redraws the visible uPlot panes (axes, ticks, titles,
 * traces) as SVG, using uPlot's computed scales and tick positions so it matches the screen.
 * Colours of the frame can differ from the screen (light export from the dark UI).
 */
import uPlot from 'uplot'
import { DASHES, type TraceDash } from '@/store/plot'

export interface SvgTheme {
  background: string
  axis: string
  grid: string
  text: string
}

export const SVG_THEMES: Record<'light' | 'dark', SvgTheme> = {
  light: { background: '#ffffff', axis: '#52525b', grid: '#e4e4e7', text: '#18181b' },
  dark: { background: '#111113', axis: '#a1a1aa', grid: '#27272a', text: '#e4e4e7' },
}

export interface LegendEntry {
  label: string
  color: string
  dash: TraceDash
}

interface AxisInternals {
  _splits?: number[]
  _values?: string[]
}

const FONT = 'font-family="Inter, Segoe UI, Arial, sans-serif" font-size="11"'
const LEGEND_H = 22
const esc = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const n = (v: number) => (Math.round(v * 10) / 10).toString()

function pane(
  u: uPlot,
  top: number,
  theme: SvgTheme,
  kind: 'line' | 'step' | 'points',
  lineWidth?: number,
): string[] {
  const ratio = uPlot.pxRatio
  const left = u.bbox.left / ratio
  const y0 = top + u.bbox.top / ratio
  const w = u.bbox.width / ratio
  const h = u.bbox.height / ratio
  const out: string[] = []
  const clip = `clip${Math.round(top)}`
  out.push(
    `<clipPath id="${clip}"><rect x="${n(left)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}"/></clipPath>`,
  )

  for (const axis of u.axes) {
    if (axis.show === false || !axis.scale) continue
    const { _splits: splits = [], _values: values = [] } = axis as uPlot.Axis & AxisInternals
    const horizontal = axis.side === 0 || axis.side === 2
    const grid = axis.grid?.show !== false
    splits.forEach((split, i) => {
      if (split == null) return
      const pos = u.valToPos(split, axis.scale as string)
      const label = values[i] ?? ''
      if (horizontal) {
        const x = left + pos
        if (grid)
          out.push(`<line x1="${n(x)}" y1="${n(y0)}" x2="${n(x)}" y2="${n(y0 + h)}" stroke="${theme.grid}"/>`)
        if (label && axis.side === 2)
          out.push(
            `<text x="${n(x)}" y="${n(y0 + h + 14)}" fill="${theme.axis}" ${FONT} text-anchor="middle">${esc(label)}</text>`,
          )
      } else {
        const y = y0 + pos
        if (grid)
          out.push(
            `<line x1="${n(left)}" y1="${n(y)}" x2="${n(left + w)}" y2="${n(y)}" stroke="${theme.grid}"/>`,
          )
        const right = axis.side === 1
        if (label)
          out.push(
            `<text x="${n(right ? left + w + 6 : left - 6)}" y="${n(y)}" fill="${theme.axis}" ${FONT} text-anchor="${right ? 'start' : 'end'}" dominant-baseline="middle">${esc(label)}</text>`,
          )
      }
    })
    if (axis.label) {
      const text = esc(String(axis.label))
      if (axis.side === 2) {
        out.push(
          `<text x="${n(left + w / 2)}" y="${n(y0 + h + 32)}" fill="${theme.text}" ${FONT} text-anchor="middle">${text}</text>`,
        )
      } else if (!horizontal) {
        const x = axis.side === 1 ? left + w + 58 : left - 58
        const rot = axis.side === 1 ? 90 : -90
        out.push(
          `<text transform="translate(${n(x)} ${n(y0 + h / 2)}) rotate(${rot})" fill="${theme.text}" ${FONT} text-anchor="middle">${text}</text>`,
        )
      }
    }
  }
  out.push(
    `<rect x="${n(left)}" y="${n(y0)}" width="${n(w)}" height="${n(h)}" fill="none" stroke="${theme.grid}"/>`,
  )

  u.series.forEach((series, i) => {
    if (i === 0 || series.show === false) return
    const color =
      typeof series.stroke === 'function' ? String(series.stroke(u, i)) : String(series.stroke ?? '#888')
    const [xs, ys, xScale, yScale] =
      (u as uPlot & { mode?: number }).mode === 2
        ? [
            (u.data[i] as unknown as number[][])[0],
            (u.data[i] as unknown as number[][])[1],
            series.facets?.[0].scale ?? 'x',
            series.facets?.[1].scale ?? 'y',
          ]
        : [u.data[0] as number[], u.data[i] as (number | null)[], 'x', series.scale ?? 'y']
    const px = (k: number) => left + u.valToPos(xs[k], xScale)
    const py = (v: number) => y0 + u.valToPos(v, yScale)
    if (kind === 'points') {
      const dots = ys.flatMap((v, k) => (v == null ? [] : [`M${n(px(k))} ${n(py(v))}h0`]))
      out.push(
        `<path d="${dots.join('')}" stroke="${color}" stroke-width="3" stroke-linecap="round" clip-path="url(#${clip})"/>`,
      )
      return
    }
    let d = ''
    let pen = false
    ys.forEach((v, k) => {
      if (v == null || !Number.isFinite(v)) {
        pen = false
        return
      }
      const [x, y] = [px(k), py(v)]
      if (!pen) d += `M${n(x)} ${n(y)}`
      else if (kind === 'step') d += `H${n(x)}V${n(y)}`
      else d += `L${n(x)} ${n(y)}`
      pen = true
    })
    const dash =
      Array.isArray(series.dash) && series.dash.length ? ` stroke-dasharray="${series.dash.join(' ')}"` : ''
    const width = lineWidth ?? (typeof series.width === 'number' ? series.width : 1.5)
    out.push(
      `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}"${dash} stroke-linejoin="round" clip-path="url(#${clip})"/>`,
    )
  })
  return out
}

/** SVG document of stacked panes plus a legend line on top. */
export function plotsToSvg(
  plots: uPlot[],
  legend: LegendEntry[],
  theme: SvgTheme,
  kind: 'line' | 'step' | 'points' = 'line',
  lineWidth?: number, // export style: overrides the screen's line width
): string {
  const width = Math.max(...plots.map((p) => p.width))
  let top = LEGEND_H
  const body: string[] = []
  for (const p of plots) {
    body.push(...pane(p, top, theme, kind, lineWidth))
    top += p.height
  }
  let x = 12
  const items = legend.map((entry) => {
    const dash = DASHES[entry.dash].length ? ` stroke-dasharray="${DASHES[entry.dash].join(' ')}"` : ''
    const item =
      `<line x1="${x}" y1="11" x2="${x + 18}" y2="11" stroke="${entry.color}" stroke-width="2"${dash}/>` +
      `<text x="${x + 22}" y="11" fill="${theme.text}" ${FONT} dominant-baseline="middle">${esc(entry.label)}</text>`
    x += 34 + entry.label.length * 6.5
    return item
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${top}" viewBox="0 0 ${width} ${top}">`,
    `<rect width="100%" height="100%" fill="${theme.background}"/>`,
    ...items,
    ...body,
    '</svg>',
  ].join('\n')
}

/** PNG data URL of an SVG document, ``scale`` times its size (sharp on high-DPI screens). */
export function svgToPng(svg: string, scale = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
    image.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = image.width * scale
      canvas.height = image.height * scale
      const ctx = canvas.getContext('2d')
      if (!ctx) return reject(new Error('no canvas'))
      ctx.scale(scale, scale)
      ctx.drawImage(image, 0, 0)
      URL.revokeObjectURL(url)
      resolve(canvas.toDataURL('image/png'))
    }
    image.onerror = () => reject(new Error('the plot could not be drawn'))
    image.src = url
  })
}
