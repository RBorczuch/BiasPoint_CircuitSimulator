/** Chart of a Plot node: its input signals with titled SI axes (preview and full screen). */
import { useEffect, useMemo, useRef } from 'react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import type { PlotSeries } from '@/api/types'
import { useTheme } from '@/lib/theme'
import { formatValue } from '@/lib/units'
import { crosshairPlugin } from '@/plot/crosshair'
import { axisPrefix, axisTitle, tickLabels } from '@/plot/format'
import { scaledMove, syncOnEnter } from '@/plot/scaled'
import { xyPath } from '@/plot/xy'
import { PALETTES, usePlot } from '@/store/plot'
import { onRight, paneGroups, type RefLine } from './plotLayout'

const AXIS = {
  dark: { stroke: '#a1a1aa', grid: '#27272a' },
  light: { stroke: '#52525b', grid: '#e4e4e7' },
}
const FONT = '11px Inter, "Segoe UI", sans-serif'

export interface PlotOptions {
  kind: string
  x_log: string
  y_log: boolean
  complex: string
  panels?: string // one, per unit, per signal, custom
  groups?: string // custom panels: "V(*); I(*)"
  right?: string // traces on a second Y axis: "I(*)"
  lines?: RefLine[] // reference lines and limits
}

const REF_COLOR = '#f59e0b'

/** Scale of a trace: its unit, or its unit on the right-hand axis. */
const scaleKey = (unit: string, right: boolean) => `${unit || '-'}${right ? '|r' : ''}`
const unitOfKey = (key: string) => key.replace(/\|r$/, '').replace(/^-$/, '')

/** Real y values of a series for the chosen view of complex (AC) data. */
export function values(s: PlotSeries, complex: string): { y: (number | null)[]; unit: string } {
  if (s.re && s.im) {
    const im = s.im
    if (complex === 'phase')
      return { y: s.re.map((re, i) => (Math.atan2(im[i], re) * 180) / Math.PI), unit: '°' }
    const mag = s.re.map((re, i) => Math.hypot(re, im[i]))
    if (complex === 'mag') return { y: mag, unit: s.unit }
    return { y: mag.map((m) => 20 * Math.log10(Math.max(m, 1e-15))), unit: 'dB' }
  }
  return { y: s.max ?? [], unit: s.unit }
}

