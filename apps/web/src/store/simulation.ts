/** Simulation state: running jobs, the run shown in the viewer, probes (traces), OP overlay. */
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiGet, apiPost } from '@/api/client'
import { events } from '@/api/events'
import type { JobInfo, RunMeta, SheetNets, StressReport } from '@/api/types'
import { newId } from '@/lib/ids'
import { formatValue } from '@/lib/units'
import { groupSignals } from '@/plot/format'
import { PALETTES, printDash, type TraceDash, usePlot } from './plot'
import { pendingEdits, useProject } from './project'

export interface Trace {
  id: string
  expr: string
  color: string
  hidden: boolean
  pane: number // plot pane (0 = top); panes share the x axis
  dash: TraceDash
  width: number | null // null: the plot's default width
}

export type TraceStyle = Partial<Pick<Trace, 'color' | 'dash' | 'width'>>

interface SimState {
  job: JobInfo | null
  meta: RunMeta | null
  previousRunId: string | null // last run of the same kind, for comparison
  compare: boolean
  opValues: Record<string, number> | null
  nets: SheetNets | null
  traces: Trace[]
  showOp: boolean
  probeReference: string | null // net for differential probes (Shift+click)
  log: RunMeta | null // last finished run, also failed ones (Log panel)
  /** Probes on the schematic: reference -> measured value text ("2.5 V", "rms 1.2 V"). */
  probeValues: Record<string, string>
  /** Ratings checked against the last operating point / transient run (FR-SIM-7). */
  stress: StressReport | null
  /** ``confirmed``: past the big-run question; ``voltagesOnly``: no device currents saved. */
  run: (options?: { confirmed?: boolean; voltagesOnly?: boolean }) => Promise<void>
  cancel: () => Promise<void>
  openRun: (runId: string) => Promise<void>
  addTrace: (expr: string) => void
  removeTrace: (id: string) => void
  toggleTrace: (id: string) => void
  setTracePane: (id: string, pane: number) => void
  setTraceStyle: (id: string, style: TraceStyle) => void
  recolorTraces: () => void
  setCompare: (compare: boolean) => void
  clearTraces: () => void
  setShowOp: (show: boolean) => void
  setProbeReference: (net: string | null) => void
  loadNets: () => Promise<void>
  loadLog: (runId: string) => Promise<void>
}

let launching = false

interface RunEstimate {
  points: number
  signals: number
  bytes: number
  large: boolean
  text: string
}
/** Finished jobs by id: a job's end can be announced before the response that started it. */
const finishedJobs = new Map<string, JobInfo>()

const projectPath = (suffix: string) => `/api/projects/${useProject.getState().info?.id}${suffix}`

interface ProbeInfo {
  ref: string
  kind: 'v' | 'vd' | 'i'
  signal: string // V(out), V(a)-V(b), I(IP1)
  sheet: string
}

/** Probes are always plotted after a run, and their value is written next to them. */
async function loadProbes(meta: RunMeta, opValues: Record<string, number> | null): Promise<void> {
  let probes: ProbeInfo[]
  try {
    probes = await apiGet<ProbeInfo[]>(projectPath('/probes'))
  } catch {
    return
  }
  const values: Record<string, string> = {}
  for (const probe of probes) {
    const unit = probe.kind === 'i' ? 'A' : 'V'
    if (opValues) {
      const value = opValueOf(probe.signal, opValues)
      if (value !== null) values[probe.ref] = formatValue(value, unit, 4)
      continue
    }
    if (meta.analysis.kind === 'ac') continue // a spectrum has no single value
    useSimulation.getState().addTrace(probe.signal)
    try {
      const op = meta.analysis.kind === 'tran' ? 'rms' : 'final'
      const m = await apiPost<{ value: number }>(`/api/runs/${meta.run_id}/measure`, {
        signal: probe.signal,
        op,
      })
      values[probe.ref] = `${op === 'rms' ? 'rms ' : ''}${formatValue(m.value, unit, 4)}`
    } catch {
      // the value stays unknown; the trace still shows
    }
  }
  useSimulation.setState({ probeValues: values })
}

