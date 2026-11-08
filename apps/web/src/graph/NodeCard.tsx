/** A graph node on the canvas: header with state, sockets, parameter widgets and a preview. */
import { Handle, type NodeProps, Position } from '@xyflow/react'
import { Download, Maximize2, X } from 'lucide-react'
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type uPlot from 'uplot'
import { apiGet, apiPost } from '@/api/client'
import type { GraphNode, NodeParam, NodeState, NodeTypeInfo, PlotSeries, ScalarInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatValue, quantityHint } from '@/lib/units'
import { cn } from '@/lib/utils'
import { plotsToSvg, SVG_THEMES, svgToPng } from '@/plot/svg'
import { prompt } from '@/store/dialogs'
import { editGraph } from '@/store/graph'
import { useProject } from '@/store/project'
import { NodeHelp } from './NodeInspector'
import { legendOf, PlotFigure, PlotLegend, type PlotOptions, values } from './PlotView'
import { paneGroups, parseLines } from './plotLayout'
import { CATEGORY_COLORS, choiceList, NUMERIC_KINDS, outputsOf, SOCKET_COLORS } from './templates'

export interface NodeData extends Record<string, unknown> {
  node: GraphNode
  info: NodeTypeInfo | undefined
  state: NodeState | undefined
  graph: string
  version: number
  suggestions: string[]
}

export const STATUS: Record<string, { color: string; label: string }> = {
  running: { color: 'bg-sky-500 animate-pulse', label: 'running' },
  ok: { color: 'bg-emerald-500', label: 'done' },
  cached: { color: 'bg-emerald-500/50', label: 'from cache' },
  error: { color: 'bg-destructive', label: 'error' },
  blocked: { color: 'bg-amber-500', label: 'waiting for an input' },
  skipped: { color: 'bg-muted-foreground/40', label: 'not needed' },
}

const nodePath = (graph: string, node: string, suffix: string) =>
  `/api/projects/${useProject.getState().info?.id}/graphs/${encodeURIComponent(graph)}/nodes/${node}${suffix}`

export function setParam(graph: string, nodeId: string, name: string, value: string | number | boolean) {
  void editGraph(graph, (g) => ({
    ...g,
    nodes: g.nodes.map((n) => (n.id === nodeId ? { ...n, params: { ...n.params, [name]: value } } : n)),
  }))
}

