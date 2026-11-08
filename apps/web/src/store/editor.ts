import { create } from 'zustand'
import type { LabelKind, Point, Rotation, TextField, TextPlace } from '@/api/types'

export type Tool =
  | { kind: 'select' }
  | { kind: 'wire'; points: Point[]; horizontalFirst: boolean; bus?: boolean }
  | { kind: 'place'; symbolId: string; rot: Rotation; mirror: boolean; params?: Record<string, string> }
  | { kind: 'label'; text: string; labelKind: LabelKind }
  | { kind: 'junction' }
  | { kind: 'directive'; text: string }
  | { kind: 'probe' }
  | { kind: 'highlight' }

export interface ContextMenuState {
  client: Point // where to show the menu (page coordinates)
  world: Point // snapped schematic point that was clicked
  target: { kind: 'instances' | 'wires' | 'labels' | 'junctions' | 'directives' | 'empty'; id?: string }
}

export type WirePart = { kind: 'segment'; index: number } | { kind: 'end'; which: 'start' | 'end' }

/** A wire being reshaped by dragging one of its segments or ends. */
export interface WireEdit {
  wireId: string
  part: WirePart
  delta: Point
}

export interface View {
  scale: number // screen px per world unit
  x: number // screen position of world origin
  y: number
}

/** Selected objects being moved (mouse drag or M / G): world offset of the preview. */
export interface MovePreview {
  delta: Point
  stretchWires: boolean // G (drag): attached wire ends follow
  fromKeyboard: boolean // M / G: follows the cursor until click
  anchor: Point
}

/** A part's reference or value being dragged (or turned) on the canvas. */
export interface TextDrag {
  id: string // the instance
  field: TextField
  place: TextPlace
}

interface EditorState {
  selection: Set<string>
  tool: Tool
  view: View
  cursor: Point
  pointerInside: boolean
  hover: string | null // object under the pointer (select tool)
  highlightNet: string | null
  contextMenu: ContextMenuState | null
  wireEdit: WireEdit | null
  flash: Set<string> // objects changed elsewhere, highlighted briefly
  move: MovePreview | null
  textDrag: TextDrag | null
  boxSelect: { from: Point; to: Point } | null
  select: (ids: Iterable<string>, mode?: 'replace' | 'add' | 'toggle') => void
  clearSelection: () => void
  setTool: (tool: Tool) => void
  setView: (view: View) => void
  setCursor: (cursor: Point) => void
  setPointerInside: (inside: boolean) => void
  setHover: (id: string | null) => void
  setHighlightNet: (net: string | null) => void
  setContextMenu: (menu: ContextMenuState | null) => void
  setWireEdit: (edit: WireEdit | null) => void
  setMove: (move: MovePreview | null) => void
  setTextDrag: (drag: TextDrag | null) => void
  setBoxSelect: (box: { from: Point; to: Point } | null) => void
}

export const DEFAULT_VIEW: View = { scale: 0.1, x: 400, y: 300 }

export const useEditor = create<EditorState>((set, get) => ({
  selection: new Set(),
  tool: { kind: 'select' },
  view: DEFAULT_VIEW,
  cursor: [0, 0],
  pointerInside: false,
  hover: null,
  highlightNet: null,
  contextMenu: null,
  wireEdit: null,
  flash: new Set(),
  move: null,
  textDrag: null,
  boxSelect: null,
  select: (ids, mode = 'replace') => {
    const next = mode === 'replace' ? new Set<string>() : new Set(get().selection)
    for (const id of ids) {
      if (mode === 'toggle' && next.has(id)) next.delete(id)
      else next.add(id)
    }
    set({ selection: next })
  },
  clearSelection: () => set({ selection: new Set() }),
  // Hover highlights belong to the select / probe tools: a new tool starts without one.
  setTool: (tool) => set(tool.kind === get().tool.kind ? { tool } : { tool, hover: null }),
  setView: (view) => set({ view }),
  setCursor: (cursor) => set({ cursor }),
  setPointerInside: (pointerInside) => set({ pointerInside }),
  setHover: (hover) => {
    if (hover !== get().hover) set({ hover })
  },
  setHighlightNet: (highlightNet) => set({ highlightNet }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
  setWireEdit: (wireEdit) => set({ wireEdit }),
  setMove: (move) => set({ move }),
  setTextDrag: (textDrag) => set({ textDrag }),
  setBoxSelect: (boxSelect) => set({ boxSelect }),
}))

let flashTimer: ReturnType<typeof setTimeout> | undefined

/** Briefly highlight objects (e.g. changed by an AI agent). */
export function flashObjects(ids: string[]): void {
  clearTimeout(flashTimer)
  useEditor.setState({ flash: new Set(ids) })
  flashTimer = setTimeout(() => useEditor.setState({ flash: new Set() }), 2500)
}