/** A probe's value from operating-point values: V(x), V(a)-V(b) or I(ref). */
function opValueOf(signal: string, values: Record<string, number>): number | null {
  const lookup = (name: string) => {
    const key = Object.keys(values).find((k) => k.toLowerCase() === name.toLowerCase())
    return key === undefined ? (/^v\(0\)$/i.test(name) ? 0 : null) : values[key]
  }
  const diff = /^(V\([^)]+\))-(V\([^)]+\))$/i.exec(signal)
  if (diff) {
    const [a, b] = [lookup(diff[1]), lookup(diff[2])]
    return a === null || b === null ? null : a - b
  }
  return lookup(signal)
}

export const useSimulation = create<SimState>((set, get) => ({
  job: null,
  meta: null,
  previousRunId: null,
  compare: false,
  opValues: null,
  nets: null,
  traces: [],
  showOp: true,
  probeReference: null,
  log: null,
  probeValues: {},
  stress: null,

  run: async (options = {}) => {
    if (!useProject.getState().info) return
    const current = get().job
    if (current && (current.status === 'queued' || current.status === 'running')) return
    if (launching) return // F5 pressed again before the server answered: one run only
    launching = true
    try {
      await pendingEdits()
      // A run of millions of points with every current saved can fill the disk: ask first.
      if (!options.confirmed) {
        const size = await apiPost<RunEstimate>(projectPath('/analyses/estimate'), {}).catch(() => null)
        if (size?.large) {
          toast.warning('This run is very large', {
            description: `${size.text}. Saving node voltages only (no device currents) makes it smaller; a larger time step too.`,
            duration: Number.POSITIVE_INFINITY,
            action: { label: 'Run anyway', onClick: () => void get().run({ confirmed: true }) },
            cancel: {
              label: 'Voltages only',
              onClick: () => void get().run({ confirmed: true, voltagesOnly: true }),
            },
          })
          return
        }
      }
      const body = options.voltagesOnly ? { voltages_only: true } : {}
      const job = await apiPost<JobInfo>(projectPath('/analyses/run'), body)
      // WebSocket events for this job may arrive before this response: never step back.
      const finished = finishedJobs.get(job.job_id)
      set({ job: finished ? newer(finished, job) : newer(get().job, job) })
      if (job.status === 'error') reportFailure(job)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      launching = false
    }
  },

  cancel: async () => {
    const job = get().job
    if (job) await apiPost(`/api/jobs/${job.job_id}/cancel`).catch(() => undefined)
  },

  openRun: async (runId) => {
    let meta: RunMeta
    let opValues: Record<string, number> | null = null
    try {
      meta = await apiGet<RunMeta>(`/api/runs/${runId}`)
      if (meta.scale === null && meta.status === 'ok') {
        opValues = (await apiGet<{ values: Record<string, number> }>(`/api/runs/${runId}/values`)).values
      }
    } catch (error) {
      // The run finished but its results could not be read (connection lost, run deleted).
      toast.error('Could not load the simulation results', {
        description: error instanceof Error ? error.message : String(error),
        action: { label: 'Retry', onClick: () => void get().openRun(runId) },
      })
      return
    }
    if (get().log?.run_id !== runId) set({ log: meta })
    const previous = get().meta
    const sameKind = previous && previous.status === 'ok' && previous.analysis.kind === meta.analysis.kind
    set({
      meta,
      opValues,
      previousRunId: sameKind && previous.run_id !== meta.run_id ? previous.run_id : get().previousRunId,
    })
    // First waveforms of a session: show the nets the user named (labels), so the plot is not
    // empty. Experts who probe or pick signals themselves keep their own selection.
    if (meta.scale && meta.status === 'ok' && get().traces.length === 0) {
      const named = groupSignals(
        meta.signals.map((s) => s.name),
        meta.scale,
      ).find((g) => g.title === 'Nets')
      for (const signal of named?.signals.slice(0, 4) ?? []) get().addTrace(signal)
    }
    if (meta.status === 'ok') void loadProbes(meta, opValues)
    void loadStress(meta)
    suggestFasterModels(meta)
  },

  addTrace: (expr) => {
    const traces = get().traces
    if (traces.some((t) => t.expr.toLowerCase() === expr.toLowerCase())) return
    const palette = usePlot.getState().palette
    const colors = PALETTES[palette].colors
    const used = new Set(traces.map((t) => t.color))
    const color = colors.find((c) => !used.has(c)) ?? colors[traces.length % colors.length]
    const dash = palette === 'print' ? printDash(traces.length) : 'solid'
    set({ traces: [...traces, { id: newId(), expr, color, hidden: false, pane: 0, dash, width: null }] })
  },
  removeTrace: (id) => set({ traces: get().traces.filter((t) => t.id !== id) }),
  toggleTrace: (id) =>
    set({ traces: get().traces.map((t) => (t.id === id ? { ...t, hidden: !t.hidden } : t)) }),
  setTracePane: (id, pane) => set({ traces: get().traces.map((t) => (t.id === id ? { ...t, pane } : t)) }),
  setTraceStyle: (id, style) =>
    set({ traces: get().traces.map((t) => (t.id === id ? { ...t, ...style } : t)) }),
  recolorTraces: () => {
    const palette = usePlot.getState().palette
    const colors = PALETTES[palette].colors
    set({
      traces: get().traces.map((t, i) => ({
        ...t,
        color: colors[i % colors.length],
        dash: palette === 'print' ? printDash(i) : 'solid',
      })),
    })
  },
  setCompare: (compare) => set({ compare }),
  clearTraces: () => set({ traces: [] }),
  setShowOp: (showOp) => set({ showOp }),
  setProbeReference: (probeReference) => set({ probeReference }),

  loadLog: async (runId) => {
    try {
      set({ log: await apiGet<RunMeta>(`/api/runs/${runId}`) })
    } catch {
      // run removed meanwhile
    }
  },

  loadNets: async () => {
    if (!useProject.getState().info) return
    try {
      const { sheetName, viewPath } = useProject.getState()
      const path = viewPath?.length ? `&path=${encodeURIComponent(viewPath.join('.'))}` : ''
      const nets = await apiGet<SheetNets>(
        projectPath(`/circuit/nets?sheet=${encodeURIComponent(sheetName)}${path}`),
      )
      set({ nets })
    } catch {
      // keep the previous map; probes fall back gracefully
    }
  },
}))