export function ParamField({
  param,
  value,
  onCommit,
  suggestions,
}: {
  param: NodeParam
  value: string | number | boolean
  onCommit: (value: string | number | boolean) => void
  suggestions: string[]
}) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])
  const listId = useRef(`s${Math.random().toString(36).slice(2)}`).current
  const field = 'nodrag h-6 w-full rounded border bg-background px-1.5 font-mono text-[11px]'
  if (param.kind === 'choice')
    return (
      <select
        className={field}
        value={String(value)}
        onChange={(e) => onCommit(e.target.value)}
        aria-label={param.label}
      >
        {param.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    )
  if (param.kind === 'bool')
    return (
      <input
        type="checkbox"
        className="nodrag size-3.5"
        aria-label={param.label}
        checked={Boolean(value)}
        onChange={(e) => onCommit(e.target.checked)}
      />
    )
  if (param.kind === 'choices')
    return <ChoicesField param={param} value={String(value)} onCommit={onCommit} />
  const hint = param.kind === 'quantity' && text ? quantityHint(text, param.unit) : null
  const commit = () => {
    if (text === String(value)) return
    onCommit(param.kind === 'int' ? Number.parseInt(text, 10) || 0 : text)
  }
  return (
    <div className="relative">
      <input
        className={cn(field, hint && !hint.ok && 'border-destructive', param.unit && 'pr-6')}
        value={text}
        aria-label={param.label}
        placeholder={param.placeholder}
        title={hint?.hint || undefined}
        list={param.kind === 'expr' ? listId : undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {param.unit && (
        <span className="pointer-events-none absolute top-1/2 right-1.5 -translate-y-1/2 text-[10px] text-muted-foreground">
          {param.unit}
        </span>
      )}
      {param.kind === 'expr' && (
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </div>
  )
}

/** Several of the options (kept as "a, b"), picked from a menu in the order clicked. */
function ChoicesField({
  param,
  value,
  onCommit,
}: {
  param: NodeParam
  value: string
  onCommit: (value: string) => void
}) {
  const chosen = choiceList(value)
  const toggle = (option: string) =>
    onCommit((chosen.includes(option) ? chosen.filter((c) => c !== option) : [...chosen, option]).join(', '))
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="nodrag h-6 w-full truncate rounded border bg-background px-1.5 text-left font-mono text-[11px]"
          aria-label={param.label}
          title={chosen.join(', ') || param.placeholder}
        >
          {chosen.join(', ') || <span className="text-muted-foreground">{param.placeholder || 'none'}</span>}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="max-h-72 overflow-y-auto">
        {param.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option}
            checked={chosen.includes(option)}
            onSelect={(e) => e.preventDefault()} // stays open: pick several
            onCheckedChange={() => toggle(option)}
            className="font-mono text-xs"
          >
            {option}
          </DropdownMenuCheckboxItem>
        ))}
        {chosen.length > 0 && (
          <DropdownMenuItem className="text-xs text-muted-foreground" onSelect={() => onCommit('')}>
            Clear{param.placeholder ? ` (${param.placeholder})` : ''}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function download(url: string, name: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
}

/** Full-screen viewer of a Plot node (Esc closes); exports PNG, SVG and CSV. */
function PlotViewer({
  title,
  series,
  options,
  onClose,
}: {
  title: string
  series: PlotSeries[]
  options: PlotOptions
  onClose: () => void
}) {
  const plots = useRef<uPlot[]>([])
  const [size, setSize] = useState({ width: window.innerWidth - 32, height: window.innerHeight - 80 })
  // Look of exported pictures (the screen keeps the app's theme).
  const [style, setStyle] = useState<'light' | 'dark'>('light')
  const [lineWidth, setLineWidth] = useState(1.5)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    const onResize = () => setSize({ width: window.innerWidth - 32, height: window.innerHeight - 80 })
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onResize)
    }
  }, [onClose])
  const onReady = useCallback((ready: uPlot[]) => {
    plots.current = ready
  }, [])
  const exportSvg = () => {
    if (!plots.current.length) return
    const legend = legendOf(series).map((l) => ({ ...l, dash: 'solid' as const }))
    const svg = plotsToSvg(plots.current, legend, SVG_THEMES[style], options.kind as 'line', lineWidth)
    download(URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })), `${title || 'plot'}.svg`)
  }
  const exportPng = async () => {
    if (!plots.current.length) return
    const legend = legendOf(series).map((l) => ({ ...l, dash: 'solid' as const }))
    const svg = plotsToSvg(plots.current, legend, SVG_THEMES[style], options.kind as 'line', lineWidth)
    download(await svgToPng(svg), `${title || 'plot'}.png`)
  }
  const exportCsv = () => {
    const lines = series.flatMap((s) => [
      `# ${s.name} [${s.unit}] vs ${s.x_name} [${s.x_unit}]`,
      ...s.x.map((x, i) => (s.re && s.im ? `${x},${s.re[i]},${s.im[i]}` : `${x},${s.max?.[i] ?? ''}`)),
    ])
    download(
      URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })),
      `${title || 'plot'}.csv`,
    )
  }
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col bg-background p-4" data-testid="plot-viewer">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-medium">{title || 'Plot'}</h2>
        <span className="text-xs text-muted-foreground">drag to zoom · double-click resets · Esc closes</span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-xs text-muted-foreground">Export</span>
          <select
            aria-label="Export style"
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={style}
            onChange={(e) => setStyle(e.target.value as 'light' | 'dark')}
          >
            <option value="light">light background</option>
            <option value="dark">dark background</option>
          </select>
          <select
            aria-label="Line width"
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={lineWidth}
            onChange={(e) => setLineWidth(Number(e.target.value))}
          >
            {[1, 1.5, 2, 3].map((w) => (
              <option key={w} value={w}>
                line {w} px
              </option>
            ))}
          </select>
          <Button size="sm" variant="outline" onClick={exportSvg}>
            <Download /> SVG
          </Button>
          <Button size="sm" variant="outline" onClick={() => void exportPng()}>
            <Download /> PNG
          </Button>
          <Button size="sm" variant="outline" onClick={exportCsv}>
            <Download /> CSV
          </Button>
          <Button size="icon" variant="ghost" className="size-8" title="Close (Esc)" onClick={onClose}>
            <X />
          </Button>
        </div>
      </div>
      <PlotFigure
        series={series}
        options={options}
        width={size.width}
        height={size.height - 24}
        onReady={onReady}
      />
      <PlotLegend series={series} max={40} />
    </div>,
    document.body,
  )
}

