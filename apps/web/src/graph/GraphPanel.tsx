/**
 * Analysis graph editor (node.md, stage N1): React Flow canvas with typed sockets.
 * Double-click the canvas (or drop a link on empty space) to add a node; Ctrl+Enter runs.
 * Every change is one `set_graph` command, so undo/redo and saving work as for the schematic.
 */
import {
  applyNodeChanges,
  Background,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  type FinalConnectionState,
  MiniMap,
  type Node,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { Loader2, Map as MapIcon, PanelRight, Play, Plus, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { Graph, GraphEdge, NodeTypeInfo, Socket } from '@/api/types'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { newId } from '@/lib/ids'
import { useTheme } from '@/lib/theme'
import { prompt } from '@/store/dialogs'
import { editGraph, useGraph } from '@/store/graph'
import { useProject } from '@/store/project'
import { type GroupData, GroupFrame, NoteCard, type NoteData, Reroute } from './CanvasItems'
import { NodeCard, type NodeData } from './NodeCard'
import { NodeInspector } from './NodeInspector'
import { compatible, inputsOf, outputsOf, SOCKET_COLORS, TEMPLATES } from './templates'

const nodeTypes = { card: NodeCard, group: GroupFrame, note: NoteCard, reroute: Reroute }

/** The pseudo node types of the add-node palette that are not calculations. */
const CANVAS_ITEMS: NodeTypeInfo[] = [
  {
    type: 'canvas/note',
    title: 'Note',
    category: 'Canvas',
    description: 'Text on the canvas',
    inputs: [],
    outputs: [],
    params: [],
    view: '',
  },
  {
    type: 'canvas/reroute',
    title: 'Reroute',
    category: 'Canvas',
    description: 'A point an edge passes through (to route it)',
    inputs: [],
    outputs: [],
    params: [],
    view: '',
  },
  {
    type: 'canvas/group',
    title: 'Group (Ctrl+G)',
    category: 'Canvas',
    description: 'A titled frame: around the selected nodes, or empty here',
    inputs: [],
    outputs: [],
    params: [],
    view: '',
  },
] as NodeTypeInfo[]

/** The type an edge carries out of a reroute: the type that comes into it (through others). */
function rerouteType(types: Map<string, NodeTypeInfo>, graph: Graph, id: string): string | undefined {
  const reroutes = new Set((graph.reroutes ?? []).map((r) => r.id))
  let current = id
  for (let depth = 0; depth < 50; depth++) {
    const edge = graph.edges.find((e) => e.target === current)
    if (!edge) return undefined
    if (!reroutes.has(edge.source)) return socketOf(types, graph, edge.source, edge.output, 'out')?.type
    current = edge.source
  }
  return undefined
}

const inside = (pos: [number, number], rect: [number, number, number, number]) =>
  pos[0] >= rect[0] && pos[1] >= rect[1] && pos[0] <= rect[0] + rect[2] && pos[1] <= rect[1] + rect[3]

/** Auto-run stops when a single node took longer than this (seconds); F5 still runs it. */
const AUTO_LIMIT_S = 2

function readFlag(key: string, fallback: boolean): boolean {
  try {
    const value = localStorage.getItem(key)
    return value === null ? fallback : value === '1'
  } catch {
    return fallback
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    localStorage.setItem(key, on ? '1' : '0')
  } catch {
    // not remembered
  }
}

function readAuto(name: string | undefined): boolean {
  try {
    return Boolean(name && localStorage.getItem(`bpt.graph.auto.${name}`))
  } catch {
    return false
  }
}

/** Where a new node goes, and the link to make when it was dropped from a socket. */
interface Pending {
  at: { x: number; y: number }
  from?: { node: string; socket: string; type: string; side: 'source' | 'target' }
}

function socketOf(
  types: Map<string, NodeTypeInfo>,
  graph: Graph,
  nodeId: string,
  name: string,
  side: 'in' | 'out',
) {
  const node = graph.nodes.find((n) => n.id === nodeId)
  const info = node ? types.get(node.type) : undefined
  const outputs = info && node ? outputsOf(info, node) : info?.outputs
  const inputs = info && node ? inputsOf(info, node) : info?.inputs
  return (side === 'in' ? inputs : outputs)?.find((s) => s.name === name)
}

/** Net and part names of the schematic, offered in signal fields. */
function useSuggestions(): string[] {
  const project = useProject((s) => s.project)
  return useMemo(() => {
    const nets = new Set<string>()
    const parts = new Set<string>()
    for (const sheet of project?.sheets ?? []) {
      for (const label of sheet.labels) nets.add(`V(${label.text})`)
      for (const inst of sheet.instances) if (!inst.ref.startsWith('#')) parts.add(`I(${inst.ref})`)
    }
    return [...nets, ...parts].sort()
  }, [project])
}

function Canvas({ graph }: { graph: Graph }) {
  const types = useGraph((s) => s.types)
  const states = useGraph((s) => s.states[graph.name])
  const versions = useGraph((s) => s.versions)
  const theme = useTheme((s) => s.theme)
  const suggestions = useSuggestions()
  const flow = useReactFlow()
  const [pending, setPending] = useState<Pending | null>(null)
  const [map, setMap] = useState(false) // off by default: it covers nodes in the corner
  const [query, setQuery] = useState('')

  const derived = useMemo<Node[]>(
    () => [
      // Groups under everything, then notes, reroutes and the nodes.
      ...(graph.groups ?? []).map((grp) => ({
        id: grp.id,
        type: 'group',
        position: { x: grp.rect[0], y: grp.rect[1] },
        style: { width: grp.rect[2], height: grp.rect[3] },
        zIndex: -1,
        data: { graph: graph.name, id: grp.id, title: grp.title, color: grp.color } satisfies GroupData,
      })),
      ...(graph.notes ?? []).map((note) => ({
        id: note.id,
        type: 'note',
        position: { x: note.pos[0], y: note.pos[1] },
        style: note.size ? { width: note.size[0], height: note.size[1] } : undefined,
        data: { graph: graph.name, id: note.id, text: note.text } satisfies NoteData,
      })),
      ...(graph.reroutes ?? []).map((r) => ({
        id: r.id,
        type: 'reroute',
        position: { x: r.pos[0], y: r.pos[1] },
        data: {},
      })),
      ...graph.nodes.map((node) => ({
        id: node.id,
        type: 'card',
        position: { x: node.pos[0], y: node.pos[1] },
        dragHandle: undefined,
        data: {
          node,
          info: types.get(node.type),
          state: states?.[node.id],
          graph: graph.name,
          version: versions[node.id] ?? 0,
          suggestions,
        } satisfies NodeData,
      })),
    ],
    [graph, types, states, versions, suggestions],
  )
  const [nodes, setNodes] = useState<Node[]>(derived)
  useEffect(() => {
    // Keep the selection and the measured size of the canvas; take everything else from the
    // document. Without `measured` React Flow hides a node until it is resized again, which never
    // happens for a node whose size does not change (it stayed invisible).
    setNodes((current) => {
      const before = new Map(current.map((n) => [n.id, n]))
      return derived.map((n) => {
        const old = before.get(n.id)
        return { ...n, selected: old?.selected ?? false, measured: old?.measured }
      })
    })
  }, [derived])

  const edges = useMemo<Edge[]>(
    () =>
      graph.edges.map((e) => {
        const socket = socketOf(types, graph, e.source, e.output, 'out')
        const type = socket?.type ?? rerouteType(types, graph, e.source)
        return {
          id: `${e.source}.${e.output}->${e.target}.${e.input}`,
          source: e.source,
          sourceHandle: e.output,
          target: e.target,
          targetHandle: e.input,
          style: { stroke: SOCKET_COLORS[(type ?? 'value') as keyof typeof SOCKET_COLORS], strokeWidth: 2 },
        }
      }),
    [graph, types],
  )

  const save = (change: (g: Graph) => Graph) => editGraph(graph.name, change)

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      const removed = changes.filter((c) => c.type === 'remove').map((c) => c.id)
      if (removed.length) {
        void editGraph(graph.name, (g) => ({
          ...g,
          nodes: g.nodes.filter((n) => !removed.includes(n.id)),
          edges: g.edges.filter((e) => !removed.includes(e.source) && !removed.includes(e.target)),
          groups: (g.groups ?? []).filter((x) => !removed.includes(x.id)),
          notes: (g.notes ?? []).filter((x) => !removed.includes(x.id)),
          reroutes: (g.reroutes ?? []).filter((x) => !removed.includes(x.id)),
        }))
      }
      setNodes((current) => applyNodeChanges(changes, current))
    },
    [graph.name],
  )

  const onNodeDragStop = (_event: unknown, _node: Node, moved: Node[]) => {
    const at = new Map(
      moved.map((n) => [n.id, [Math.round(n.position.x), Math.round(n.position.y)] as [number, number]]),
    )
    void save((g) => {
      // A group moved takes along what was inside it (what was not dragged with it itself).
      const shift = new Map<string, [number, number]>()
      for (const grp of g.groups ?? []) {
        const to = at.get(grp.id)
        if (!to) continue
        const d: [number, number] = [to[0] - grp.rect[0], to[1] - grp.rect[1]]
        for (const item of [...g.nodes, ...(g.notes ?? []), ...(g.reroutes ?? [])])
          if (!at.has(item.id) && inside(item.pos, grp.rect)) shift.set(item.id, d)
      }
      const place = <T extends { id: string; pos: [number, number] }>(item: T): T => {
        const to = at.get(item.id)
        const d = shift.get(item.id)
        return to
          ? { ...item, pos: to }
          : d
            ? { ...item, pos: [item.pos[0] + d[0], item.pos[1] + d[1]] }
            : item
      }
      return {
        ...g,
        nodes: g.nodes.map(place),
        notes: (g.notes ?? []).map(place),
        reroutes: (g.reroutes ?? []).map(place),
        groups: (g.groups ?? []).map((grp) => {
          const to = at.get(grp.id)
          return to ? { ...grp, rect: [to[0], to[1], grp.rect[2], grp.rect[3]] } : grp
        }),
      }
    })
  }

  const kindOf = (id: string) =>
    graph.reroutes?.some((r) => r.id === id)
      ? 'reroute'
      : graph.nodes.some((n) => n.id === id)
        ? 'node'
        : 'other'

  /** Selected nodes framed by a new group (or an empty group at a point). */
  const group = async (at?: { x: number; y: number }) => {
    const chosen = graph.nodes.filter((n) => nodes.find((x) => x.id === n.id)?.selected)
    const title = await prompt({ title: 'New group', label: 'Title', initial: 'Group' })
    if (title === null) return
    let rect: [number, number, number, number]
    if (chosen.length) {
      const sized = chosen.map((n) => {
        const measured = nodes.find((x) => x.id === n.id)?.measured
        return [n.pos[0], n.pos[1], n.pos[0] + (measured?.width ?? 300), n.pos[1] + (measured?.height ?? 160)]
      })
      const [x0, y0] = [Math.min(...sized.map((b) => b[0])) - 30, Math.min(...sized.map((b) => b[1])) - 50]
      const [x1, y1] = [Math.max(...sized.map((b) => b[2])) + 30, Math.max(...sized.map((b) => b[3])) + 30]
      rect = [Math.round(x0), Math.round(y0), Math.round(x1 - x0), Math.round(y1 - y0)]
    } else {
      const p = at ?? flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
      rect = [Math.round(p.x), Math.round(p.y), 400, 300]
    }
    void save((g) => ({
      ...g,
      groups: [
        ...(g.groups ?? []),
        { id: `group-${newId().slice(-6)}`, title: title.trim(), color: '', rect },
      ],
    }))
  }

  /** M: bypass the selected nodes (or bring them back); Ctrl+G: group them. */
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable) return
    const selected = graph.nodes.filter((n) => nodes.find((x) => x.id === n.id)?.selected).map((n) => n.id)
    if ((e.key === 'm' || e.key === 'M') && !e.ctrlKey && !e.metaKey && selected.length) {
      e.preventDefault()
      const off = !graph.nodes.filter((n) => selected.includes(n.id)).every((n) => n.bypass)
      void save((g) => ({
        ...g,
        nodes: g.nodes.map((n) => (selected.includes(n.id) ? { ...n, bypass: off } : n)),
      }))
    } else if ((e.key === 'g' || e.key === 'G') && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
      e.preventDefault()
      void group()
    }
  }

  const link = (g: Graph, edge: GraphEdge): Graph => {
    const target = socketOf(types, g, edge.target, edge.input, 'in')
    // A single input takes one link: the new one replaces the old (a reroute: one in).
    const kept = g.edges.filter(
      (e) =>
        !(e.target === edge.target && e.input === edge.input && (!target?.multi || e.source === edge.source)),
    )
    return { ...g, edges: [...kept, edge] }
  }

  const isValidConnection = (c: Connection | Edge) => {
    if (c.source === c.target) return false
    // A reroute takes what comes; what leaves it is what came in.
    if (kindOf(c.target) === 'reroute') return true
    const fromType =
      kindOf(c.source) === 'reroute'
        ? rerouteType(types, graph, c.source)
        : socketOf(types, graph, c.source, c.sourceHandle ?? '', 'out')?.type
    const to = socketOf(types, graph, c.target, c.targetHandle ?? '', 'in')
    return Boolean(
      to &&
        (fromType === undefined
          ? kindOf(c.source) === 'reroute'
          : compatible(fromType as Socket['type'], to.type)),
    )
  }

  const onConnect = (c: Connection) => {
    if (!c.sourceHandle || !c.targetHandle) return
    const edge = { source: c.source, output: c.sourceHandle, target: c.target, input: c.targetHandle }
    void save((g) => link(g, edge))
  }

  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    if (state.isValid || !state.fromNode || !state.fromHandle?.id) return
    const point = 'changedTouches' in event ? event.changedTouches[0] : event
    const side = state.fromHandle.type
    const socket = socketOf(
      types,
      graph,
      state.fromNode.id,
      state.fromHandle.id,
      side === 'source' ? 'out' : 'in',
    )
    if (!socket) return
    setPending({
      at: flow.screenToFlowPosition({ x: point.clientX, y: point.clientY }),
      from: { node: state.fromNode.id, socket: socket.name, type: socket.type, side },
    })
  }

  const onEdgesDelete = (deleted: Edge[]) => {
    const ids = new Set(deleted.map((e) => e.id))
    void save((g) => ({
      ...g,
      edges: g.edges.filter((e) => !ids.has(`${e.source}.${e.output}->${e.target}.${e.input}`)),
    }))
  }

  const addNode = (info: NodeTypeInfo) => {
    if (!pending) return
    const id = `${info.type.split('/')[1]}-${newId().slice(-6)}`
    const at = [Math.round(pending.at.x), Math.round(pending.at.y)] as [number, number]
    if (info.category === 'Canvas') {
      const from = pending.from
      setPending(null)
      setQuery('')
      if (info.type === 'canvas/group') {
        void group(pending.at)
        return
      }
      void save((g) =>
        info.type === 'canvas/note'
          ? { ...g, notes: [...(g.notes ?? []), { id, text: '', pos: at, size: null }] }
          : {
              ...g,
              reroutes: [...(g.reroutes ?? []), { id, pos: at }],
              edges:
                from?.side === 'source'
                  ? [...g.edges, { source: from.node, output: from.socket, target: id, input: 'in' }]
                  : g.edges,
            },
      )
      return
    }
    const node = {
      id,
      type: info.type,
      version: info.version ?? 1,
      pos: at,
      size: null,
      params: {},
    }
    const from = pending.from
    setPending(null)
    setQuery('')
    void save((g) => {
      let next: Graph = { ...g, nodes: [...g.nodes, node] }
      if (from) {
        const match = (sockets: Socket[], dir: 'in' | 'out') =>
          sockets.find((s) => (dir === 'in' ? compatible(from.type, s.type) : compatible(s.type, from.type)))
        if (from.side === 'source') {
          const input = match(info.inputs, 'in')
          if (input)
            next = link(next, { source: from.node, output: from.socket, target: id, input: input.name })
        } else {
          const output = match(info.outputs, 'out')
          if (output)
            next = link(next, { source: id, output: output.name, target: from.node, input: from.socket })
        }
      }
      return next
    })
  }

  const choices = [...types.values(), ...CANVAS_ITEMS].filter((info) => {
    const from = pending?.from
    if (info.category === 'Canvas') return !from || (info.type === 'canvas/reroute' && from.side === 'source')
    if (!from) return true
    return from.side === 'source'
      ? info.inputs.some((s) => compatible(from.type, s.type))
      : info.outputs.some((s) => compatible(s.type, from.type))
  })
  // Own ranking: a title that starts with the query beats a word buried in a description.
  const q = query.trim().toLowerCase()
  const ranked = q
    ? choices
        .map((info) => {
          const title = info.title.toLowerCase()
          const score = title.startsWith(q)
            ? 4
            : title.includes(q)
              ? 3
              : `${info.type} ${info.category}`.toLowerCase().includes(q)
                ? 2
                : info.description.toLowerCase().includes(q)
                  ? 1
                  : 0
          return { info, score }
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((r) => r.info)
    : choices
  const categories = q ? ['Matches'] : [...new Set(choices.map((c) => c.category))]

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: double-click on the canvas adds a node (also a toolbar button)
    <div
      className="h-full w-full"
      onKeyDown={onKeyDown}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.react-flow__node:not(.react-flow__node-group)')) return
        setPending({ at: flow.screenToFlowPosition({ x: e.clientX, y: e.clientY }) })
      }}
      data-testid="graph-canvas"
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onSelectionChange={({ nodes: chosen }) => {
          const one = chosen.length === 1 && chosen[0].type === 'card' ? chosen[0].id : null
          if (useGraph.getState().selected !== one) useGraph.setState({ selected: one })
        }}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onConnectEnd={onConnectEnd}
        onEdgesDelete={onEdgesDelete}
        isValidConnection={isValidConnection}
        colorMode={theme}
        zoomOnDoubleClick={false}
        deleteKeyCode={['Delete', 'Backspace']}
        minZoom={0.2}
        fitView
        fitViewOptions={{ padding: 0.2, maxZoom: 1 }}
      >
        <Background gap={20} />
        <Controls showInteractive={false}>
          <ControlButton
            onClick={() => setMap(!map)}
            title={map ? 'Hide the overview map' : 'Show an overview map'}
            aria-label="Toggle overview map"
          >
            <MapIcon />
          </ControlButton>
        </Controls>
        {map && <MiniMap pannable zoomable position="top-right" className="!h-24 !w-36" />}
      </ReactFlow>
      <CommandDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (open) return
          setPending(null)
          setQuery('')
        }}
        shouldFilter={false}
        title="Add node"
        description="Search the node catalog"
      >
        <CommandInput
          placeholder="Add node… (simulation, signal, expression, measure, plot)"
          value={query}
          onValueChange={setQuery}
        />
        <CommandList>
          <CommandEmpty>No matching node.</CommandEmpty>
          {categories.map((category) => (
            <CommandGroup key={category} heading={category}>
              {ranked
                .filter((c) => q || c.category === category)
                .map((info) => (
                  <CommandItem
                    key={info.type}
                    value={info.title}
                    keywords={[info.type, info.category, info.description]}
                    onSelect={() => addNode(info)}
                  >
                    <div>
                      <div>{info.title}</div>
                      <div className="text-xs text-muted-foreground">{info.description}</div>
                    </div>
                  </CommandItem>
                ))}
            </CommandGroup>
          ))}
        </CommandList>
      </CommandDialog>
      <AddButton
        onAdd={() =>
          setPending({
            at: flow.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 }),
          })
        }
      />
    </div>
  )
}

