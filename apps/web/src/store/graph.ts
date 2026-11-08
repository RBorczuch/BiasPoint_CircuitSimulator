/** Analysis graphs (node.md): node catalog, active graph, node states from backend events. */
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiGet, apiPost } from '@/api/client'
import { events } from '@/api/events'
import type { Graph, GraphResults, NodeState, NodeTypeInfo } from '@/api/types'
import { pendingEdits, useProject } from './project'

interface GraphState {
  types: Map<string, NodeTypeInfo>
  active: string | null
  states: Record<string, Record<string, NodeState>> // graph -> node -> state
  running: Record<string, boolean>
  versions: Record<string, number> // node -> bumped when its results change (previews refetch)
  selected: string | null // the one node selected on the canvas (shown in the inspector)
  loadTypes: () => Promise<void>
  setActive: (name: string | null) => void
  save: (graph: Graph) => Promise<boolean>
  remove: (name: string) => Promise<void>
  run: (name?: string) => Promise<void>
  cancel: () => Promise<void>
  loadResults: (name: string) => Promise<void>
}

const graphPath = (name: string, suffix: string) =>
  `/api/projects/${useProject.getState().info?.id}/graphs/${encodeURIComponent(name)}${suffix}`

/** The graph being edited (the active one, else the first of the project). */
export function activeGraph(): Graph | null {
  const graphs = useProject.getState().project?.graphs ?? []
  const active = useGraph.getState().active
  return graphs.find((g) => g.name === active) ?? graphs[0] ?? null
}

export const useGraph = create<GraphState>((set, get) => ({
  types: new Map(),
  active: null,
  states: {},
  running: {},
  versions: {},
  selected: null,

  loadTypes: async () => {
    if (get().types.size) return
    try {
      const list = await apiGet<NodeTypeInfo[]>('/api/graph/node-types')
      set({ types: new Map(list.map((t) => [t.type, t])) })
    } catch (error) {
      toast.error(`Node types: ${error instanceof Error ? error.message : String(error)}`)
    }
  },

  setActive: (active) => {
    set({ active, selected: active === get().active ? get().selected : null })
    if (active) void get().loadResults(active)
  },

  save: (graph) => useProject.getState().execute({ type: 'set_graph', name: graph.name, graph }),

  remove: async (name) => {
    await useProject.getState().execute({ type: 'set_graph', name, graph: null })
    if (get().active === name) set({ active: null })
  },

  run: async (name) => {
    const target = name ?? activeGraph()?.name
    if (!target || !useProject.getState().info) return
    set({ running: { ...get().running, [target]: true } })
    try {
      await pendingEdits()
      await apiPost<GraphResults>(graphPath(target, '/run'))
    } catch (error) {
      set({ running: { ...get().running, [target]: false } })
      toast.error(error instanceof Error ? error.message : String(error))
    }
  },

  cancel: async () => {
    const target = activeGraph()?.name
    if (target) await apiPost(graphPath(target, '/cancel')).catch(() => undefined)
  },

  loadResults: async (name) => {
    if (!useProject.getState().info) return
    try {
      const seen = eventCount
      const results = await apiGet<GraphResults>(graphPath(name, '/results'))
      if (eventCount !== seen) return // a run's events came first: they are newer
      set({
        states: { ...get().states, [name]: results.nodes },
        running: { ...get().running, [name]: results.status === 'running' },
      })
    } catch {
      // graph not saved yet
    }
  },
}))

/** Counts graph events: results fetched while events came in are older than the events. */
let eventCount = 0

/** Follow graph.node / graph.finished events of the open project. */
export function installGraphSync(): () => void {
  const offEvents = events.on((event) => {
    if (event.type !== 'graph.node' && event.type !== 'graph.finished') return
    if (event.project_id !== useProject.getState().info?.id) return
    eventCount += 1
    const { states, versions, running } = useGraph.getState()
    if (event.type === 'graph.node') {
      const graph = { ...(states[event.graph] ?? {}), [event.node]: event.state }
      const done = event.state.status === 'ok' || event.state.status === 'cached'
      useGraph.setState({
        states: { ...states, [event.graph]: graph },
        versions: done ? { ...versions, [event.node]: (versions[event.node] ?? 0) + 1 } : versions,
        running: { ...running, [event.graph]: true },
      })
    } else {
      // Previews fetched while the run went on may have raced the results being stored:
      // the finished run makes every node with results refetch once more.
      const bumped = { ...versions }
      for (const [node, state] of Object.entries(states[event.graph] ?? {}))
        if (state.status === 'ok' || state.status === 'cached') bumped[node] = (bumped[node] ?? 0) + 1
      useGraph.setState({ running: { ...running, [event.graph]: false }, versions: bumped })
    }
  })
  const offProject = useProject.subscribe((state, prev) => {
    if (state.info?.id !== prev.info?.id)
      useGraph.setState({ active: null, states: {}, running: {}, versions: {}, selected: null })
  })
  return () => {
    offEvents()
    offProject()
  }
}

/** Change a saved graph (one undo step). */
export async function editGraph(name: string, change: (graph: Graph) => Graph): Promise<boolean> {
  const graph = useProject.getState().project?.graphs.find((g) => g.name === name)
  if (!graph) return false
  return useGraph.getState().save(change(structuredClone(graph)))
}