function PlotPreview({ data }: { data: NodeData }) {
  const [series, setSeries] = useState<PlotSeries[]>([])
  const [full, setFull] = useState(false)
  const ok = data.state?.status === 'ok' || data.state?.status === 'cached'
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the node's results change
  useEffect(() => {
    if (!ok) return
    apiPost<PlotSeries[]>(nodePath(data.graph, data.node.id, '/plot'), { pixels: 1200 })
      .then(setSeries)
      .catch(() => setSeries([]))
  }, [data.version, ok, data.graph, data.node.id])
  const [limits, setLimits] = useState<ScalarInfo[]>([])
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the node's results change
  useEffect(() => {
    if (!ok) return
    apiGet<ScalarInfo[]>(nodePath(data.graph, data.node.id, '/values'))
      .then(setLimits)
      .catch(() => setLimits([]))
  }, [data.version, ok, data.graph, data.node.id])
  const p = data.node.params
  const options: PlotOptions = useMemo(
    () => ({
      kind: String(p.kind ?? 'line'),
      x_log: String(p.x_log ?? 'auto'),
      y_log: Boolean(p.y_log),
      complex: String(p.complex ?? 'db'),
      panels: String(p.panels ?? 'one'),
      groups: String(p.groups ?? ''),
      right: String(p.right ?? ''),
      lines: [
        ...parseLines(String(p.lines ?? '')),
        ...limits.map((l) => ({
          axis: 'y' as const,
          value: l.value,
          unit: l.unit,
          label: `${l.name}${l.family ? ` [${l.family}]` : ''} ${formatValue(l.value, l.unit)}`,
        })),
      ],
    }),
    [p.kind, p.x_log, p.y_log, p.complex, p.panels, p.groups, p.right, p.lines, limits],
  )
  const panes =
    options.complex === 'bode'
      ? 2
      : paneGroups(
          series,
          options.panels ?? 'one',
          options.groups ?? '',
          (s) => values(s, options.complex).unit,
        ).length
  if (!ok || !series.length)
    return (
      <div className="flex h-24 items-center justify-center text-[11px] text-muted-foreground">
        Run the graph (Ctrl+Enter)
      </div>
    )
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click opens the viewer (also a button)
    <div className="nodrag relative" onDoubleClick={() => setFull(true)} title="Double-click: full screen">
      <PlotFigure
        series={series}
        options={options}
        width={340}
        height={panes > 1 ? Math.min(420, 140 * panes) : 200}
      />
      {(series.length > 1 || series.some((s) => s.family)) && <PlotLegend series={series} />}
      <button
        type="button"
        className="absolute top-1 right-1 rounded bg-background/80 p-0.5 text-muted-foreground hover:text-foreground"
        title="Full screen"
        aria-label="Full screen"
        onClick={() => setFull(true)}
      >
        <Maximize2 className="size-3.5" />
      </button>
      {full && (
        <PlotViewer
          title={String(p.title || 'Plot')}
          series={series}
          options={options}
          onClose={() => setFull(false)}
        />
      )}
    </div>
  )
}

/** PASS / FAIL badge with the yield ("PASS 40 of 40 within 900..1.1k = 100%"). */
/** PASS / WARN / FAIL of a Specification (its yield) or a Stress check (the worst use). */
function SpecVerdict({ line, label = 'yield' }: { line: string; label?: string }) {
  const verdict = (['PASS', 'WARN', 'FAIL'] as const).find((v) => line.startsWith(v)) ?? 'FAIL'
  const [text, yieldText] = line.split(' = ')
  return (
    <div className="flex items-start gap-2" data-testid="spec-verdict">
      <span
        className={cn(
          'rounded px-1.5 py-0.5 text-xs font-bold text-white',
          { PASS: 'bg-emerald-600', WARN: 'bg-amber-500', FAIL: 'bg-destructive' }[verdict],
        )}
      >
        {verdict}
      </span>
      <div className="min-w-0 text-[11px]">
        <div className="font-mono">
          {label} {yieldText ?? '—'}
        </div>
        <div className="text-muted-foreground">{text.replace(/^(PASS|WARN|FAIL) /, '')}</div>
      </div>
    </div>
  )
}

