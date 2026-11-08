/** Simulator log of the last run: classified messages with links to parts and nets. In the
 *  Analysis workspace, the last run of the analysis graph: each node's state, time and error. */
import { CircleAlert, Info, TriangleAlert } from 'lucide-react'
import { useState } from 'react'
import type { LogMessage } from '@/api/types'
import { Button } from '@/components/ui/button'
import { activeEditor } from '@/editor/controller'
import { formatDuration } from '@/lib/units'
import { cn } from '@/lib/utils'
import { useEditor } from '@/store/editor'
import { activeGraph, useGraph } from '@/store/graph'
import { currentSheet, useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'
import { useWorkspace } from '@/store/workspace'
import { IssueList } from './IssueList'

type Severity = LogMessage['severity']

const ICONS = {
  error: <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
  warning: <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />,
  info: <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />,
}

function focusRef(ref: string): void {
  const sheet = currentSheet(useProject.getState())
  const inst = sheet?.instances.find((i) => i.ref.toLowerCase() === ref.toLowerCase())
  if (!inst) return
  useEditor.getState().select([inst.id])
  activeEditor?.centerOn(new Set([inst.id]))
}

function focusNet(net: string): void {
  const editor = useEditor.getState()
  editor.setHighlightNet(editor.highlightNet === net ? null : net)
}

function Chip({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className="rounded border px-1 font-mono text-[11px] text-foreground hover:bg-accent"
    >
      {label}
    </button>
  )
}

const GRAPH_ICONS = {
  error: ICONS.error,
  blocked: ICONS.warning,
  skipped: ICONS.info,
  running: ICONS.info,
  ok: <span className="mt-0.5 size-3.5 shrink-0 text-center text-emerald-500">✓</span>,
  cached: <span className="mt-0.5 size-3.5 shrink-0 text-center text-muted-foreground">✓</span>,
}

/** The analysis graph's last run, node by node (errors first). */
function GraphLog() {
  const states = useGraph((s) => s.states)
  const types = useGraph((s) => s.types)
  useGraph((s) => s.active) // re-render when another graph is opened
  const graph = activeGraph()
  const nodes = graph ? states[graph.name] : undefined
  if (!graph || !nodes || Object.keys(nodes).length === 0)
    return <p className="p-3 text-sm text-muted-foreground">The graph has not run yet. Press F5 to run it.</p>
  const rank = { error: 0, blocked: 1, running: 2, skipped: 3, ok: 4, cached: 5 }
  const rows = graph.nodes
    .filter((n) => nodes[n.id])
    .map((n) => ({ node: n, state: nodes[n.id] }))
    .sort((a, b) => rank[a.state.status] - rank[b.state.status])
  const errors = rows.filter((r) => r.state.status === 'error').length
  const total = rows.reduce((t, r) => t + (r.state.status === 'ok' ? r.state.duration_s : 0), 0)
  return (
    <div className="flex h-full flex-col text-xs" data-testid="graph-log">
      <div className="border-b px-2 py-1 font-medium">
        {graph.name}{' '}
        <span className={errors ? 'text-destructive' : 'text-emerald-500'}>
          {errors ? `${errors} node${errors === 1 ? '' : 's'} failed` : 'ok'}
        </span>
        <span className="text-muted-foreground"> · {formatDuration(total)}</span>
      </div>
      <ul className="min-h-0 flex-1 overflow-auto p-1">
        {rows.map(({ node, state }) => (
          <li key={node.id} className="flex items-start gap-2 px-1 py-0.5">
            {GRAPH_ICONS[state.status]}
            <span className="w-32 shrink-0 truncate font-medium" title={node.type}>
              {types.get(node.type)?.title ?? node.type}{' '}
              <span className="text-muted-foreground">{node.id}</span>
            </span>
            <span className="min-w-0 flex-1 break-words">
              {state.error ?? state.summary[0] ?? state.status}
            </span>
            {state.status === 'ok' && (
              <span className="shrink-0 text-muted-foreground">{formatDuration(state.duration_s)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

export function LogPanel() {
  const workspace = useWorkspace((s) => s.workspace)
  return workspace === 'analysis' ? <GraphLog /> : <SimulationLog />
}

function SimulationLog() {
  const log = useSimulation((s) => s.log)
  const [shown, setShown] = useState<Record<Severity, boolean>>({ error: true, warning: true, info: false })
  const [raw, setRaw] = useState(false)

  const job = useSimulation((s) => s.job)
  if (job?.status === 'error' && !job.run_id) {
    const errors = job.issues.filter((i) => i.severity === 'error')
    return (
      <div className="h-full overflow-auto p-2">
        <p className="px-2 pb-1 text-sm font-medium text-destructive">
          The simulator did not run: {job.error ?? 'the circuit has errors'}
        </p>
        <IssueList issues={errors} hints />
      </div>
    )
  }
  if (!log)
    return <p className="p-3 text-sm text-muted-foreground">No simulation run yet. Press F5 to simulate.</p>
  const messages = log.messages ?? []
  const counts = { error: 0, warning: 0, info: 0 }
  for (const m of messages) counts[m.severity] += 1
  const visible = messages.filter((m) => shown[m.severity])

  return (
    <div className="flex h-full flex-col text-xs">
      <div className="flex items-center gap-1 border-b px-2 py-1">
        <span className="mr-2 font-medium">
          .{log.analysis.kind}{' '}
          <span className={cn(log.status === 'ok' ? 'text-emerald-500' : 'text-destructive')}>
            {log.status}
          </span>
          <span className="text-muted-foreground"> · {formatDuration(log.duration_s)}</span>
        </span>
        {(['error', 'warning', 'info'] as const).map((severity) => (
          <Button
            key={severity}
            size="sm"
            variant={shown[severity] ? 'secondary' : 'ghost'}
            className="h-6 gap-1 px-2 text-xs"
            aria-pressed={shown[severity]}
            onClick={() => setShown({ ...shown, [severity]: !shown[severity] })}
          >
            {ICONS[severity]}
            {counts[severity]}
          </Button>
        ))}
        <Button
          size="sm"
          variant={raw ? 'secondary' : 'ghost'}
          className="ml-auto h-6 px-2 text-xs"
          aria-pressed={raw}
          onClick={() => setRaw(!raw)}
        >
          Raw
        </Button>
      </div>
      {raw ? (
        <pre className="min-h-0 flex-1 overflow-auto p-2 font-mono text-muted-foreground">
          {log.log.join('\n')}
        </pre>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto p-1">
          {log.error && !messages.some((m) => m.severity === 'error') && (
            <li className="flex gap-2 px-2 py-1">
              {log.status === 'cancelled' ? ICONS.info : ICONS.error}
              <span>{log.status === 'cancelled' ? 'Stopped by you before it finished.' : log.error}</span>
            </li>
          )}
          {visible.length === 0 && !log.error && (
            <li className="px-2 py-1 text-muted-foreground">
              No messages{shown.info ? '' : ' (info hidden)'}.
            </li>
          )}
          {visible.map((m) => (
            <li key={m.text}>
              {/* biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/noStaticElementInteractions: chips are the keyboard targets */}
              <div
                onClick={() => (m.refs[0] ? focusRef(m.refs[0]) : m.nets[0] && focusNet(m.nets[0]))}
                className={cn(
                  'flex items-start gap-2 rounded px-2 py-1',
                  (m.refs.length > 0 || m.nets.length > 0) && 'cursor-pointer hover:bg-accent',
                )}
              >
                {ICONS[m.severity]}
                <span className="font-mono">{m.text}</span>
                {m.count > 1 && <span className="text-muted-foreground">×{m.count}</span>}
                <span className="ml-auto flex shrink-0 gap-1">
                  {m.refs.map((ref) => (
                    <Chip key={ref} label={ref} onClick={() => focusRef(ref)} />
                  ))}
                  {m.nets.map((net) => (
                    <Chip key={net} label={net} onClick={() => focusNet(net)} />
                  ))}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
