/** Starting graphs (node.md §8): a few typical analyses, ready to run. */
import type { Graph, GraphEdge, GraphNode, NodeTypeInfo, Socket } from '@/api/types'

type Params = GraphNode['params']

const n = (id: string, type: string, x: number, y: number, params: Params = {}): GraphNode => ({
  id,
  type,
  pos: [x, y],
  size: null,
  params,
})
const e = (source: string, output: string, target: string, input: string): GraphEdge => ({
  source,
  output,
  target,
  input,
})

export interface GraphTemplate {
  id: string
  title: string
  description: string
  build: (name: string, signal: string) => Graph
}

export const TEMPLATES: GraphTemplate[] = [
  {
    id: 'empty',
    title: 'Empty graph',
    description: 'Start with just the circuit',
    build: (name) => ({ name, nodes: [n('circuit', 'core/circuit', 0, 0)], edges: [] }),
  },
  {
    id: 'transient',
    title: 'Transient plot',
    description: 'Circuit → transient → signal → plot',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 60),
        n('tran', 'sim/tran', 360, 40),
        n('signal', 'core/signal', 720, 40, { expr: signal }),
        n('plot', 'view/plot', 1080, 0),
      ],
      edges: [
        e('circuit', 'circuit', 'tran', 'circuit'),
        e('tran', 'run', 'signal', 'run'),
        e('signal', 'signal', 'plot', 'signals'),
      ],
    }),
  },
  {
    id: 'power',
    title: 'Power and its average',
    description: 'P = V · I of a part, plotted and averaged over time',
    build: (name) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 140),
        n('tran', 'sim/tran', 360, 100),
        n('v', 'core/signal', 720, 0, { expr: 'V(in,out)' }),
        n('i', 'core/signal', 720, 260, { expr: 'I(R1)' }),
        n('p', 'math/expr', 1080, 100, { expr: 'a*b', name: 'P' }),
        n('avg', 'measure/basic', 1480, 420, { op: 'avg' }),
        n('value', 'view/value', 1860, 440),
        n('plot', 'view/plot', 1480, -60),
      ],
      edges: [
        e('circuit', 'circuit', 'tran', 'circuit'),
        e('tran', 'run', 'v', 'run'),
        e('tran', 'run', 'i', 'run'),
        e('v', 'signal', 'p', 'a'),
        e('i', 'signal', 'p', 'b'),
        e('p', 'out', 'plot', 'signals'),
        e('p', 'out', 'avg', 'signal'),
        e('avg', 'value', 'value', 'value'),
      ],
    }),
  },
  {
    id: 'sweep',
    title: 'Parameter sweep',
    description: 'Run an AC sweep for several values of a .param: curves and a table of -3 dB',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 60),
        n('sweep', 'core/sweep', 0, 220, { name: 'R', values: '1k 2k 5k' }),
        n('ac', 'sim/ac', 360, 60),
        n('signal', 'core/signal', 720, 60, { expr: signal }),
        n('plot', 'view/plot', 1080, -80),
        n('f3db', 'measure/basic', 1080, 400, { op: 'f3db' }),
        n('table', 'view/table', 1460, 420),
      ],
      edges: [
        e('circuit', 'circuit', 'ac', 'circuit'),
        e('sweep', 'params', 'ac', 'params'),
        e('ac', 'run', 'signal', 'run'),
        e('signal', 'signal', 'plot', 'signals'),
        e('signal', 'signal', 'f3db', 'signal'),
        e('f3db', 'value', 'table', 'values'),
      ],
    }),
  },
  {
    id: 'step',
    title: 'Step response',
    description: 'Transient → rise time, overshoot and settling time of a signal',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 120),
        n('tran', 'sim/tran', 360, 100),
        n('signal', 'core/signal', 720, 100, { expr: signal }),
        n('plot', 'view/plot', 1080, -120),
        n('rise', 'measure/basic', 1080, 260, { op: 'rise' }),
        n('overshoot', 'measure/basic', 1080, 420, { op: 'overshoot' }),
        n('settling', 'measure/basic', 1080, 580, { op: 'settling', band: '2' }),
        n('table', 'view/table', 1460, 420),
      ],
      edges: [
        e('circuit', 'circuit', 'tran', 'circuit'),
        e('tran', 'run', 'signal', 'run'),
        e('signal', 'signal', 'plot', 'signals'),
        e('signal', 'signal', 'rise', 'signal'),
        e('signal', 'signal', 'overshoot', 'signal'),
        e('signal', 'signal', 'settling', 'signal'),
        e('rise', 'value', 'table', 'values'),
        e('overshoot', 'value', 'table', 'values'),
        e('settling', 'value', 'table', 'values'),
      ],
    }),
  },
  {
    id: 'fft',
    title: 'Spectrum (FFT)',
    description: 'Transient → steady-state window → FFT → spectrum and THD',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 60),
        n('tran', 'sim/tran', 360, 40, { stop: '20 ms', step: '1 µs' }),
        n('signal', 'core/signal', 720, 40, { expr: signal }),
        n('window', 'math/window', 1080, 40, { start: '10 ms' }),
        n('fft', 'math/fft', 1440, 40, { window: 'flattop' }),
        n('plot', 'view/plot', 1800, -40, { complex: 'mag', y_log: true }),
        n('thd', 'measure/basic', 1440, 300, { op: 'thd' }),
        n('value', 'view/value', 1800, 420),
      ],
      edges: [
        e('circuit', 'circuit', 'tran', 'circuit'),
        e('tran', 'run', 'signal', 'run'),
        e('signal', 'signal', 'window', 'signal'),
        e('window', 'signal', 'fft', 'signal'),
        e('fft', 'spectrum', 'plot', 'signals'),
        e('window', 'signal', 'thd', 'signal'),
        e('thd', 'value', 'value', 'value'),
      ],
    }),
  },
  {
    id: 'montecarlo',
    title: 'Monte Carlo',
    description: 'Part tolerances → spread of the -3 dB frequency: histogram and yield',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 60),
        n('mc', 'core/montecarlo', 0, 220, { tolerances: 'R* ±5%; C* ±10%', runs: 50 }),
        n('ac', 'sim/ac', 360, 60),
        n('signal', 'core/signal', 720, 60, { expr: signal }),
        n('f3db', 'measure/basic', 1080, 60, { op: 'f3db' }),
        n('hist', 'view/histogram', 1460, -80),
        n('spec', 'view/spec', 1460, 260, { condition: '> 0' }),
      ],
      edges: [
        e('circuit', 'circuit', 'mc', 'circuit'),
        e('mc', 'circuit', 'ac', 'circuit'),
        e('ac', 'run', 'signal', 'run'),
        e('signal', 'signal', 'f3db', 'signal'),
        e('f3db', 'value', 'hist', 'values'),
        e('f3db', 'value', 'spec', 'value'),
      ],
    }),
  },
  {
    id: 'filter',
    title: 'Frequency response',
    description: 'AC sweep → Bode plot and the -3 dB frequency',
    build: (name, signal) => ({
      name,
      nodes: [
        n('circuit', 'core/circuit', 0, 60),
        n('ac', 'sim/ac', 360, 40),
        n('signal', 'core/signal', 720, 40, { expr: signal }),
        n('plot', 'view/plot', 1080, -80),
        n('f3db', 'measure/basic', 1080, 400, { op: 'f3db' }),
        n('value', 'view/value', 1460, 420),
      ],
      edges: [
        e('circuit', 'circuit', 'ac', 'circuit'),
        e('ac', 'run', 'signal', 'run'),
        e('signal', 'signal', 'plot', 'signals'),
        e('signal', 'signal', 'f3db', 'signal'),
        e('f3db', 'value', 'value', 'value'),
      ],
    }),
  },
]

