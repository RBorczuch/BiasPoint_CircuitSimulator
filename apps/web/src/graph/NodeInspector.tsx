/**
 * The inspector of the selected node (graf.md §9, GQ1=B): every parameter with room to edit it,
 * the sockets and what feeds them, the state with its full log, and the node's description.
 */
import { CircleHelp, X } from 'lucide-react'
import { Fragment } from 'react'
import type { Graph, NodeTypeInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { cn } from '@/lib/utils'
import { editGraph, useGraph } from '@/store/graph'
import { exposable, ParamField, ParamInputToggle, STATUS, setParam } from './NodeCard'
import { CATEGORY_COLORS, inputsOf, outputsOf, SOCKET_COLORS } from './templates'

/** The "?" of a node: its description and sockets, on hover. */
export function NodeHelp({ info }: { info: NodeTypeInfo }) {
  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="nodrag text-muted-foreground hover:text-foreground"
          aria-label={`What ${info.title} does`}
        >
          <CircleHelp className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent className="w-72 text-xs" data-testid="node-help">
        <NodeDescription info={info} />
      </HoverCardContent>
    </HoverCard>
  )
}

function NodeDescription({ info }: { info: NodeTypeInfo }) {
  const sockets = (label: string, list: NodeTypeInfo['inputs']) =>
    list.length > 0 && (
      <div>
        <div className="font-medium text-muted-foreground">{label}</div>
        {list.map((s) => (
          <div key={s.name} className="flex items-center gap-1.5">
            <span className="size-2 rounded-full" style={{ background: SOCKET_COLORS[s.type] }} />
            <span>{s.label || s.name}</span>
            <span className="text-muted-foreground">
              {s.type}
              {s.multi ? ', several' : ''}
              {s.optional ? ', optional' : ''}
            </span>
          </div>
        ))}
      </div>
    )
  return (
    <div className="space-y-2">
      <div>
        <span className="font-semibold">{info.title}</span>{' '}
        <span className="font-mono text-[10px] text-muted-foreground">{info.type}</span>
      </div>
      <p className="leading-snug">{info.description}</p>
      {sockets('Inputs', info.inputs)}
      {sockets('Outputs', info.outputs)}
    </div>
  )
}

export function NodeInspector({
  graph,
  nodeId,
  onClose,
}: {
  graph: Graph
  nodeId: string
  onClose: () => void
}) {
  const types = useGraph((s) => s.types)
  const state = useGraph((s) => s.states[graph.name]?.[nodeId])
  const node = graph.nodes.find((n) => n.id === nodeId)
  const info = node ? types.get(node.type) : undefined
  if (!node || !info) return null
  const status = state ? STATUS[state.status] : null
  const titleOf = (id: string) => {
    const other = graph.nodes.find((n) => n.id === id)
    return other ? other.title || types.get(other.type)?.title || id : id
  }
  const feeds = (socket: string) => graph.edges.filter((e) => e.target === node.id && e.input === socket)
  const uses = (socket: string) => graph.edges.filter((e) => e.source === node.id && e.output === socket)
  const section = 'border-t px-3 py-2'
  const outputs = outputsOf(info, node)
  const inputs = inputsOf(info, node)
  return (
    <aside
      className="flex h-full w-72 shrink-0 flex-col overflow-y-auto border-l bg-card text-xs"
      data-testid="node-inspector"
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <span
          className="mt-1 size-2.5 shrink-0 rounded-sm"
          style={{ background: CATEGORY_COLORS[info.category] }}
        />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{node.title || info.title}</div>
          <div className="text-[10px] text-muted-foreground">
            {info.category} · <span className="font-mono">{info.type}</span> v{node.version ?? 1}
          </div>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Close the inspector"
          onClick={onClose}
        >
          <X className="size-3.5" />
        </Button>
      </div>
      <div className="px-3 pb-2">
        <p className="leading-snug text-muted-foreground">{info.description}</p>
      </div>

      {info.params.length > 0 && (
        <div className={section}>
          <div className="mb-1 font-medium">Parameters</div>
          <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-2 gap-y-1.5">
            {info.params.map((param) => (
              <Fragment key={param.name}>
                <span
                  className="flex min-w-0 items-center gap-1 text-muted-foreground"
                  title={param.label || param.name}
                >
                  <span className="truncate">{param.label || param.name}</span>
                  {exposable(param, info) && (
                    <ParamInputToggle param={param} node={node} graph={graph.name} />
                  )}
                </span>
                {(node.param_inputs ?? []).includes(param.name) && exposable(param, info) ? (
                  <span className="truncate text-muted-foreground">from the input</span>
                ) : (
                  <ParamField
                    param={param}
                    value={node.params[param.name] ?? param.default}
                    suggestions={[]}
                    onCommit={(v) => setParam(graph.name, node.id, param.name, v)}
                  />
                )}
              </Fragment>
            ))}
          </div>
        </div>
      )}

      {(inputs.length > 0 || outputs.length > 0) && (
        <div className={section}>
          {inputs.length > 0 && <div className="mb-1 font-medium">Inputs</div>}
          {inputs.map((s) => (
            <div key={s.name} className="flex items-baseline gap-1.5 py-0.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: SOCKET_COLORS[s.type] }} />
              <span className="shrink-0">{s.label || s.name}</span>
              <span className="truncate text-muted-foreground">
                {feeds(s.name)
                  .map((e) => `${titleOf(e.source)} · ${e.output}`)
                  .join(', ') || (s.optional ? 'optional, not connected' : 'not connected')}
              </span>
            </div>
          ))}
          {outputs.length > 0 && <div className="mt-2 mb-1 font-medium">Outputs</div>}
          {outputs.map((s) => (
            <div key={s.name} className="flex items-baseline gap-1.5 py-0.5">
              <span className="size-2 shrink-0 rounded-full" style={{ background: SOCKET_COLORS[s.type] }} />
              <span className="shrink-0">{s.label || s.name}</span>
              <span className="truncate text-muted-foreground">
                {uses(s.name)
                  .map((e) => titleOf(e.target))
                  .join(', ') || 'not used'}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className={section}>
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          State
          {status && <span className={cn('size-2 rounded-full', status.color)} />}
          <span className="font-normal text-muted-foreground" data-testid="inspector-status">
            {state ? (state.from_disk ? 'from an earlier session' : status?.label) : 'not run yet'}
            {state && state.duration_s > 0 ? ` · ${state.duration_s.toFixed(3)} s` : ''}
          </span>
        </div>
        {state?.error && (
          <p className={cn('mb-1', state.status === 'error' ? 'text-destructive' : 'text-amber-600')}>
            {state.error}
          </p>
        )}
        {state?.summary?.map((line) => (
          <div key={line} className="font-mono text-[10px] leading-snug break-all text-muted-foreground">
            {line}
          </div>
        ))}
      </div>

      <div className={section}>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            className="size-3.5"
            checked={Boolean(node.bypass)}
            onChange={(e) =>
              void editGraph(graph.name, (g) => ({
                ...g,
                nodes: g.nodes.map((n) => (n.id === node.id ? { ...n, bypass: e.target.checked } : n)),
              }))
            }
          />
          Bypass <kbd className="text-[10px] text-muted-foreground">M</kbd>
        </label>
      </div>
    </aside>
  )
}