const STAGE: Record<JobInfo['status'], number> = { queued: 0, running: 1, ok: 2, error: 2, cancelled: 2 }

/** Keep the more advanced state of the same job (responses and events can cross). */
export function newer(current: JobInfo | null, incoming: JobInfo): JobInfo {
  if (!current || current.job_id !== incoming.job_id) return incoming
  if (STAGE[incoming.status] < STAGE[current.status]) return current
  return { ...incoming, issues: incoming.issues.length ? incoming.issues : current.issues }
}

/**
 * A finished run when its results are not on screen (F5 on the schematic): say so and offer
 * the way to them. With the waveform viewer visible the plot itself is the answer.
 */
/** A run this long offers the simplified models of the blocks in the circuit (FR-CMP-8). */
export const SLOW_RUN_S = 5

/** Parts the user can edit that simulate with their full model though a faster one exists. */
export function fasterChoices(): {
  sheet: string
  id: string
  ref: string
  variant: string
  label: string
}[] {
  const { project, symbols } = useProject.getState()
  const out: { sheet: string; id: string; ref: string; variant: string; label: string }[] = []
  for (const sheet of project?.sheets ?? []) {
    if (sheet.owner) continue // inside a library part: chosen by the part's own variants
    for (const inst of sheet.instances) {
      const variants = symbols.get(inst.symbol)?.variants ?? []
      const fast = variants.find((v) => v.faster)
      if (fast && (!inst.model.variant || inst.model.variant === variants[0]?.name))
        out.push({ sheet: sheet.name, id: inst.id, ref: inst.ref, variant: fast.name, label: fast.label })
    }
  }
  return out
}

function suggestFasterModels(meta: RunMeta): void {
  if (meta.status !== 'ok' || meta.duration_s < SLOW_RUN_S) return
  const choices = fasterChoices()
  if (!choices.length) return
  const refs = choices.map((c) => c.ref).join(', ')
  toast.info(`The run took ${meta.duration_s.toFixed(1)} s`, {
    description: `${refs} can simulate as a faster model (${choices[0].label}). It may then need no small maximum time step.`,
    duration: 12000,
    action: {
      label: 'Use faster models',
      onClick: () =>
        void useProject.getState().execute({
          type: 'transaction',
          label: 'use faster models',
          commands: choices.map((c) => ({
            type: 'set_params',
            sheet: c.sheet,
            id: c.id,
            params: {},
            variant: c.variant,
            model: null,
            pins: null,
          })),
        }),
    },
  })
}