/** Exposes "add node" to the toolbar outside the React Flow provider. */
function AddButton({ onAdd }: { onAdd: () => void }) {
  useEffect(() => {
    window.addEventListener('bpt:graph-add-node', onAdd)
    return () => window.removeEventListener('bpt:graph-add-node', onAdd)
  }, [onAdd])
  return null
}

export function GraphPanel() {
  const project = useProject((s) => s.project)
  const graphs = project?.graphs ?? []
  const { active, setActive, loadTypes, running, run, cancel, save, remove } = useGraph()
  const graph = graphs.find((g) => g.name === active) ?? graphs[0] ?? null
  const busy = graph ? running[graph.name] : false

  useEffect(() => {
    void loadTypes()
  }, [loadTypes])

  // Auto-run: after a change of the document (schematic or graph), unless a run is slow.
  const [auto, setAutoState] = useState(() => readAuto(graph?.name))
  useEffect(() => setAutoState(readAuto(graph?.name)), [graph?.name])
  const setAuto = (on: boolean) => {
    setAutoState(on)
    try {
      localStorage.setItem(`bpt.graph.auto.${graph?.name}`, on ? '1' : '')
    } catch {
      // not remembered
    }
  }
  const states = useGraph((s) => (graph ? s.states[graph.name] : undefined))
  const selected = useGraph((s) => s.selected)
  const [inspector, setInspectorState] = useState(() => readFlag('bpt.graph.inspector', true))
  const setInspector = (on: boolean) => {
    setInspectorState(on)
    writeFlag('bpt.graph.inspector', on)
  }
  const slowest = Math.max(0, ...Object.values(states ?? {}).map((st) => st.duration_s))
  const autoPaused = auto && slowest > AUTO_LIMIT_S
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run when the document changes
  useEffect(() => {
    if (!auto || autoPaused || !graph) return
    const timer = setTimeout(() => {
      if (!useGraph.getState().running[graph.name]) void run(graph.name)
    }, 600)
    return () => clearTimeout(timer)
  }, [project, auto])
  useEffect(() => {
    if (graph && graph.name !== active) setActive(graph.name)
  }, [graph, active, setActive])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && graph) {
        e.preventDefault()
        void run(graph.name)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [graph, run])

  const create = async (templateId: string) => {
    const template = TEMPLATES.find((t) => t.id === templateId)
    if (!template) return
    let initial = template.title
    for (let n = 2; graphs.some((g) => g.name === initial); n++) initial = `${template.title} ${n}`
    const name = await prompt({ title: 'New analysis graph', label: 'Name', initial })
    if (!name?.trim()) return
    const clean = name.trim().replace(/[\\/:*?"<>|]/g, '-')
    if (graphs.some((g) => g.name === clean)) {
      toast.error(`A graph named “${clean}” already exists`, { description: 'Choose another name.' })
      return
    }
    const labels = (project?.sheets ?? []).flatMap((s) => s.labels.map((l) => l.text))
    const signal = labels.includes('out') ? 'V(out)' : labels[0] ? `V(${labels[0]})` : 'V(out)'
    if (await save(template.build(clean, signal))) setActive(clean)
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-1 border-b px-2 py-1 text-xs">
        <div className="flex gap-0.5 overflow-x-auto">
          {graphs.map((g) => (
            <button
              type="button"
              key={g.name}
              onClick={() => setActive(g.name)}
              className={`rounded px-2 py-0.5 ${graph?.name === g.name ? 'bg-muted font-medium' : 'text-muted-foreground'}`}
            >
              {g.name}
            </button>
          ))}
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
              <Plus /> New graph
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>Start from</DropdownMenuLabel>
            {TEMPLATES.map((t) => (
              <DropdownMenuItem key={t.id} onSelect={() => setTimeout(() => create(t.id), 0)}>
                <div>
                  <div>{t.title}</div>
                  <div className="text-xs text-muted-foreground">{t.description}</div>
                </div>
              </DropdownMenuItem>
            ))}
            {graph && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem className="text-destructive" onSelect={() => remove(graph.name)}>
                  <Trash2 /> Delete “{graph.name}”
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="ml-auto flex items-center gap-1">
          {graph && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              title="Add node (or double-click the canvas)"
              onClick={() => window.dispatchEvent(new Event('bpt:graph-add-node'))}
            >
              <Plus /> Node
            </Button>
          )}
          {graph && (
            <Button
              variant={inspector ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2 text-xs"
              aria-pressed={inspector}
              title="Show the selected node's parameters, sockets and log on the right"
              onClick={() => setInspector(!inspector)}
            >
              <PanelRight /> Inspector
            </Button>
          )}
          {graph && (
            <label
              className="flex items-center gap-1 text-xs text-muted-foreground"
              title={
                autoPaused
                  ? 'Paused: the last run took longer than 2 s – press F5 to run it'
                  : 'Run again after every change of the schematic or the graph (unchanged parts come from the cache)'
              }
            >
              <input
                type="checkbox"
                className="size-3.5"
                aria-label="Run automatically"
                checked={auto}
                onChange={(e) => setAuto(e.target.checked)}
              />
              Auto{autoPaused ? ' (paused)' : ''}
            </label>
          )}
          {busy ? (
            <Button variant="destructive" size="sm" className="h-7 px-2 text-xs" onClick={() => cancel()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!graph}
              onClick={() => graph && run(graph.name)}
            >
              <Play /> Run graph <kbd className="ml-1 text-[10px] opacity-70">F5</kbd>
            </Button>
          )}
          {busy && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        {graph ? (
          <>
            <div className="min-w-0 flex-1">
              <ReactFlowProvider key={graph.name}>
                <Canvas graph={graph} />
              </ReactFlowProvider>
            </div>
            {selected && inspector && (
              <NodeInspector graph={graph} nodeId={selected} onClose={() => setInspector(false)} />
            )}
          </>
        ) : (
          <div className="flex h-full flex-1 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <p>
              Analysis graphs chain simulations, calculations and plots. Results update where they changed.
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {TEMPLATES.slice(1).map((t) => (
                <Button key={t.id} variant="outline" onClick={() => create(t.id)}>
                  {t.title}
                </Button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