export function PlotView({
  series,
  options,
  width,
  height,
  onReady,
}: {
  series: PlotSeries[]
  options: PlotOptions
  width: number
  height: number
  onReady?: (plot: uPlot | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const readout = useRef<HTMLDivElement>(null)
  const theme = useTheme((s) => s.theme)
  const palette = usePlot((s) => s.palette)

  useEffect(() => {
    const element = host.current
    if (!element || !series.length || width < 50 || height < 50) return
    const colors = AXIS[theme]
    const strokes = seriesColors(series, PALETTES[palette].colors)
    const prepared = series.map((s) => ({ s, ...values(s, options.complex) }))
    const joined = uPlot.join(prepared.map((p) => [p.s.x, p.y] as uPlot.AlignedData))
    const first = series[0]
    const isAc = series.some((s) => s.re)
    const xLog = options.x_log === 'log' || (options.x_log === 'auto' && isAc)
    const keyOf = (p: (typeof prepared)[number]) => scaleKey(p.unit, onRight(p.s, options.right ?? ''))
    const keys = [...new Set(prepared.map(keyOf))]
    const lines = options.lines ?? []
    // The y lines of a scale: those of its unit (a line without a unit: the first scale).
    const linesOf = (key: string) =>
      lines.filter((l) => l.axis === 'y' && (l.unit ? l.unit === unitOfKey(key) : key === keys[0]))
    const positive = (joined[0] as number[]).find((v) => v > 0) ?? 1e-12

    const axis = (
      scale: string,
      side: number,
      unit: string,
      title: (prefix: string) => string,
      log = false,
    ): uPlot.Axis => ({
      scale,
      side,
      stroke: colors.stroke,
      font: FONT,
      labelFont: FONT,
      grid: { stroke: colors.grid, width: 1, show: side !== 1 },
      ticks: { stroke: colors.grid },
      label: title(''),
      labelSize: 18,
      size: side === 2 ? 34 : 54,
      values: (u, splits, i) => {
        if (log) return splits.map((v) => (v == null ? '' : formatValue(v, '', 3)))
        const { scale: k, prefix } = axisPrefix(
          Math.max(0, ...splits.filter((v) => v != null).map(Math.abs)),
          unit,
        )
        u.axes[i].label = title(prefix)
        return tickLabels(splits, k)
      },
    })
    const yScale = (key: string): uPlot.Scale => {
      if (options.y_log) return { distr: 3, log: 10 }
      const marks = linesOf(key).map((l) => l.value)
      if (!marks.length) return { auto: true }
      // Reference lines and limits stay in view.
      return {
        auto: true,
        range: (_u, min, max) =>
          uPlot.rangeNum(Math.min(min, ...marks), Math.max(max, ...marks), 0.1, true) as uPlot.Range.MinMax,
      }
    }
    const path =
      options.kind === 'step'
        ? { paths: uPlot.paths.stepped?.({ align: 1 }) }
        : options.kind === 'points'
          ? { paths: () => null, points: { show: true, size: 4, space: 0 } }
          : {}
    const xName = first.x_name === 'time' ? 'Time' : first.x_name === 'frequency' ? 'Frequency' : first.x_name
    const plot = new uPlot(
      {
        width,
        height,
        legend: { show: false },
        cursor: { drag: { x: true, y: false }, move: scaledMove },
        plugins: [crosshairPlugin((i, v) => formatValue(v, prepared[i - 1]?.unit ?? '', 4))],
        hooks: {
          ready: [syncOnEnter],
          draw: [
            (u) => {
              if (!lines.length) return
              const ctx = u.ctx
              const { left, top, width: w, height: h } = u.bbox
              ctx.save()
              ctx.strokeStyle = REF_COLOR
              ctx.fillStyle = REF_COLOR
              ctx.lineWidth = Math.max(1, devicePixelRatio)
              ctx.setLineDash([6 * devicePixelRatio, 4 * devicePixelRatio])
              ctx.font = `${10 * devicePixelRatio}px Inter, "Segoe UI", sans-serif`
              ctx.textAlign = 'left' // (uPlot leaves the axes' alignment set)
              ctx.textBaseline = 'alphabetic'
              for (const line of lines) {
                if (line.axis === 'x') {
                  const px = u.valToPos(line.value, 'x', true)
                  if (px < left || px > left + w) continue
                  ctx.beginPath()
                  ctx.moveTo(px, top)
                  ctx.lineTo(px, top + h)
                  ctx.stroke()
                  ctx.fillText(line.label, px + 3 * devicePixelRatio, top + 11 * devicePixelRatio)
                  continue
                }
                for (const key of keys.filter((k) => linesOf(k).includes(line))) {
                  const py = u.valToPos(line.value, key, true)
                  if (py < top || py > top + h) continue
                  ctx.beginPath()
                  ctx.moveTo(left, py)
                  ctx.lineTo(left + w, py)
                  ctx.stroke()
                  const text = line.label
                  ctx.fillText(
                    text,
                    left + w - ctx.measureText(text).width - 3 * devicePixelRatio,
                    py - 3 * devicePixelRatio,
                  )
                }
              }
              ctx.restore()
            },
          ],
          // Values under the cursor: x and each curve, with units (written to the DOM directly,
          // no React render per mouse move).
          setCursor: [
            (u) => {
              const out = readout.current
              if (!out) return
              const i = u.cursor.idx
              if (i == null) {
                out.textContent = '\u00a0'
                return
              }
              const x = u.data[0][i]
              const parts = [`${xName} ${formatValue(x, first.x_unit, 4)}`]
              prepared.forEach((p, k) => {
                const y = u.data[k + 1]?.[i]
                if (y != null) parts.push(`${p.s.name} ${formatValue(y, p.unit, 4)}`)
              })
              out.textContent = parts.join('   ')
            },
          ],
        },
        scales: {
          x: xLog
            ? {
                distr: 3,
                log: 10,
                range: (_u, min, max) => [Math.max(min, positive), Math.max(max, positive * 10)],
              }
            : { time: false },
          ...Object.fromEntries(keys.map((key) => [key, yScale(key)])),
        },
        axes: [
          axis('x', 2, first.x_unit, (prefix) => axisTitle([xName], first.x_unit, prefix), xLog),
          ...keys.map((key, i) =>
            axis(key, i === 0 ? 3 : 1, unitOfKey(key), (prefix) =>
              axisTitle(
                prepared.filter((p) => keyOf(p) === key).map((p) => p.s.name),
                unitOfKey(key),
                prefix,
              ),
            ),
          ),
        ],
        series: [
          {},
          ...prepared.map((p, i) => ({
            label: p.s.name,
            scale: keyOf(p),
            stroke: strokes[i],
            width: 1.5,
            spanGaps: true,
            ...path,
          })),
        ],
      },
      joined,
      element,
    )
    onReady?.(plot)
    return () => {
      onReady?.(null)
      plot.destroy()
    }
  }, [series, options, width, height, theme, palette, onReady])

  return (
    <div>
      <div ref={host} />
      <div
        ref={readout}
        className="truncate px-1 font-mono text-[10px] text-muted-foreground"
        data-testid="plot-readout"
      >
        {'\u00a0'}
      </div>
    </div>
  )
}

export function legendOf(series: PlotSeries[]): { label: string; color: string }[] {
  const colors = seriesColors(series, PALETTES[usePlot.getState().palette].colors)
  return series.map((s, i) => ({ label: s.name, color: colors[i] }))
}

const base = (s: PlotSeries) => (s.family ? s.name.slice(0, s.name.length - s.family.length - 3) : s.name)

/** One palette colour per signal; members of a sweep family get light → dark shades of it. */
export function seriesColors(series: PlotSeries[], palette: string[]): string[] {
  const groups = [...new Set(series.map(base))]
  return series.map((s) => {
    const g = groups.indexOf(base(s))
    const color = palette[g % palette.length]
    if (!s.family) return color
    const members = series.filter((o) => base(o) === base(s))
    const t = members.length > 1 ? members.indexOf(s) / (members.length - 1) : 0.5
    return shade(color, 0.45 - 0.8 * t) // +0.45 lighter … -0.35 darker
  })
}

function shade(hex: string, amount: number): string {
  const n = Number.parseInt(hex.slice(1), 16)
  const target = amount > 0 ? 255 : 0
  const k = Math.abs(amount)
  const mix = (c: number) => Math.round(c + (target - c) * k)
  const [r, g, b] = [mix((n >> 16) & 255), mix((n >> 8) & 255), mix(n & 255)]
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`
}

/** Names (and sweep points) of the plotted series with their colours. */
export function PlotLegend({ series, max = 8 }: { series: PlotSeries[]; max?: number }) {
  const items = legendOf(series)
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-1 font-mono text-[10px] text-muted-foreground">
      {items.slice(0, max).map((item) => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="inline-block h-0.5 w-3" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
      {items.length > max && <span>+{items.length - max} more</span>}
    </div>
  )
}

/** Nyquist plot: imaginary against real part of complex (AC) signals. */
export function NyquistView({
  series,
  width,
  height,
  onReady,
}: {
  series: PlotSeries[]
  width: number
  height: number
  onReady?: (plot: uPlot | null) => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const theme = useTheme((s) => s.theme)
  const palette = usePlot((s) => s.palette)
  useEffect(() => {
    const element = host.current
    const complex = series.filter((s) => s.re && s.im)
    if (!element || !complex.length || width < 50 || height < 50) return
    const colors = AXIS[theme]
    const strokes = seriesColors(complex, PALETTES[palette].colors)
    const unit = complex[0].unit
    const axis = (scale: string, side: number, title: string): uPlot.Axis => ({
      scale,
      side,
      stroke: colors.stroke,
      font: FONT,
      labelFont: FONT,
      grid: { stroke: colors.grid, width: 1 },
      ticks: { stroke: colors.grid },
      label: title,
      labelSize: 18,
      size: side === 2 ? 34 : 54,
      values: (_u, splits) => splits.map((v) => (v == null ? '' : formatValue(v, '', 3))),
    })
    const plot = new uPlot(
      {
        mode: 2,
        width,
        height,
        legend: { show: false },
        cursor: { drag: { x: true, y: true }, points: { show: false }, move: scaledMove },
        hooks: { ready: [syncOnEnter] },
        scales: { x: { auto: true }, y: { auto: true } },
        axes: [axis('x', 2, `Re ${unit ? `[${unit}]` : ''}`), axis('y', 3, `Im ${unit ? `[${unit}]` : ''}`)],
        series: [
          {},
          ...complex.map((s, i) => ({
            label: s.name,
            stroke: strokes[i],
            width: 1.5,
            facets: [
              { scale: 'x', auto: true },
              { scale: 'y', auto: true },
            ],
            paths: xyPath,
          })),
        ],
      } as uPlot.Options,
      [null, ...complex.map((s) => [s.re, s.im])] as unknown as uPlot.AlignedData,
      element,
    )
    onReady?.(plot)
    return () => {
      onReady?.(null)
      plot.destroy()
    }
  }, [series, width, height, theme, palette, onReady])
  return <div ref={host} />
}

/** A Plot node's chart: plain, Bode (magnitude above phase) or Nyquist, by its options. */
export function PlotFigure({
  series,
  options,
  width,
  height,
  onReady,
}: {
  series: PlotSeries[]
  options: PlotOptions
  width: number
  height: number
  onReady?: (plots: uPlot[]) => void
}) {
  const panes = useRef<(uPlot | null)[]>([])
  const notify = useRef(onReady)
  notify.current = onReady
  // Stable callbacks (one per panel, kept): a new function per render would rebuild the charts.
  const callbacks = useRef<((plot: uPlot | null) => void)[]>([])
  const ready = (index: number) => {
    callbacks.current[index] ??= (plot: uPlot | null) => {
      panes.current[index] = plot
      notify.current?.(panes.current.filter((p): p is uPlot => p !== null))
    }
    return callbacks.current[index]
  }
  const groups = useMemo(
    () =>
      paneGroups(
        series,
        options.panels ?? 'one',
        options.groups ?? '',
        (s) => values(s, options.complex).unit,
      ),
    [series, options.panels, options.groups, options.complex],
  )
  const complex = series.some((s) => s.re)
  if (complex && options.complex === 'nyquist')
    return <NyquistView series={series} width={width} height={height} onReady={ready(0)} />
  if (complex && options.complex === 'bode') {
    const half = Math.floor(height / 2)
    return (
      <div>
        <PlotView
          series={series}
          options={{ ...options, complex: 'db' }}
          width={width}
          height={half}
          onReady={ready(0)}
        />
        <PlotView
          series={series}
          options={{ ...options, complex: 'phase' }}
          width={width}
          height={half}
          onReady={ready(1)}
        />
      </div>
    )
  }
  if (groups.length > 1) {
    const each = Math.floor(height / groups.length)
    return (
      <div>
        {groups.map((group, i) => (
          <PlotView
            key={group.map((s) => s.name).join('|')}
            series={group}
            options={options}
            width={width}
            height={each}
            onReady={ready(i)}
          />
        ))}
      </div>
    )
  }
  return <PlotView series={series} options={options} width={width} height={height} onReady={ready(0)} />
}
