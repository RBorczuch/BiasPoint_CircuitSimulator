/**
 * Waveform viewer (uPlot).
 *
 * Transient / DC: one or more panes sharing the x axis (volts left, amps right in each pane).
 * AC: Bode plot (magnitude in dB + phase) on a log frequency axis. XY: any trace against
 * another one. Axes are titled with the quantity and one SI prefix per axis ("Time [ms]").
 * Zooming (drag or wheel) re-queries decimated data for the visible range, so large runs stay
 * fast. The previous run of the same analysis can be overlaid as dashed lines for comparison.
 * Cursors A/B are placed by clicking (Shift for B) and can be dragged.
 */
import {
  Download,
  GitCompareArrows,
  MapPin,
  Maximize,
  Maximize2,
  Minimize,
  MoreHorizontal,
  Plus,
  Settings2,
  Trash2,
  Workflow,
  X,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import uPlot from 'uplot'
import { crosshairPlugin } from '@/plot/crosshair'
import { crossings, extremeIndex, markersPlugin, type PlotMarker, topPeaks } from '@/plot/markers'
import { dragClick, scaledMove, trackPress } from '@/plot/scaled'
import 'uplot/dist/uPlot.min.css'
import { ApiError, apiPost } from '@/api/client'
import type { QueryResult, RunFamily } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { quickGraph } from '@/graph/templates'
import { revealSignal } from '@/lib/reveal'
import { useTheme } from '@/lib/theme'
import { formatValue, signalUnit } from '@/lib/units'
import { OpTable } from '@/panels/OpTable'
import { axisPrefix, axisTitle, scaleName, tickLabels } from '@/plot/format'
import { SignalPicker } from '@/plot/SignalPicker'
import { plotsToSvg, SVG_THEMES, svgToPng } from '@/plot/svg'
import { xyPath } from '@/plot/xy'
import { prompt } from '@/store/dialogs'
import { useGraph } from '@/store/graph'
import { type ChartKind, DASHES, PALETTES, type PaletteName, type TraceDash, usePlot } from '@/store/plot'
import { useProject } from '@/store/project'
import { type Trace, useSimulation } from '@/store/simulation'

type Column = (number | null)[]

interface LineSeries {
  trace: Trace
  ghost: boolean // previous run (dashed)
  values: Column
  envelope?: Column // min when decimated (max is `values`)
  member?: { label: string; color: string } // one curve of a family (DC sweep, second source)
}

/** Name of a plotted line: the trace, and the family member it is ("V(c) · IB=10 µA"). */
const lineName = (l: LineSeries) => (l.member ? `${l.trace.expr} · ${l.member.label}` : l.trace.expr)

/** "#rrggbb" with an opacity, for the curves of a family drawn in one trace colour. */
function withAlpha(color: string, alpha: number): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return color
  return `${color}${Math.round(alpha * 255)
    .toString(16)
    .padStart(2, '0')}`
}

interface AcSeries {
  trace: Trace
  ghost: boolean
  db: Column
  phase: Column
}

interface PlotData {
  x: number[]
  lines: LineSeries[]
  ac: AcSeries[]
  family?: { name: string; members: { label: string; color: string }[] } // legend
}

const AXIS = {
  dark: { stroke: '#a1a1aa', grid: '#27272a', title: '#e4e4e7' },
  light: { stroke: '#52525b', grid: '#e4e4e7', title: '#18181b' },
}
const FONT = '11px Inter, "Segoe UI", sans-serif'
const KINDS: [ChartKind, string][] = [
  ['line', 'Line'],
  ['step', 'Steps'],
  ['points', 'Points'],
]
const DASH_NAMES: [TraceDash, string][] = [
  ['solid', 'Solid'],
  ['dash', 'Dashed'],
  ['dot', 'Dotted'],
  ['dashdot', 'Dash-dot'],
]

function interpolate(xs: number[], ys: Column, x: number): number | null {
  if (!xs.length) return null
  let i = xs.findIndex((v) => v >= x)
  if (i < 0) i = xs.length - 1
  for (let j = i; j >= 0; j--)
    if (ys[j] != null && xs[j] <= x) {
      const k = ys.findIndex((v, n) => n > j && v != null)
      if (k < 0) return ys[j]
      const t = (x - xs[j]) / (xs[k] - xs[j] || 1)
      return (ys[j] as number) + t * ((ys[k] as number) - (ys[j] as number))
    } // prettier-ignore
  return ys.find((v) => v != null) ?? null
}