export const SOCKET_COLORS: Record<string, string> = {
  circuit: '#a1a1aa',
  params: '#a855f7',
  run: '#3b82f6',
  signal: '#22c55e',
  scalar: '#eab308',
  value: '#14b8a6',
  table: '#f97316',
}

export const CATEGORY_COLORS: Record<string, string> = {
  Input: '#71717a',
  Simulation: '#2563eb',
  Signals: '#16a34a',
  Math: '#0d9488',
  Measure: '#ca8a04',
  View: '#db2777',
}

/** Items of a "choices" parameter ("avg, max" -> ["avg", "max"]). */
export function choiceList(value: unknown): string[] {
  return String(value ?? '')
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean)
}

/** A node's outputs: its type's and those made from its parameters (dynamic outputs). */
export function outputsOf(info: NodeTypeInfo, node: { params: Record<string, unknown> }): Socket[] {
  const dynamic = info.dynamic_outputs
  if (!dynamic) return info.outputs
  const param = info.params.find((p) => p.name === dynamic.param)
  const items = choiceList(node.params[dynamic.param] ?? param?.default).slice(dynamic.skip)
  return [
    ...info.outputs,
    ...items.map((name) => ({ name, type: dynamic.type, label: name, multi: false, optional: false })),
  ]
}