/** Counts of the connected numbers per bin, as bars with the value range below. */
function HistogramPreview({ data }: { data: NodeData }) {
  const [values, setValues] = useState<ScalarInfo[]>([])
  const ok = data.state?.status === 'ok' || data.state?.status === 'cached'
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the node's results change
  useEffect(() => {
    if (!ok) return
    apiGet<ScalarInfo[]>(nodePath(data.graph, data.node.id, '/values'))
      .then(setValues)
      .catch(() => setValues([]))
  }, [data.version, ok, data.graph, data.node.id])
  if (!ok || values.length === 0)
    return <div className="py-2 text-center text-[11px] text-muted-foreground">—</div>
  const bins = Math.max(1, Math.min(100, Number(data.node.params.bins ?? 10) || 10))
  const xs = values.map((v) => v.value)
  const [lo, hi] = [Math.min(...xs), Math.max(...xs)]
  const width = hi > lo ? (hi - lo) / bins : 1
  const counts = Array.from({ length: bins }, () => 0)
  for (const x of xs) counts[Math.min(bins - 1, Math.floor((x - lo) / width))] += 1
  const top = Math.max(...counts)
  const unit = values[0].unit
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, xs.length - 1))
  return (
    <div className="nodrag" data-testid="histogram">
      {/* Scales with the node (it is narrower than 340 px and the bars used to run out). */}
      <svg
        width="100%"
        height={110}
        viewBox="0 0 340 110"
        preserveAspectRatio="none"
        role="img"
        aria-label="Histogram"
      >
        <text x={2} y={9} className="fill-muted-foreground" fontSize={9}>
          {top}
        </text>
        {hi > lo && (
          <line
            x1={((mean - lo) / (hi - lo)) * 340}
            x2={((mean - lo) / (hi - lo)) * 340}
            y1={2}
            y2={95}
            className="stroke-foreground/60"
            strokeDasharray="3 3"
            vectorEffect="non-scaling-stroke"
          >
            <title>{`mean ${formatValue(mean, unit)}`}</title>
          </line>
        )}
        {counts.map((c, i) => {
          const h = (c / top) * 90
          return (
            <rect
              key={(lo + i * width).toPrecision(12)}
              x={(i * 340) / bins + 1}
              y={95 - h}
              width={340 / bins - 2}
              height={h}
              className="fill-primary/70"
            >
              <title>{`${formatValue(lo + i * width, unit)} … ${formatValue(lo + (i + 1) * width, unit)}: ${c}`}</title>
            </rect>
          )
        })}
      </svg>
      <div className="flex justify-between font-mono text-[10px] whitespace-nowrap text-muted-foreground">
        <span>{formatValue(lo, unit)}</span>
        <span>{formatValue(hi, unit)}</span>
      </div>
      <div className="text-center font-mono text-[10px] text-muted-foreground">
        n = {xs.length} · mean {formatValue(mean, unit)} · σ {formatValue(sd, unit)}
      </div>
    </div>
  )
}

interface TableInfo {
  name: string
  columns: string[]
  units: string[]
  rows: (number | string)[][]
}