/** Stress report of a run when any part has ratings (OP and transient runs only). */
async function loadStress(meta: RunMeta): Promise<void> {
  const project = useProject.getState().project
  const rated = project?.sheets.some(
    (s) =>
      Object.keys(s.component?.ratings ?? {}).length ||
      s.instances.some((i) => Object.keys(i.ratings ?? {}).length),
  )
  if (!rated || meta.status !== 'ok' || !['op', 'tran'].includes(meta.analysis.kind)) {
    useSimulation.setState({ stress: null })
    return
  }
  try {
    const stress = await apiGet<StressReport>(projectPath(`/runs/${meta.run_id}/stress`))
    useSimulation.setState({ stress })
    const over = stress.items.filter((i) => i.status === 'over').length
    if (over)
      toast.warning(`${over} rating${over === 1 ? '' : 's'} exceeded`, {
        description: 'The parts are marked red on the schematic; see Problems.',
      })
  } catch {
    useSimulation.setState({ stress: null })
  }
}

function reportSuccess(runId: string): void {
  if (document.querySelector('[data-testid="waveforms"]')) return
  void apiGet<RunMeta>(`/api/runs/${runId}`)
    .then((meta) => {
      const kind = meta.analysis.kind.toUpperCase()
      if (meta.analysis.kind === 'op') {
        const shown = useSimulation.getState().showOp
        toast.success('Operating point done', {
          description: shown
            ? 'Voltages and currents are on the schematic.'
            : 'Show them on the schematic with Simulate → Show / hide operating point.',
          id: 'run-finished',
        })
        return
      }
      toast.success(`${kind} done · ${meta.points} points`, {
        id: 'run-finished',
        action: {
          label: 'Show waveforms',
          onClick: () => window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: 'simulate' })),
        },
      })
    })
    .catch(() => {})
}

function reportFailure(job: JobInfo): void {
  const errors = job.issues.filter((i) => i.severity === 'error').map((i) => i.message)
  toast.error(job.status === 'cancelled' ? 'Simulation cancelled' : 'Simulation failed', {
    description: errors.length ? errors.slice(0, 4).join('\n') : (job.error ?? undefined),
    action: job.run_id
      ? {
          label: 'Show log',
          onClick: () => window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'log' })),
        }
      : undefined,
  })
}

let netsTimer: ReturnType<typeof setTimeout> | undefined

/** Follow backend job events and keep the net map in sync with the document. */
export function installSimulationSync(): () => void {
  const offEvents = events.on((event) => {
    if (event.type !== 'run.progress' && event.type !== 'run.finished') return
    if (event.project_id !== useProject.getState().info?.id) return
    if (event.origin === 'graph') return // runs of analysis graphs show in their nodes
    const current = useSimulation.getState().job
    if (current && current.job_id !== event.job_id && event.type === 'run.progress') return
    const job: JobInfo = {
      job_id: event.job_id,
      project_id: event.project_id,
      status: event.status as JobInfo['status'],
      run_id: event.run_id,
      progress: event.progress,
      error: event.error,
      issues: current?.job_id === event.job_id ? current.issues : [],
    }
    useSimulation.setState({ job: newer(current, job) })
    if (event.type === 'run.finished') {
      finishedJobs.set(job.job_id, job)
      if (finishedJobs.size > 50) finishedJobs.delete(finishedJobs.keys().next().value as string)
      if (event.status === 'ok' && event.run_id) {
        void useSimulation.getState().openRun(event.run_id)
        reportSuccess(event.run_id)
      } else {
        reportFailure(job)
        if (event.run_id) void useSimulation.getState().loadLog(event.run_id)
      }
    }
  })
  const offProject = useProject.subscribe((state, prev) => {
    if (
      state.project !== prev.project ||
      state.sheetName !== prev.sheetName ||
      state.viewPath !== prev.viewPath
    ) {
      clearTimeout(netsTimer)
      netsTimer = setTimeout(() => void useSimulation.getState().loadNets(), 150)
    }
    if (state.info?.id !== prev.info?.id) {
      useSimulation.setState({
        job: null,
        meta: null,
        previousRunId: null,
        opValues: null,
        traces: [],
        log: null,
      })
    }
  })
  return () => {
    offEvents()
    offProject()
  }
}