function download(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

/** Query one run; returns its own x axis and per-expression columns. */
async function queryRun(
  runId: string,
  traces: Trace[],
  pixels: number,
  range: [number, number] | null,
): Promise<{
  x: number[]
  lines: Map<string, [Column, Column?]>
  ac: Map<string, [Column, Column]>
  members: Map<string, Column[]>
  family?: RunFamily
}> {
  const result = await apiPost<QueryResult>(`/api/runs/${runId}/query`, {
    signals: traces.map((t) => t.expr),
    pixels,
    x_min: range?.[0] ?? null,
    x_max: range?.[1] ?? null,
  })
  const lines = new Map<string, [Column, Column?]>()
  const ac = new Map<string, [Column, Column]>()
  const members = new Map<string, Column[]>()
  for (const trace of traces) {
    const s = result.series[trace.expr]
    if (!s) continue
    if (s.members) {
      members.set(
        trace.id,
        s.members.map((m) => m.max),
      )
    } else if (s.re && s.im) {
      const im = s.im
      ac.set(trace.id, [
        s.re.map((re, i) => 20 * Math.log10(Math.max(Math.hypot(re, im[i]), 1e-15))),
        s.re.map((re, i) => (Math.atan2(im[i], re) * 180) / Math.PI),
      ])
    } else if (s.max && s.min) {
      const raw = s.max.every((v, i) => v === s.min?.[i])
      lines.set(trace.id, [s.max, raw ? undefined : s.min])
    }
  }
  return { x: result.x, lines, ac, members, family: result.family }
}

export function WaveformPanel() {
  const {
    meta,
    traces,
    removeTrace,
    toggleTrace,
    clearTraces,
    addTrace,
    setTracePane,
    setTraceStyle,
    recolorTraces,
    compare,
    setCompare,
    previousRunId,
    opValues,
  } = useSimulation() // prettier-ignore
  const options = usePlot()
  const theme = useTheme((s) => s.theme)
  const host = useRef<HTMLDivElement>(null)
  const plots = useRef<uPlot[]>([])
  const [size, setSize] = useState({ width: 600, height: 300 })
  const [range, setRange] = useState<[number, number] | null>(null)
  const [data, setData] = useState<PlotData | null>(null)
  const [markers, setMarkers] = useState<{ a: number | null; b: number | null }>({ a: null, b: null })
  const [hover, setHover] = useState<{ x: number; values: Record<string, string> } | null>(null)
  const [picker, setPicker] = useState(false)
  const [full, setFull] = useState(false)
  const markersRef = useRef(markers)
  markersRef.current = markers
  const [pins, setPins] = useState<PlotMarker[]>([])
  const pinsRef = useRef(pins)
  pinsRef.current = pins
  const pinRef = useRef((_pane: string, _trace: Trace, _x: number, _y: number, _unit: string) => {})

  const runId = meta?.status === 'ok' && meta.scale ? meta.run_id : null
  const isAc = meta?.analysis.kind === 'ac'
  const xyTrace = !isAc && options.xy ? traces.find((t) => t.expr === options.xy) : undefined
  // Plain signals the run does not have (e.g. a current only saved in transient) are skipped.
  const missing = useMemo(() => {
    const names = new Set(meta?.signals.map((sig) => sig.name.toLowerCase()))
    return new Set(
      traces
        .filter((t) => /^[VI]\([^(),]*\)$/i.test(t.expr) && !names.has(t.expr.toLowerCase()))
        .map((t) => t.id),
    )
  }, [traces, meta])
  const visible = useMemo(
    () => traces.filter((t) => (!t.hidden || t.id === xyTrace?.id) && !missing.has(t.id)),
    [traces, xyTrace?.id, missing],
  )
  const xUnit =
    meta?.scale === 'time'
      ? 's'
      : meta?.scale === 'frequency'
        ? 'Hz'
        : (meta?.signals.find((s) => s.name === meta.scale)?.unit ?? '')
  const xName = scaleName(meta?.scale, (meta?.analysis as { source?: string } | undefined)?.source)
  const xLog = options.xLog ?? isAc
  const ghostRun = compare && previousRunId && previousRunId !== runId && !xyTrace ? previousRunId : null
  const paneCount = Math.max(1, ...visible.map((t) => t.pane + 1))
  const colors = PALETTES[options.palette].colors

  useEffect(() => {
    const element = host.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      setSize({ width: Math.floor(entry.contentRect.width), height: Math.floor(entry.contentRect.height) })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false)
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full])

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset only when the run changes
  useEffect(() => {
    setRange(null)
    setMarkers({ a: null, b: null })
    setPins([])
  }, [runId])

  // Fetch (decimated) data for the current run, and the previous one when comparing.
  useEffect(() => {
    if (!runId || visible.length === 0) {
      setData(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        // XY plots pair samples by index: ask for (almost) raw data, not min/max envelopes.
        const pixels = xyTrace ? 20_000 : Math.max(200, size.width)
        const zoom = xyTrace ? null : range
        const current = await queryRun(runId, visible, pixels, zoom)
        const previous = ghostRun ? await queryRun(ghostRun, visible, pixels, zoom).catch(() => null) : null
        if (cancelled) return
        // Align both runs on one x axis (uPlot.join fills gaps with null).
        const tables: uPlot.AlignedData[] = []
        const layout: {
          trace: Trace
          ghost: boolean
          kind: 'line' | 'ac'
          cols: number
          member?: { label: string; color: string }
        }[] = []
        const family = current.family
        const label = (v: number) => `${family?.name}=${formatValue(v, family?.unit ?? '', 3)}`
        const familyTraces = visible.filter((t) => current.members.has(t.id))
        for (const [run, ghost] of [
          [current, false],
          [previous, true],
        ] as const) {
          if (!run) continue
          const cols: Column[] = []
          for (const trace of visible) {
            const line = run.lines.get(trace.id)
            const acCols = run.ac.get(trace.id)
            const curves = run.members.get(trace.id)
            if (curves && family) {
              // One trace: the palette tells the curves apart; several: shades of each trace.
              curves.forEach((col, k) => {
                const color =
                  familyTraces.length === 1
                    ? colors[k % colors.length]
                    : withAlpha(trace.color, 1 - (0.65 * k) / Math.max(1, curves.length - 1))
                cols.push(col)
                layout.push({
                  trace,
                  ghost,
                  kind: 'line',
                  cols: 1,
                  member: { label: label(family.values[k]), color },
                })
              })
            } else if (line) {
              cols.push(line[0], ...(line[1] ? [line[1]] : []))
              layout.push({ trace, ghost, kind: 'line', cols: line[1] ? 2 : 1 })
            } else if (acCols) {
              cols.push(...acCols)
              layout.push({ trace, ghost, kind: 'ac', cols: 2 })
            }
          }
          tables.push([run.x, ...cols] as uPlot.AlignedData)
        }
        const joined = tables.length > 1 ? uPlot.join(tables) : tables[0]
        const plot: PlotData = { x: joined[0] as number[], lines: [], ac: [] }
        if (family && familyTraces.length) {
          const first = familyTraces[0]
          plot.family = {
            name: family.name,
            members: layout.flatMap((e) => (e.trace === first && !e.ghost && e.member ? [e.member] : [])),
          }
        }
        let c = 1
        for (const entry of layout) {
          const columns = joined.slice(c, c + entry.cols) as Column[]
          c += entry.cols
          if (entry.kind === 'line') {
            plot.lines.push({
              trace: entry.trace,
              ghost: entry.ghost,
              values: columns[0],
              envelope: columns[1],
              member: entry.member,
            })
          } else {
            plot.ac.push({ trace: entry.trace, ghost: entry.ghost, db: columns[0], phase: columns[1] })
          }
        }
        setData(plot)
      } catch (error) {
        if (!cancelled) toast.error(error instanceof ApiError ? error.message : String(error))
      }
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [runId, visible, range, size.width, ghostRun, xyTrace, colors])

  // Build the uPlot instance(s).
  useEffect(() => {
    for (const p of plots.current) p.destroy()
    plots.current = []
    const labelBackground = theme === 'dark' ? 'rgba(17,17,19,0.85)' : 'rgba(255,255,255,0.9)'
    const pin = (...args: Parameters<typeof pinRef.current>) => pinRef.current(...args)
    const element = host.current
    if (!element || !data || data.x.length === 0) return
    const palette = AXIS[theme]
    const { kind, width: lineWidth } = options

    /** Axis titled "<what> [<prefix><unit>]"; the prefix follows the visible range. */
    const axis = (
      scale: string,
      side: 0 | 1,
      unit: string,
      title: (prefix: string) => string,
      opts: { show?: boolean; log?: boolean } = {},
    ): uPlot.Axis => {
      const show = opts.show ?? true
      const x = scale === 'x'
      return {
        scale,
        side: x ? 2 : side === 0 ? 3 : 1,
        stroke: palette.stroke,
        font: FONT,
        labelFont: FONT,
        grid: { stroke: palette.grid, width: 1 },
        ticks: { stroke: palette.grid },
        label: show ? title('') : undefined,
        labelSize: show ? 18 : 0,
        values: (u, splits, axisIdx) => {
          if (!show) return splits.map(() => '')
          if (opts.log) {
            u.axes[axisIdx].label = title('')
            return splits.map((v) => (v == null ? '' : formatValue(v, '', 3)))
          }
          const maxAbs = Math.max(0, ...splits.filter((v) => v != null).map(Math.abs))
          const { scale: k, prefix } = axisPrefix(maxAbs, unit)
          u.axes[axisIdx].label = title(prefix)
          return tickLabels(splits, k)
        },
        size: x && !show ? 8 : x ? 34 : 56,
      }
    }
    const xAxis = (show: boolean) =>
      axis(
        'x',
        0,
        xUnit,
        (prefix) => options.xTitle || axisTitle([xName], xUnit, prefix),
        { show, log: xLog }, // prettier-ignore
      )

    // Cursors A/B: click places A (Shift: B), dragging a cursor line moves it.
    const markerPlugin: uPlot.Plugin = {
      hooks: {
        draw: (u) => {
          const ctx = u.ctx
          for (const [name, value] of [
            ['A', markersRef.current.a],
            ['B', markersRef.current.b],
          ] as const) {
            if (value === null) continue
            const left = u.valToPos(value, 'x', true)
            ctx.save()
            ctx.strokeStyle = palette.stroke
            ctx.setLineDash([4, 4])
            ctx.beginPath()
            ctx.moveTo(left, u.bbox.top)
            ctx.lineTo(left, u.bbox.top + u.bbox.height)
            ctx.stroke()
            ctx.fillStyle = palette.stroke
            ctx.fillText(name, left + 4, u.bbox.top + 12)
            ctx.restore()
          }
        },
        ready: (u) => {
          let dragging: 'a' | 'b' | null = null
          const near = (e: MouseEvent) => {
            for (const key of ['a', 'b'] as const) {
              const v = markersRef.current[key]
              if (v !== null && Math.abs(u.valToPos(v, 'x') - e.offsetX) < 6) return key
            }
            return null
          }
          u.over.addEventListener(
            'mousedown',
            (e) => {
              dragging = near(e)
              if (dragging) e.stopPropagation() // do not start a zoom selection
            },
            true,
          )
          u.over.addEventListener('mousemove', (e) => {
            u.over.style.cursor = dragging || near(e) ? 'ew-resize' : ''
            if (!dragging) return
            const x = u.posToVal(e.offsetX, 'x')
            const key = dragging
            setMarkers((m) => ({ ...m, [key]: x }))
          })
          window.addEventListener('mouseup', () => {
            dragging = null
          })
          u.over.addEventListener('click', (e) => {
            if (near(e) || e.altKey) return // Alt+click: a marker
            const x = u.posToVal(e.offsetX, 'x')
            setMarkers((m) => (e.shiftKey ? { ...m, b: x } : { ...m, a: x }))
          })
          // Wheel: zoom x around the pointer; Shift+wheel pans.
          u.over.addEventListener(
            'wheel',
            (e) => {
              e.preventDefault()
              const { min, max } = u.scales.x
              if (min == null || max == null) return
              const f = (v: number) => (xLog ? Math.log10(v) : v)
              const g = (v: number) => (xLog ? 10 ** v : v)
              const [lo, hi, at] = [f(min), f(max), f(u.posToVal(e.offsetX, 'x'))]
              let next: [number, number]
              if (e.shiftKey) {
                const shift = (hi - lo) * 0.1 * Math.sign(e.deltaY)
                next = [lo + shift, hi + shift]
              } else {
                const k = Math.exp(e.deltaY * 0.0015)
                next = [at - (at - lo) * k, at + (hi - at) * k]
              }
              for (const p of plots.current) p.setScale('x', { min: g(next[0]), max: g(next[1]) })
            },
            { passive: false },
          )
        },
      },
    }

    const onCursor = (u: uPlot) => {
      const i = u.cursor.idx
      if (i == null) {
        setHover(null)
        return
      }
      const values: Record<string, string> = {}
      for (const line of data.lines) {
        const v = line.values[i]
        if (!line.ghost && v != null) values[line.trace.id] = formatValue(v, signalUnit(line.trace.expr))
      }
      for (const s of data.ac) {
        const [db, ph] = [s.db[i], s.phase[i]]
        if (!s.ghost && db != null && ph != null)
          values[s.trace.id] = `${db.toFixed(2)} dB ∠ ${ph.toFixed(1)}°`
      }
      setHover({ x: data.x[i], values })
    }
    const onScale = (u: uPlot, key: string) => {
      if (key !== 'x' || isAc) return
      const { min, max } = u.scales.x
      if (min == null || max == null) return
      // uPlot also calls this while building the plot: only react to real changes.
      const span = Math.abs(max - min) || 1
      const same = (r: [number, number] | null) =>
        r !== null && Math.abs(r[0] - min) < span * 1e-6 && Math.abs(r[1] - max) < span * 1e-6
      const full: [number, number] = [data.x[0], data.x[data.x.length - 1]]
      if (range === null ? same(full) || (min <= full[0] && max >= full[1]) : same(range)) return
      setRange([min, max])
    }
    const width = size.width
    /** Line look: trace colour, width and dash; previous run thin and dashed. */
    const look = (trace: Trace, ghost: boolean): Partial<uPlot.Series> => {
      const base: Partial<uPlot.Series> = ghost
        ? { stroke: trace.color, dash: [6, 4], width: 1 }
        : { stroke: trace.color, dash: DASHES[trace.dash ?? 'solid'], width: trace.width ?? lineWidth }
      if (kind === 'step') return { ...base, paths: uPlot.paths.stepped?.({ align: 1 }) }
      if (kind === 'points')
        return { ...base, paths: () => null, points: { show: true, size: 4, fill: trace.color, space: 0 } }
      return base
    }
    const yScale: uPlot.Scale = options.yLog ? { distr: 3, log: 10 } : { auto: true }
    // A log axis cannot start at t = 0: begin at the first positive sample.
    const positive = data.x.find((v) => v > 0) ?? 1e-12
    const xScale: uPlot.Scale = xLog
      ? {
          distr: 3,
          log: 10,
          range: (_u, min, max) => [Math.max(min, positive), Math.max(max, positive * 10)],
        }
      : { time: false }

    if (isAc) {
      if (!data.ac.length) return // data of the previous (non-AC) run, new query pending
      const height = Math.max(120, Math.floor(size.height / 2))
      const names = data.ac.filter((s) => !s.ghost).map((s) => s.trace.expr)
      const make = (unit: string, pick: 'db' | 'phase', bottom: boolean) =>
        new uPlot(
          {
            width,
            height,
            legend: { show: false },
            cursor: {
              sync: { key: 'bpt-plot' },
              drag: { x: true, y: false, click: dragClick },
              move: scaledMove,
            },
            scales: { x: xScale, y: { auto: true } },
            axes: [
              xAxis(bottom),
              axis('y', 0, unit, () =>
                pick === 'db' ? options.yTitle || axisTitle(names, 'dB', '') : axisTitle([], '°', ''),
              ),
            ],
            series: [
              {},
              ...data.ac.map((s) => ({ label: s.trace.expr, spanGaps: true, ...look(s.trace, s.ghost) })),
            ],
            hooks: { init: [trackPress], setCursor: [onCursor] },
            plugins: [
              markerPlugin,
              crosshairPlugin((i, v) =>
                data.ac[i - 1]?.ghost ? null : pick === 'db' ? `${v.toFixed(2)} dB` : `${v.toFixed(1)}°`,
              ),
              markersPlugin(
                pick,
                () => pinsRef.current,
                () => 'y',
                labelBackground,
                (k, j) => {
                  const s = data.ac[k - 1]
                  const y = s?.[pick][j]
                  if (s && !s.ghost && y != null) pin(pick, s.trace, data.x[j], y, pick === 'db' ? 'dB' : '°')
                },
              ),
            ],
          },
          [data.x, ...data.ac.map((s) => s[pick])] as uPlot.AlignedData,
          element,
        )
      plots.current = [make('dB', 'db', false), make('°', 'phase', true)]
      return
    }

    if (xyTrace) {
      // XY: every other visible trace against the chosen one (current run only).
      const xs = data.lines.find((l) => l.trace.id === xyTrace.id && !l.ghost)?.values
      const ys = data.lines.filter((l) => !l.ghost && l.trace.id !== xyTrace.id && !l.trace.hidden)
      if (!xs || !ys.length) return
      const xyUnit = signalUnit(xyTrace.expr)
      const units = [...new Set(ys.map((l) => signalUnit(l.trace.expr) || 'V'))]
      plots.current.push(
        new uPlot(
          {
            mode: 2,
            width,
            height: Math.max(140, size.height),
            legend: { show: false },
            cursor: { drag: { x: true, y: true }, points: { show: false }, move: scaledMove },
            scales: {
              x: { auto: true, ...(xLog ? xScale : {}) },
              ...Object.fromEntries(units.map((u) => [u, { auto: true, ...yScale }])),
            },
            axes: [
              axis('x', 0, xyUnit, (prefix) => options.xTitle || axisTitle([xyTrace.expr], xyUnit, prefix), {
                log: xLog,
              }),
              ...units.map((unit, i) => {
                const names = ys
                  .filter((l) => (signalUnit(l.trace.expr) || 'V') === unit)
                  .map((l) => l.trace.expr)
                const a = axis(unit, i === 0 ? 0 : 1, unit, (prefix) =>
                  i === 0 && options.yTitle ? options.yTitle : axisTitle(names, unit, prefix),
                )
                return i === 0 ? a : { ...a, grid: { show: false } }
              }),
            ],
            series: [
              {},
              ...ys.map((l) => ({
                label: l.trace.expr,
                facets: [
                  { scale: 'x', auto: true },
                  { scale: signalUnit(l.trace.expr) || 'V', auto: true },
                ],
                ...look(l.trace, false),
                ...(kind === 'points' ? {} : { paths: xyPath }),
              })),
            ],
          } as uPlot.Options,
          [null, ...ys.map((l) => [xs, l.values])] as unknown as uPlot.AlignedData,
          element,
        ),
      )
      return
    }

    // Transient / DC: one plot per pane, shared x range and synchronized cursor.
    const lines = data.lines.filter((l) => !l.trace.hidden)
    const panes = [...new Set(lines.map((l) => l.trace.pane))].sort((a, b) => a - b)
    const height = Math.max(100, Math.floor(size.height / Math.max(1, panes.length)))
    panes.forEach((pane, index) => {
      const paneLines = lines.filter((l) => l.trace.pane === pane)
      const units = paneLines.map((l) => signalUnit(l.trace.expr))
      const hasA = units.includes('A')
      const series: uPlot.Series[] = [{}]
      const columns: Column[] = [data.x]
      const labels: (string | null)[] = [] // unit of each series' crosshair, null: none
      const owners: (LineSeries | null)[] = [] // the line of each series (null: an envelope)
      for (const [i, line] of paneLines.entries()) {
        labels.push(line.ghost ? null : units[i])
        owners.push(line)
        const scale = units[i] === 'A' ? 'A' : 'V'
        series.push({
          scale,
          label: lineName(line),
          spanGaps: true,
          ...look(line.trace, line.ghost),
          ...(line.member ? { stroke: line.member.color } : {}),
        })
        columns.push(line.values)
        if (line.envelope) {
          series.push({
            scale,
            label: `${line.trace.expr} min`,
            spanGaps: true,
            ...look(line.trace, line.ghost),
            width: 1,
          })
          columns.push(line.envelope)
          labels.push(null)
          owners.push(null)
        }
      }
      const named = (unit: string) =>
        paneLines.filter((l, i) => !l.ghost && (units[i] === 'A') === (unit === 'A')).map((l) => l.trace.expr)
      const leftUnit = units.includes('V') || !hasA ? (units.find((u) => u !== 'A') ?? 'V') : 'A'
      const bottom = index === panes.length - 1
      plots.current.push(
        new uPlot(
          {
            width,
            height,
            legend: { show: false },
            cursor: {
              sync: { key: 'bpt-plot' },
              drag: { x: true, y: false, click: dragClick },
              move: scaledMove,
            },
            scales: {
              x: { ...xScale, ...(range ? { min: range[0], max: range[1] } : {}) },
              V: yScale,
              A: yScale,
            },
            axes: [
              xAxis(bottom),
              axis(leftUnit === 'A' ? 'A' : 'V', 0, leftUnit, (prefix) =>
                index === 0 && options.yTitle ? options.yTitle : axisTitle(named(leftUnit), leftUnit, prefix),
              ),
              ...(hasA && leftUnit !== 'A'
                ? [
                    {
                      ...axis('A', 1, 'A', (prefix) => axisTitle(named('A'), 'A', prefix)),
                      grid: { show: false },
                    },
                  ]
                : []),
            ],
            series,
            hooks: { init: [trackPress], setScale: [onScale], setCursor: [onCursor] },
            plugins: [
              markerPlugin,
              crosshairPlugin((i, v) => {
                const unit = labels[i - 1]
                return unit === null || unit === undefined ? null : formatValue(v, unit, 4)
              }),
              markersPlugin(
                String(pane),
                () => pinsRef.current,
                (id) => {
                  const k = paneLines.findIndex((l) => l.trace.id === id)
                  return k < 0 ? undefined : units[k] === 'A' ? 'A' : 'V'
                },
                labelBackground,
                (k, j) => {
                  const line = owners[k - 1]
                  const y = line?.values[j]
                  if (line && !line.ghost && y != null)
                    pin(String(pane), line.trace, data.x[j], y, signalUnit(line.trace.expr))
                },
              ),
            ],
          },
          columns as uPlot.AlignedData,
          element,
        ),
      )
    })
  }, [data, size, theme, isAc, xLog, xUnit, xName, range, options, xyTrace])

  // Redraw cursor lines and markers without rebuilding the plots.
  // biome-ignore lint/correctness/useExhaustiveDependencies: redraw when markers move
  useEffect(() => {
    for (const p of plots.current) p.redraw(false)
  }, [markers, pins])

  /** Automatic markers on every shown trace of the current run. */
  const autoMarkers = (what: 'peak' | 'min' | '-3dB' | '0dB' | 'harmonics') => {
    if (!data) return
    const found: [string, Trace, number, number, string][] = []
    for (const line of data.lines.filter((l) => !l.ghost && !l.trace.hidden && !l.member)) {
      const unit = signalUnit(line.trace.expr)
      const idx =
        what === 'harmonics'
          ? topPeaks(line.values, 5)
          : what === 'peak' || what === 'min'
            ? [extremeIndex(line.values, what === 'peak')].filter((i): i is number => i !== null)
            : []
      for (const i of idx)
        found.push([String(line.trace.pane), line.trace, data.x[i], line.values[i] as number, unit])
    }
    for (const s of data.ac.filter((a) => !a.ghost)) {
      if (what === '-3dB' || what === '0dB') {
        const first = s.db.find((v) => v != null) ?? 0
        const level = what === '0dB' ? 0 : first - 3.0103
        const x = crossings(data.x, s.db, level)[0]
        if (x !== undefined) found.push(['db', s.trace, x, level, 'dB'])
        continue
      }
      const idx =
        what === 'harmonics'
          ? topPeaks(s.db, 5)
          : [extremeIndex(s.db, what === 'peak')].filter((i): i is number => i !== null)
      for (const i of idx) found.push(['db', s.trace, data.x[i], s.db[i] as number, 'dB'])
    }
    if (!found.length) {
      toast.info(what === '-3dB' || what === '0dB' ? 'No trace crosses that level' : 'Nothing found')
      return
    }
    for (const [pane, trace, x, y, unit] of found) pin(pane, trace, x, y, unit)
  }

  /** A marker on a trace: M1, M2… with its x and y. */
  const pin = (pane: string, trace: Trace, x: number, y: number, unit: string) =>
    setPins((current) => {
      const n = Math.max(0, ...current.map((m) => Number(m.id.slice(1)))) + 1
      const label = `${formatValue(x, xUnit, 4)}, ${formatValue(y, unit, 4)}`
      return [...current, { id: `M${n}`, pane, series: trace.id, x, y, label, color: trace.color, unit }]
    })

  pinRef.current = pin

  const readout = useMemo(() => {
    if (!data || xyTrace || (markers.a === null && markers.b === null)) return null
    const rows = [
      ...data.lines
        .filter((l) => !l.ghost && !l.trace.hidden)
        .map((l) => ({ trace: l.trace, name: lineName(l), ys: l.values, unit: signalUnit(l.trace.expr) })),
      ...data.ac
        .filter((s) => !s.ghost)
        .map((s) => ({ trace: s.trace, name: s.trace.expr, ys: s.db, unit: 'dB' })),
    ]
    return rows.map((row) => {
      const a = markers.a !== null ? interpolate(data.x, row.ys, markers.a) : null
      const b = markers.b !== null ? interpolate(data.x, row.ys, markers.b) : null
      return { ...row, a, b, delta: a !== null && b !== null ? b - a : null }
    })
  }, [data, markers, xyTrace])

  const exportPng = () => {
    // Stack all panes into one image.
    const canvases = plots.current.map((p) => p.ctx.canvas)
    if (!canvases.length) return
    const out = document.createElement('canvas')
    out.width = Math.max(...canvases.map((c) => c.width))
    out.height = canvases.reduce((h, c) => h + c.height, 0)
    const ctx = out.getContext('2d')
    if (ctx) {
      ctx.fillStyle = theme === 'dark' ? '#111113' : '#ffffff'
      ctx.fillRect(0, 0, out.width, out.height)
    }
    let y = 0
    for (const c of canvases) {
      ctx?.drawImage(c, 0, y)
      y += c.height
    }
    download(out.toDataURL('image/png'), 'plot.png')
  }
  const exportSvg = (svgTheme: 'light' | 'dark') => {
    if (!plots.current.length) return
    const legend = traces
      .filter((t) => !t.hidden && !missing.has(t.id) && t.id !== xyTrace?.id)
      .map((t) => ({ label: t.expr, color: t.color, dash: t.dash ?? 'solid' }))
    const svg = plotsToSvg(plots.current, legend, SVG_THEMES[svgTheme], options.kind)
    download(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), 'plot.svg')
  }
  /** PNG for documents: drawn from the light vector picture, not the dark screen. */
  const exportPngLight = async () => {
    if (!plots.current.length) return
    const legend = traces
      .filter((t) => !t.hidden && !missing.has(t.id) && t.id !== xyTrace?.id)
      .map((t) => ({ label: t.expr, color: t.color, dash: t.dash ?? 'solid' }))
    download(await svgToPng(plotsToSvg(plots.current, legend, SVG_THEMES.light, options.kind)), 'plot.png')
  }
  const exportCsv = () => {
    if (!data) return
    const columns: [string, Column][] = [
      ...data.lines.map(
        (l) => [`${lineName(l)}${l.ghost ? ' (previous)' : ''}`, l.values] as [string, Column],
      ),
      ...data.ac.flatMap((s) => [
        [`${s.trace.expr} [dB]${s.ghost ? ' (previous)' : ''}`, s.db] as [string, Column],
        [`${s.trace.expr} [deg]${s.ghost ? ' (previous)' : ''}`, s.phase] as [string, Column],
      ]),
    ]
    const lines = [[meta?.scale ?? 'x', ...columns.map(([name]) => name)].join(',')]
    data.x.forEach((x, i) => {
      lines.push([x, ...columns.map(([, ys]) => ys[i] ?? '')].join(','))
    })
    download(URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })), 'plot.csv')
  }
  const editTitles = async () => {
    const x = await prompt({
      title: 'X axis title',
      label: 'Empty: automatic (quantity and unit)',
      placeholder: axisTitle([xName], xUnit, ''),
      initial: options.xTitle,
    })
    if (x === null) return
    const y = await prompt({
      title: 'Y axis title',
      label: 'Empty: automatic (signal names and unit)',
      placeholder: 'Voltage [V]',
      initial: options.yTitle,
    })
    options.setPlot({ xTitle: x.trim(), yTitle: (y ?? options.yTitle).trim() })
  }

  /** The current analysis and traces as an analysis graph, to add calculations to it. */
  const openAsGraph = async () => {
    const kind = meta?.analysis.kind
    if (!meta || (kind !== 'tran' && kind !== 'ac' && kind !== 'dc')) return
    const fields = Object.fromEntries(
      Object.entries(meta.analysis).map(([k, v]) => [k, String(v ?? '')]),
    ) as Record<string, string>
    const graphs = useProject.getState().project?.graphs ?? []
    let name = `Quick ${kind.toUpperCase()}`
    for (let n = 2; graphs.some((g) => g.name === name); n++) name = `Quick ${kind.toUpperCase()} ${n}`
    const graph = quickGraph(
      name,
      kind,
      fields,
      traces.map((t) => t.expr),
    )
    if (!(await useGraph.getState().save(graph))) return
    useGraph.getState().setActive(name)
    window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: 'analysis' }))
    setTimeout(() => void useGraph.getState().run(name), 300)
  }

  return (
    <div
      data-capture="waveforms"
      className={full ? 'fixed inset-0 z-50 flex flex-col bg-background' : 'flex h-full flex-col'}
    >
      <div className="flex flex-wrap items-center gap-1 border-b px-2 py-1">
        {traces.length === 0 && (
          <span className="text-xs text-muted-foreground">
            {runId
              ? 'Add a signal (+), or probe the schematic.'
              : meta?.scale === null
                ? 'Operating point below. For waveforms run a transient, DC or AC analysis.'
                : 'Run a transient, DC or AC analysis (F5).'}
          </span>
        )}
        {traces.map((trace) => (
          <span
            key={trace.id}
            className="flex items-center gap-1 rounded border px-1.5 py-0.5 font-mono text-xs"
          >
            <button
              type="button"
              onClick={() => toggleTrace(trace.id)}
              className={trace.hidden || missing.has(trace.id) ? 'opacity-40' : ''}
              title={missing.has(trace.id) ? 'Not available in this run' : 'Show / hide'}
            >
              <svg width="14" height="6" className="mr-1 inline-block align-middle" aria-hidden>
                <line
                  x1="0"
                  y1="3"
                  x2="14"
                  y2="3"
                  stroke={trace.color}
                  strokeWidth="2.5"
                  strokeDasharray={DASHES[trace.dash ?? 'solid'].join(' ') || undefined}
                />
              </svg>
              {trace.expr}
              {trace.id === xyTrace?.id && <span className="ml-1 text-muted-foreground">(X axis)</span>}
              {hover?.values[trace.id] && (
                <span className="ml-1 text-muted-foreground">{hover.values[trace.id]}</span>
              )}
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label={`Options for ${trace.expr}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreHorizontal className="size-3" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {!isAc && (
                  <DropdownMenuSub>
                    <DropdownMenuSubTrigger>Move to pane</DropdownMenuSubTrigger>
                    <DropdownMenuSubContent>
                      {[...Array(paneCount).keys()].map((pane) => (
                        <DropdownMenuItem
                          key={pane}
                          onSelect={() => setTracePane(trace.id, pane)}
                          disabled={trace.pane === pane}
                        >
                          Pane {pane + 1}
                        </DropdownMenuItem>
                      ))}
                      <DropdownMenuItem onSelect={() => setTracePane(trace.id, paneCount)}>
                        New pane
                      </DropdownMenuItem>
                    </DropdownMenuSubContent>
                  </DropdownMenuSub>
                )}
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Color</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="p-2">
                    <div className="grid grid-cols-4 gap-1">
                      {[...new Set([...colors, ...PALETTES.default.colors])].map((color) => (
                        <button
                          type="button"
                          key={color}
                          aria-label={`Color ${color}`}
                          className="size-5 rounded-full border"
                          style={{ background: color }}
                          onClick={() => setTraceStyle(trace.id, { color })}
                        />
                      ))}
                    </div>
                    <label className="mt-2 flex items-center gap-2 text-xs">
                      Custom
                      <input
                        type="color"
                        value={trace.color}
                        onChange={(e) => setTraceStyle(trace.id, { color: e.target.value })}
                      />
                    </label>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Line</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={trace.dash ?? 'solid'}
                      onValueChange={(dash) => setTraceStyle(trace.id, { dash: dash as TraceDash })}
                    >
                      {DASH_NAMES.map(([dash, label]) => (
                        <DropdownMenuRadioItem key={dash} value={dash}>
                          {label}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuRadioGroup
                      value={String(trace.width ?? 'auto')}
                      onValueChange={(w) =>
                        setTraceStyle(trace.id, { width: w === 'auto' ? null : Number(w) })
                      }
                    >
                      {['auto', '1', '2', '3'].map((w) => (
                        <DropdownMenuRadioItem key={w} value={w}>
                          {w === 'auto' ? 'Default width' : `${w} px`}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                {!isAc && (
                  <DropdownMenuItem
                    onSelect={() => options.setPlot({ xy: trace.id === xyTrace?.id ? null : trace.expr })}
                  >
                    {trace.id === xyTrace?.id ? 'Plot against time again' : 'Use as X axis (XY plot)'}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onSelect={() => toggleTrace(trace.id)}>
                  {trace.hidden ? 'Show' : 'Hide'}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void revealSignal(trace.expr)}>
                  Show on schematic
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => navigator.clipboard?.writeText(trace.expr)}>
                  Copy expression
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => removeTrace(trace.id)}>
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <button type="button" onClick={() => removeTrace(trace.id)} aria-label={`Remove ${trace.expr}`}>
              <X className="size-3" />
            </button>
          </span>
        ))}
        {hover && !xyTrace && (
          <span className="font-mono text-xs text-muted-foreground">@ {formatValue(hover.x, xUnit)}</span>
        )}
        <div className="ml-auto flex gap-0.5">
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Add signal: nets by name, part currents, expressions"
            disabled={!meta}
            onClick={() => setPicker(true)}
          >
            <Plus />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="Markers: peaks, -3 dB… (or Alt+click a trace)"
                aria-label="Markers"
                disabled={!data || !!xyTrace}
              >
                <MapPin />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Markers on each trace</DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => autoMarkers('peak')}>Peak</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => autoMarkers('min')}>Minimum</DropdownMenuItem>
              {isAc && <DropdownMenuItem onSelect={() => autoMarkers('-3dB')}>-3 dB</DropdownMenuItem>}
              {isAc && <DropdownMenuItem onSelect={() => autoMarkers('0dB')}>0 dB crossing</DropdownMenuItem>}
              <DropdownMenuItem onSelect={() => autoMarkers('harmonics')}>
                5 highest peaks (harmonics)
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem disabled={!pins.length} onSelect={() => setPins([])}>
                Clear markers
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 font-mono text-xs"
            title="Add expression (e.g. V(out)/V(in))"
            onClick={async () => {
              const expr = await prompt({
                title: 'Plot expression',
                label: 'V(a), V(a,b), I(R1), db(), uph(), gd(), deriv(), integ(), sin(), + - * / ^',
                placeholder: 'V(out)/V(in)',
              })
              if (expr) addTrace(expr.trim())
            }}
          >
            f(x)
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Open as analysis graph: add calculations, measurements and more plots"
            aria-label="Open as analysis graph"
            disabled={!runId}
            onClick={openAsGraph}
          >
            <Workflow />
          </Button>
          <Button
            variant={compare ? 'secondary' : 'ghost'}
            size="icon"
            className="size-7"
            title={
              previousRunId ? 'Compare with the previous run (dashed)' : 'Compare: run the analysis twice'
            }
            disabled={!previousRunId}
            onClick={() => setCompare(!compare)}
          >
            <GitCompareArrows />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="Plot options"
                aria-label="Plot options"
              >
                <Settings2 />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Chart</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={options.kind}
                onValueChange={(kind) => options.setPlot({ kind: kind as ChartKind })}
              >
                {KINDS.map(([kind, label]) => (
                  <DropdownMenuRadioItem key={kind} value={kind}>
                    {label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>X axis: {xLog ? 'log' : 'linear'}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={options.xLog === null ? 'auto' : options.xLog ? 'log' : 'lin'}
                    onValueChange={(v) => options.setPlot({ xLog: v === 'auto' ? null : v === 'log' })}
                  >
                    <DropdownMenuRadioItem value="auto">Automatic (log for AC)</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="lin">Linear</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="log">Logarithmic</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Y axis: {options.yLog ? 'log' : 'linear'}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={options.yLog ? 'log' : 'lin'}
                    onValueChange={(v) => options.setPlot({ yLog: v === 'log' })}
                  >
                    <DropdownMenuRadioItem value="lin">Linear</DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="log">Logarithmic</DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              {!isAc && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>X axis signal</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuRadioGroup
                      value={xyTrace?.expr ?? ''}
                      onValueChange={(v) => options.setPlot({ xy: v || null })}
                    >
                      <DropdownMenuRadioItem value="">{xName}</DropdownMenuRadioItem>
                      {traces.map((t) => (
                        <DropdownMenuRadioItem key={t.id} value={t.expr} className="font-mono">
                          {t.expr}
                        </DropdownMenuRadioItem>
                      ))}
                    </DropdownMenuRadioGroup>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
              <DropdownMenuItem onSelect={() => setTimeout(editTitles, 0)}>Axis titles…</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Colours: {PALETTES[options.palette].label}</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={options.palette}
                    onValueChange={(palette) => {
                      options.setPlot({ palette: palette as PaletteName })
                      recolorTraces()
                    }}
                  >
                    {(Object.keys(PALETTES) as PaletteName[]).map((name) => (
                      <DropdownMenuRadioItem key={name} value={name}>
                        <span className="flex gap-0.5">
                          {PALETTES[name].colors.slice(0, 4).map((c) => (
                            <span key={c} className="size-2.5 rounded-full" style={{ background: c }} />
                          ))}
                        </span>
                        {PALETTES[name].label}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Line width: {options.width} px</DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  <DropdownMenuRadioGroup
                    value={String(options.width)}
                    onValueChange={(w) => options.setPlot({ width: Number(w) })}
                  >
                    {['1', '1.5', '2', '3'].map((w) => (
                      <DropdownMenuRadioItem key={w} value={w}>
                        {w} px
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title="Zoom to fit"
            onClick={() => {
              setRange(null)
              for (const p of plots.current) p.setData(p.data, true)
            }}
          >
            <Maximize2 />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                title="Export plot"
                aria-label="Export plot"
              >
                <Download />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={exportPng}>Image (PNG, as on screen)</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void exportPngLight()}>
                Image (PNG, light – for documents)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportSvg('light')}>
                Vector (SVG, light – for documents)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => exportSvg(theme)}>
                Vector (SVG, as on screen)
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={exportCsv}>Data (CSV)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="ghost"
            size="icon"
            className="size-7"
            title={full ? 'Exit full screen (Esc)' : 'Full screen'}
            onClick={() => setFull(!full)}
          >
            {full ? <Minimize /> : <Maximize />}
          </Button>
          <Button variant="ghost" size="icon" className="size-7" title="Clear plot" onClick={clearTraces}>
            <Trash2 />
          </Button>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={host} className="absolute inset-0 overflow-hidden" data-testid="waveforms" />
        {data?.family && (
          <div
            className="pointer-events-none absolute top-1 right-2 flex max-w-[60%] flex-wrap justify-end gap-x-2 rounded bg-background/80 px-1.5 py-0.5 font-mono text-[11px]"
            data-testid="family-legend"
          >
            {data.family.members.map((m) => (
              <span key={m.label} className="flex items-center gap-1">
                <span className="inline-block h-0.5 w-3" style={{ background: m.color }} />
                {m.label}
              </span>
            ))}
          </div>
        )}
        {meta?.status === 'ok' && meta.scale === null && opValues && (
          <div className="absolute inset-0 bg-background">
            <OpTable values={opValues} />
          </div>
        )}
      </div>
      {pins.length > 0 && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t px-2 py-1 font-mono text-xs"
          data-testid="plot-markers"
        >
          {pins.map((m) => (
            <span key={m.id} className="flex items-center gap-1">
              <span style={{ color: m.color }}>{m.id}</span>
              <span>{m.label}</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                aria-label={`Remove marker ${m.id}`}
                onClick={() => setPins((current) => current.filter((x) => x.id !== m.id))}
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
          {pins.length >= 2 && (
            <span className="text-muted-foreground">
              {pins[pins.length - 1].id}−{pins[pins.length - 2].id}: Δ{' '}
              {formatValue(pins[pins.length - 1].x - pins[pins.length - 2].x, xUnit, 4)}
              {pins[pins.length - 1].unit === pins[pins.length - 2].unit
                ? `, ${formatValue(pins[pins.length - 1].y - pins[pins.length - 2].y, pins[pins.length - 1].unit, 4)}`
                : ''}
            </span>
          )}
          <span className="text-muted-foreground">(Alt+click a trace: a marker)</span>
        </div>
      )}
      {readout && (
        <div className="max-h-28 overflow-auto border-t px-2 py-1 font-mono text-xs">
          <div className="text-muted-foreground">
            A {markers.a !== null ? formatValue(markers.a, xUnit) : '—'} · B{' '}
            {markers.b !== null ? formatValue(markers.b, xUnit) : '—'}
            {markers.a !== null && markers.b !== null && (
              <>
                {' '}
                · Δ {formatValue(markers.b - markers.a, xUnit)}
                {xUnit === 's' && markers.b !== markers.a
                  ? ` · 1/Δ ${formatValue(1 / Math.abs(markers.b - markers.a), 'Hz')}`
                  : ''}
              </>
            )}
            <span className="ml-2">(click: A, Shift+click: B, drag to move)</span>
          </div>
          {readout.map((row) => (
            <div key={row.name} className="flex gap-3">
              <span style={{ color: row.trace.color }}>{row.name}</span>
              {row.a !== null && <span>A {formatValue(row.a, row.unit)}</span>}
              {row.b !== null && <span>B {formatValue(row.b, row.unit)}</span>}
              {row.delta !== null && <span>Δ {formatValue(row.delta, row.unit)}</span>}
            </div>
          ))}
        </div>
      )}
      <SignalPicker open={picker} onOpenChange={setPicker} />
    </div>
  )
}
