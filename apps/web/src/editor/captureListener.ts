/** Answers the backend's `ui.capture` requests (screenshots for AI agents, FR-AI-6). */
import { apiPost } from '@/api/client'
import { events } from '@/api/events'
import { CAPTURE_TARGETS, captureElement } from '@/lib/screenshot'
import { activeGraph, useGraph } from '@/store/graph'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'

/** Text next to a DOM picture: what is plotted / which graph, so the agent need not guess. */
export function describeView(target: string): Record<string, unknown> {
  const { meta, traces } = useSimulation.getState()
  const lines: string[] = []
  if (target === 'plot' || target === 'window') {
    if (meta)
      lines.push(`last run: ${meta.analysis.kind.toUpperCase()} ${meta.status}, ${meta.points} points`)
    const shown = traces.filter((t) => !t.hidden).map((t) => t.expr)
    if (shown.length) lines.push(`plotted: ${shown.join(', ')}`)
  }
  if (target === 'graph' || target === 'window') {
    const graph = activeGraph()
    if (graph) {
      const states = useGraph.getState().states[graph.name] ?? {}
      const failed = Object.entries(states).filter(([, s]) => s.status === 'error')
      lines.push(
        `graph ${graph.name}: ${graph.nodes.length} nodes${failed.length ? `, errors in ${failed.map(([id]) => id).join(', ')}` : ''}`,
      )
    }
  }
  return { lines }
}

export function installCaptureListener(): () => void {
  return events.on((event) => {
    if (event.type !== 'ui.capture') return
    if (event.project_id !== useProject.getState().info?.id) return // another window's project
    const reply = (body: Record<string, unknown>) =>
      apiPost(`/api/capture/${event.request_id}/result`, body).catch(() => undefined)
    const dom = CAPTURE_TARGETS[event.target]
    if (dom) {
      // Window, plot or graph: a picture of the DOM as the user sees it.
      const element = document.querySelector<HTMLElement>(dom.selector)
      if (!element) {
        void reply({ error: `${dom.where} is not open; ask the user to show it, or capture "schematic"` })
        return
      }
      captureElement(element, event.max_px)
        .then((image) =>
          reply({ image: image.split(',', 2)[1], mime: 'image/png', meta: describeView(event.target) }),
        )
        .catch((error) => reply({ error: error instanceof Error ? error.message : String(error) }))
      return
    }
    try {
      if (!window.__bpt) throw new Error('the schematic editor is not open (Schematic workspace)')
      const { image, meta } = window.__bpt.capture(event.target, event.max_px)
      void reply({ image: image.split(',', 2)[1], mime: 'image/png', meta })
    } catch (error) {
      void reply({ error: error instanceof Error ? error.message : String(error) })
    }
  })
}