/** A table input: its columns with units, its rows (the first 50; the count beyond). */
function TableGrid({ table }: { table: TableInfo }) {
  const shown = table.rows.slice(0, 50)
  const cell = (v: number | string, k: number) =>
    typeof v === 'number' ? formatValue(v, table.units[k] ?? '') : v
  return (
    <div className="nodrag max-h-64 overflow-auto" data-testid="node-table">
      <table className="w-full font-mono text-[11px]">
        <thead>
          <tr>
            {table.columns.map((c, k) => (
              <th key={c + String(k)} className="pr-2 text-left font-medium">
                {c}
                {table.units[k] ? (
                  <span className="font-normal text-muted-foreground"> [{table.units[k]}]</span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows in their order
            <tr key={r} className="border-t">
              {row.map((v, k) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns in their order
                <td key={k} className="py-0.5 pr-2 text-right">
                  {cell(v, k)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {table.rows.length > shown.length && (
        <p className="text-[10px] text-muted-foreground">… {table.rows.length - shown.length} more rows</p>
      )}
    </div>
  )
}

function ValuesPreview({ data, big }: { data: NodeData; big: boolean }) {
  const [values, setValues] = useState<ScalarInfo[]>([])
  const [table, setTable] = useState<TableInfo | null>(null)
  const ok = data.state?.status === 'ok' || data.state?.status === 'cached'
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the node's results change
  useEffect(() => {
    if (!ok) return
    apiGet<ScalarInfo[]>(nodePath(data.graph, data.node.id, '/values'))
      .then(setValues)
      .catch(() => setValues([]))
    if (!big)
      apiGet<TableInfo | null>(nodePath(data.graph, data.node.id, '/table'))
        .then(setTable)
        .catch(() => setTable(null))
  }, [data.version, ok, data.graph, data.node.id])
  if (ok && table && !values.length) return <TableGrid table={table} />
  if (!ok || !values.length)
    return <div className="py-2 text-center text-[11px] text-muted-foreground">—</div>
  const text = (v: ScalarInfo) =>
    `${formatValue(v.value, v.unit)}${v.phase_deg != null ? ` ∠ ${v.phase_deg.toFixed(1)}°` : ''}`
  if (big && values.length === 1)
    return (
      <div className="py-1 text-center">
        <div className="font-mono text-xl font-semibold" data-testid="node-value">
          {text(values[0])}
        </div>
        <div className="font-mono text-[11px] text-muted-foreground">{values[0].name}</div>
      </div>
    )
  return (
    <table className="nodrag w-full font-mono text-[11px]">
      <tbody>
        {values.map((v) => (
          <tr key={`${v.name}|${v.family}`} className="border-t">
            <td className="py-0.5 pr-2 text-muted-foreground">{v.name}</td>
            {values.some((x) => x.family) && <td className="py-0.5 pr-2">{v.family}</td>}
            <td className="py-0.5 text-right">{text(v)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

/** An Equation: its formula, the same with the numbers put in, and the result. */
function EquationPreview({ data }: { data: NodeData }) {
  const [values, setValues] = useState<ScalarInfo[]>([])
  const [result, setResult] = useState<ScalarInfo | null>(null)
  const ok = data.state?.status === 'ok' || data.state?.status === 'cached'
  // biome-ignore lint/correctness/useExhaustiveDependencies: refetch when the node's results change
  useEffect(() => {
    if (!ok) return
    apiGet<ScalarInfo[]>(nodePath(data.graph, data.node.id, '/values'))
      .then(setValues)
      .catch(() => setValues([]))
    apiGet<ScalarInfo[]>(nodePath(data.graph, data.node.id, '/outputs'))
      .then((out) => setResult(out[0] ?? null))
      .catch(() => setResult(null))
  }, [data.version, ok, data.graph, data.node.id])
  const expr = String(data.node.params.expr ?? 'a*b')
  const name = String(data.node.params.name ?? '').trim()
  if (!ok || !result) return <div className="py-2 text-center text-[11px] text-muted-foreground">—</div>
  const byLetter = new Map(values.filter((v) => !v.family).map((v) => [v.socket, v]))
  const filled = expr.replace(/\b[a-d]\b/g, (letter) => {
    const v = byLetter.get(letter)
    return v ? `(${formatValue(v.value, v.unit)})` : letter
  })
  return (
    <div className="space-y-0.5 py-1 font-mono text-[11px]" data-testid="node-equation">
      <div>
        {name ? `${name} = ` : ''}
        {expr}
      </div>
      <div className="text-muted-foreground">= {filled}</div>
      <div className="text-sm font-semibold">= {formatValue(result.value, result.unit)}</div>
    </div>
  )
}

function SocketRow({ socket, side }: { socket: NodeTypeInfo['inputs'][number]; side: 'in' | 'out' }) {
  const color = SOCKET_COLORS[socket.type]
  return (
    <div className={cn('relative flex h-5 items-center px-3 text-[11px]', side === 'out' && 'justify-end')}>
      <Handle
        type={side === 'in' ? 'target' : 'source'}
        position={side === 'in' ? Position.Left : Position.Right}
        id={socket.name}
        style={{ background: color, width: 10, height: 10, border: '2px solid var(--background)' }}
        title={`${socket.type}${socket.multi ? ' (several)' : ''}`}
      />
      <span className="text-muted-foreground">
        {socket.label || socket.name}
        {socket.multi ? ' …' : ''}
      </span>
    </div>
  )
}

export const NodeCard = memo(function NodeCard({ data, selected }: NodeProps) {
  const { node, info, state, graph, suggestions } = data as NodeData
  if (!info)
    return (
      <div className="rounded border border-destructive bg-card p-2 text-xs">
        Unknown node type {node.type}
      </div>
    )
  const status = state ? STATUS[state.status] : null
  const rename = async () => {
    const next = await prompt({ title: 'Node title', label: 'Title', initial: node.title || info.title })
    if (next === null) return
    const title = next.trim() === info.title ? '' : next.trim()
    void editGraph(graph, (g) => ({
      ...g,
      nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, title } : n)),
    }))
  }
  return (
    <div
      className={cn(
        'w-[300px] rounded-md border bg-card text-card-foreground shadow-md',
        info.view === 'plot' && 'w-[364px]',
        selected && 'ring-2 ring-primary',
        state?.status === 'error' && 'border-destructive',
        node.bypass && 'opacity-50 [border-style:dashed]',
      )}
      data-bypass={node.bypass ? 'true' : undefined}
    >
      <div
        className="flex items-center gap-2 rounded-t-md border-b px-2 py-1"
        style={{ borderTop: `3px solid ${CATEGORY_COLORS[info.category] ?? '#71717a'}` }}
      >
        <button
          type="button"
          className="text-xs font-medium hover:underline"
          title="Rename (its type stays: double-click or Enter)"
          onDoubleClick={(e) => {
            e.stopPropagation()
            void rename()
          }}
          onKeyDown={(e) => e.key === 'Enter' && void rename()}
        >
          {node.title || info.title}
        </button>
        <span className="text-[10px] text-muted-foreground">
          {node.title ? info.title : info.category}
          {node.bypass ? ' · bypassed (M)' : ''}
        </span>
        <NodeHelp info={info} />
        {status && (
          <span
            className="ml-auto flex items-center gap-1 text-[10px] text-muted-foreground"
            title={
              state?.from_disk
                ? 'Results of an earlier session (kept on disk); running the graph recomputes what changed'
                : status.label
            }
          >
            {state?.from_disk && <span data-testid="node-restored">restored</span>}
            {state && state.duration_s > 0.05 && `${state.duration_s.toFixed(2)} s`}
            <span className={cn('size-2 rounded-full', status.color)} />
          </span>
        )}
      </div>
      <div className="flex justify-between py-1">
        <div className="flex-1">
          {info.inputs.map((s) => (
            <SocketRow key={s.name} socket={s} side="in" />
          ))}
        </div>
        <div className="flex-1">
          {outputsOf(info, node).map((s) => (
            <SocketRow key={s.name} socket={s} side="out" />
          ))}
        </div>
      </div>
      {info.params.some((param) => !param.advanced) && (
        <div className="grid grid-cols-[5.5rem_1fr] items-center gap-x-2 gap-y-1 border-t px-2 py-1.5">
          {info.params
            .filter((param) => !param.advanced || (node.param_inputs ?? []).includes(param.name))
            .map((param) => (
              <ParamRow
                key={param.name}
                param={param}
                node={node}
                info={info}
                graph={graph}
                suggestions={suggestions}
              />
            ))}
          {info.params.some((param) => param.advanced) && (
            <span className="col-span-2 text-[10px] text-muted-foreground">
              more in the inspector:{' '}
              {info.params
                .filter((param) => param.advanced)
                .map((param) => param.label)
                .join(', ')}
            </span>
          )}
        </div>
      )}
      {state?.error && state.status !== 'skipped' && (
        <p
          className={cn(
            'border-t px-2 py-1 text-[11px]',
            state.status === 'error' ? 'text-destructive' : 'text-amber-600',
          )}
        >
          {state.error}
        </p>
      )}
      {info.view === 'plot' && (
        <div className="border-t p-1">
          <PlotPreview data={data as NodeData} />
        </div>
      )}
      {info.view === 'spec' && state?.summary?.[0] && (
        <div className="border-t px-2 py-1.5">
          <SpecVerdict line={state.summary[0]} label={info.type === 'measure/stress' ? 'worst' : 'yield'} />
        </div>
      )}
      {info.view === 'histogram' && (
        <div className="border-t px-2 py-1">
          <HistogramPreview data={data as NodeData} />
        </div>
      )}
      {info.view === 'equation' && (
        <div className="border-t px-2 py-1">
          <EquationPreview data={data as NodeData} />
        </div>
      )}
      {(info.view === 'value' || info.view === 'table') && (
        <div className="border-t px-2 py-1">
          <ValuesPreview data={data as NodeData} big={info.view === 'value'} />
        </div>
      )}
      {!info.view && state?.summary?.length ? (
        <div className="border-t px-2 py-1 font-mono text-[10px] leading-tight text-muted-foreground">
          {state.summary.map((line) => (
            <div key={line} className="truncate" title={line}>
              {line}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
})

/** Can this parameter become an input socket (a number, and no input of that name)? */
export function exposable(param: NodeParam, info: NodeTypeInfo): boolean {
  return NUMERIC_KINDS.includes(param.kind) && !info.inputs.some((s) => s.name === param.name)
}

/** Turn a parameter into an input socket or back (its links go with the socket). */
export function toggleParamInput(graph: string, node: GraphNode, name: string) {
  const exposed = node.param_inputs ?? []
  const on = !exposed.includes(name)
  void editGraph(graph, (g) => ({
    ...g,
    nodes: g.nodes.map((n) =>
      n.id === node.id
        ? { ...n, param_inputs: on ? [...exposed, name] : exposed.filter((x) => x !== name) }
        : n,
    ),
    edges: on ? g.edges : g.edges.filter((e) => !(e.target === node.id && e.input === name)),
  }))
}

/** The small button beside a parameter: "take this from an input". */
export function ParamInputToggle({
  param,
  node,
  graph,
}: {
  param: NodeParam
  node: GraphNode
  graph: string
}) {
  const on = (node.param_inputs ?? []).includes(param.name)
  return (
    <button
      type="button"
      className={cn(
        'nodrag size-3 shrink-0 rounded-full border',
        on ? 'border-transparent' : 'border-muted-foreground/50 hover:border-foreground',
      )}
      style={on ? { background: SOCKET_COLORS.scalar } : undefined}
      aria-label={
        on ? `Set ${param.label || param.name} here again` : `Take ${param.label || param.name} from an input`
      }
      aria-pressed={on}
      title={
        on
          ? 'Taken from the input: click to set it here again'
          : 'Take it from an input (a number from another node)'
      }
      onClick={() => toggleParamInput(graph, node, param.name)}
    />
  )
}

function ParamRow({
  param,
  node,
  info,
  graph,
  suggestions,
}: {
  param: NodeParam
  node: GraphNode
  info: NodeTypeInfo
  graph: string
  suggestions: string[]
}) {
  const value = node.params[param.name] ?? param.default
  const canExpose = exposable(param, info)
  const exposed = canExpose && (node.param_inputs ?? []).includes(param.name)
  return (
    <>
      <span className="relative flex min-w-0 items-center gap-1 text-[11px] text-muted-foreground">
        {exposed && (
          <Handle
            type="target"
            position={Position.Left}
            id={param.name}
            style={{
              background: SOCKET_COLORS.scalar,
              width: 10,
              height: 10,
              left: -13,
              border: '2px solid var(--background)',
            }}
            title="scalar"
          />
        )}
        <span className="truncate">{param.label || param.name}</span>
        {canExpose && <ParamInputToggle param={param} node={node} graph={graph} />}
      </span>
      {exposed ? (
        <span className="h-6 truncate rounded border border-dashed px-1.5 font-mono text-[11px] leading-6 text-muted-foreground">
          from the input
        </span>
      ) : (
        <ParamField
          param={param}
          value={value}
          suggestions={suggestions}
          onCommit={(v) => setParam(graph, node.id, param.name, v)}
        />
      )}
    </>
  )
}
