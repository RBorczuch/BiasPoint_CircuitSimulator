/**
 * What organises a graph's canvas (graf.md §11, G1): groups (a titled frame around nodes, moved
 * with them), notes (text) and reroutes (a point an edge passes through). They are kept in the
 * graph (format 2) and changed with `set_graph` like the nodes.
 */
import { Handle, type NodeProps, NodeResizer, Position } from '@xyflow/react'
import { memo } from 'react'
import type { Graph } from '@/api/types'
import { cn } from '@/lib/utils'
import { prompt } from '@/store/dialogs'
import { editGraph } from '@/store/graph'

export interface GroupData extends Record<string, unknown> {
  graph: string
  id: string
  title: string
  color: string
}

export interface NoteData extends Record<string, unknown> {
  graph: string
  id: string
  text: string
}

export const GROUP_COLORS: Record<string, string> = {
  '': 'rgb(113 113 122 / 0.10)',
  violet: 'rgb(139 92 246 / 0.12)',
  sky: 'rgb(14 165 233 / 0.12)',
  emerald: 'rgb(16 185 129 / 0.12)',
  amber: 'rgb(245 158 11 / 0.14)',
  rose: 'rgb(244 63 94 / 0.12)',
}

const nextColor = (color: string) => {
  const names = Object.keys(GROUP_COLORS)
  return names[(names.indexOf(color) + 1) % names.length]
}

export const GroupFrame = memo(function GroupFrame({ data, selected }: NodeProps) {
  const { graph, id, title, color } = data as GroupData
  const set = (patch: Partial<{ title: string; color: string; rect: [number, number, number, number] }>) =>
    void editGraph(graph, (g: Graph) => ({
      ...g,
      groups: (g.groups ?? []).map((grp) => (grp.id === id ? { ...grp, ...patch } : grp)),
    }))
  return (
    <div
      className={cn('h-full w-full rounded-lg border-2 border-dashed', selected && 'border-primary')}
      style={{ background: GROUP_COLORS[color] ?? GROUP_COLORS[''] }}
      data-testid={`graph-group-${id}`}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={160}
        minHeight={100}
        onResizeEnd={(_e, p) =>
          set({ rect: [Math.round(p.x), Math.round(p.y), Math.round(p.width), Math.round(p.height)] })
        }
      />
      <div className="flex items-center gap-2 px-2 py-1">
        <button
          type="button"
          className="text-sm font-semibold text-foreground/80 hover:underline"
          title="Rename the group"
          onClick={async () => {
            const next = await prompt({ title: 'Group title', label: 'Title', initial: title })
            if (next !== null) set({ title: next.trim() })
          }}
        >
          {title || 'Group'}
        </button>
        <button
          type="button"
          className="size-3 rounded-full border"
          style={{ background: GROUP_COLORS[nextColor(color)] }}
          aria-label="Next colour of the group"
          title="Colour"
          onClick={() => set({ color: nextColor(color) })}
        />
      </div>
    </div>
  )
})

export const NoteCard = memo(function NoteCard({ data, selected }: NodeProps) {
  const { graph, id, text } = data as NoteData
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: a double-click edits the note (a canvas item, selected with the keyboard by React Flow)
    <div
      className={cn(
        'h-full min-h-12 w-full min-w-40 rounded-md border bg-amber-50 p-2 text-xs whitespace-pre-wrap text-amber-950 shadow-sm dark:bg-amber-950/40 dark:text-amber-100',
        selected && 'ring-2 ring-primary',
      )}
      data-testid={`graph-note-${id}`}
      title="Double-click to edit"
      onDoubleClick={async (e) => {
        e.stopPropagation()
        const next = await prompt({ title: 'Note', label: 'Text', initial: text, multiline: true })
        if (next === null) return
        void editGraph(graph, (g: Graph) => ({
          ...g,
          notes: (g.notes ?? []).map((n) => (n.id === id ? { ...n, text: next } : n)),
        }))
      }}
    >
      <NodeResizer
        isVisible={selected}
        minWidth={120}
        minHeight={40}
        onResizeEnd={(_e, p) =>
          void editGraph(graph, (g: Graph) => ({
            ...g,
            notes: (g.notes ?? []).map((n) =>
              n.id === id
                ? {
                    ...n,
                    pos: [Math.round(p.x), Math.round(p.y)],
                    size: [Math.round(p.width), Math.round(p.height)],
                  }
                : n,
            ),
          }))
        }
      />
      {text || 'Note'}
    </div>
  )
})

export const Reroute = memo(function Reroute({ selected }: NodeProps) {
  return (
    <div
      className={cn(
        'size-3 rounded-full border-2 border-muted-foreground bg-card',
        selected && 'border-primary',
      )}
      title="Reroute: the edge passes through"
    >
      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="!size-2 !min-h-0 !min-w-0 !opacity-0"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="out"
        className="!size-2 !min-h-0 !min-w-0 !opacity-0"
      />
    </div>
  )
})