/** Parameters a number from another node can set (widget -> input). */
export const NUMERIC_KINDS = ['quantity', 'int', 'text']

/** A node's inputs: its type's and its parameters turned into scalar sockets. */
export function inputsOf(info: NodeTypeInfo, node: { param_inputs?: string[] }): Socket[] {
  const exposed = node.param_inputs ?? []
  if (!exposed.length) return info.inputs
  const taken = new Set(info.inputs.map((s) => s.name))
  const extra = info.params
    .filter((p) => exposed.includes(p.name) && NUMERIC_KINDS.includes(p.kind) && !taken.has(p.name))
    .map((p) => ({
      name: p.name,
      type: 'scalar' as const,
      label: p.label || p.name,
      multi: false,
      optional: false,
    }))
  return [...info.inputs, ...extra]
}

/** Can an output of type `from` feed an input of type `to`? ("value" = signal or number.) */
export function compatible(from: string, to: string): boolean {
  if (from === 'table' || to === 'table') return from === to // a table goes to tables only
  if (from === to || to === 'value') return true
  return from === 'value' && (to === 'signal' || to === 'scalar') // checked when it runs
}

/**
 * The quick path as a graph (node.md "Quick"): the analysis set in the Simulation panel and the
 * plotted traces become Circuit → analysis → Signal nodes → Plot, to extend with calculations.
 */
export function quickGraph(
  name: string,
  kind: 'dc' | 'ac' | 'tran',
  fields: Record<string, string>,
  expressions: string[],
): Graph {
  const sim: Record<typeof kind, { type: string; params: Params }> = {
    tran: {
      type: 'sim/tran',
      params: { stop: fields.tstop ?? '10m', step: fields.tstep ?? '10u', max_step: fields.tmax ?? '' },
    },
    ac: {
      type: 'sim/ac',
      params: {
        variation: fields.variation ?? 'dec',
        points: Number.parseInt(fields.points ?? '20', 10) || 20,
        start: fields.fstart ?? '10',
        stop: fields.fstop ?? '1meg',
      },
    },
    dc: {
      type: 'sim/dc',
      params: {
        source: fields.source ?? 'V1',
        start: fields.start ?? '0',
        stop: fields.stop ?? '5',
        step: fields.step ?? '0.1',
      },
    },
  }
  const signals = expressions.length ? expressions : ['V(out)']
  const rows = signals.length
  const middle = ((rows - 1) * 240) / 2
  return {
    name,
    nodes: [
      n('circuit', 'core/circuit', 0, middle + 20),
      n('sim', sim[kind].type, 360, middle),
      ...signals.map((expr, i) => n(`s${i + 1}`, 'core/signal', 720, i * 240, { expr })),
      n('plot', 'view/plot', 1080, Math.max(0, middle - 100)),
    ],
    edges: [
      e('circuit', 'circuit', 'sim', 'circuit'),
      ...signals.flatMap((_, i) => [
        e('sim', 'run', `s${i + 1}`, 'run'),
        e(`s${i + 1}`, 'signal', 'plot', 'signals'),
      ]),
    ],
  }
}
