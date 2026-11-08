/**
 * Symbol editor, a full-size tab next to the schematic: drawing primitives, pins (number, name, electrical type, orientation),
 * reference / value positions and the SPICE mapping (element + pin order). Saves into a user
 * library; built-in and imported symbols are edited as a copy. In block mode it draws the
 * symbol of a hierarchical sheet: pins are the sheet's ports (FR-HIE-5).
 */
import {
  Circle,
  Expand,
  Maximize,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Spline,
  Square,
  Trash2,
  Type,
  Undo2,
  Zap,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiGet, apiPost } from '@/api/client'
import type { Graphic, Orientation, Pin, Point, SymbolDef } from '@/api/types'
import { arcPoints } from '@/components/SymbolPreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { choose, prompt } from '@/store/dialogs'
import { reloadLibrary, useProject } from '@/store/project'

const G = 127 // pin grid (1.27 mm)
const FINE = 25 // drawing grid
const DIRS: Record<Orientation, Point> = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }
const PIN_TYPES = ['passive', 'input', 'output', 'bidirectional', 'power_in', 'power_out']
const ELEMENTS = ['', 'R', 'C', 'L', 'D', 'Q', 'M', 'J', 'V', 'I', 'E', 'G', 'B', 'S', 'X']
const ELEMENT_HELP: Record<string, string> = {
  '': 'not simulated (drawing only)',
  R: 'resistor: 2 pins',
  C: 'capacitor: 2 pins',
  L: 'inductor: 2 pins',
  D: 'diode: anode, cathode',
  Q: 'BJT: collector, base, emitter',
  M: 'MOSFET: drain, gate, source, bulk',
  J: 'JFET: drain, gate, source',
  V: 'voltage source: +, -',
  I: 'current source: +, -',
  E: 'VCVS: out+, out-, in+, in-',
  G: 'VCCS: out+, out-, in+, in-',
  B: 'behavioural source: +, -',
  S: 'switch: 1, 2, ctrl+, ctrl-',
  X: 'subcircuit model: pins in the order of the model',
}

type Tool = 'select' | 'line' | 'rect' | 'circle' | 'arc' | 'text' | 'pin'
type Selected = { kind: 'graphic' | 'pin'; index: number } | { kind: 'ref' | 'value' } | null
/** Where the symbol goes: a user library, or the block of a sheet (pins = its ports). */
type Target =
  | { kind: 'library'; library: string; basedOn?: string } // basedOn: the symbol it was copied from
  | { kind: 'block'; sheet: string; ports: string[]; drawn: boolean }

const useSymbolEditor = create<{
  symbol: SymbolDef | null
  target: Target
  open: (symbol: SymbolDef | null, target?: Target) => void
  close: () => void
}>((set) => ({
  symbol: null,
  target: { kind: 'library', library: 'My symbols' },
  open: (symbol, target) =>
    set({
      symbol: symbol ?? EMPTY,
      target: target ?? { kind: 'library', library: 'My symbols' },
    }),
  close: () => set({ symbol: null }),
}))

const PANEL = 'symbolEditor'

function showPanel(): void {
  window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: PANEL }))
}

/** Close the editor's tab (unsaved changes were dealt with by the caller). */
export function closeSymbolEditor(): void {
  useSymbolEditor.getState().close()
  window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
}

const EMPTY: SymbolDef = {
  id: '',
  name: 'NEW',
  description: '',
  ref_prefix: 'U',
  pins: [],
  graphics: [],
  spice: null,
  power_net: null,
  default_params: {},
  default_model: null,
  category: 'My symbols',
  ref_at: [254, -254],
  value_at: [254, 254],
  value_param: null,
  parasitics: [],
}

/** Open the editor on a symbol: user symbols in place, others as an editable copy. */
export function editSymbol(symbol: SymbolDef | null): void {
  showPanel()
  if (!symbol) {
    useSymbolEditor.getState().open(null)
    return
  }
  const own = symbol.id.startsWith('user:')
  useSymbolEditor.getState().open(
    own
      ? { ...structuredClone(symbol), changes: '' } // what changes now: typed by the user
      : { ...structuredClone(symbol), id: '', name: `${symbol.name}_copy`, version: 1, changes: '' },
    { kind: 'library', library: own ? symbol.category : 'My symbols', basedOn: own ? undefined : symbol.id },
  )
}

/** Draw the block symbol of a sheet, starting from its current one (drawn or automatic). */
export function editBlockSymbol(sheetName: string): void {
  const { project, symbols } = useProject.getState()
  const sheet = project?.sheets.find((s) => s.name === sheetName)
  const current = symbols.get(`sheet:${sheetName}`)
  if (!sheet || !current) return
  showPanel()
  const ports = current.pins.map((p) => p.number) // the block always has a pin per port
  useSymbolEditor.getState().open(structuredClone(sheet.symbol ?? current), {
    kind: 'block',
    sheet: sheetName,
    ports,
    drawn: Boolean(sheet.symbol),
  })
}

const snap = (v: number, step: number) => Math.round(v / step) * step
const pt = (p: Point) => p.join(',')

function distToSegment([px, py]: Point, [ax, ay]: Point, [bx, by]: Point): number {
  const dx = bx - ax
  const dy = by - ay
  const len = dx * dx + dy * dy
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

function graphicDistance(g: Graphic, p: Point): number {
  const path = (points: Point[]) => Math.min(...points.slice(1).map((b, i) => distToSegment(p, points[i], b)))
  switch (g.kind) {
    case 'polyline':
      return path(g.points)
    case 'rect': {
      const [x0, y0] = g.start
      const [x1, y1] = g.end
      return path([g.start, [x1, y0], g.end, [x0, y1], g.start])
    }
    case 'circle':
      return Math.abs(Math.hypot(p[0] - g.center[0], p[1] - g.center[1]) - g.radius)
    case 'arc':
      return path(arcPoints(g.start, g.mid, g.end))
    case 'text':
      return Math.hypot(p[0] - g.at[0], p[1] - g.at[1]) - g.size
  }
}

function moveGraphic(g: Graphic, [dx, dy]: Point): Graphic {
  const m = ([x, y]: Point): Point => [x + dx, y + dy]
  switch (g.kind) {
    case 'polyline':
      return { ...g, points: g.points.map(m) }
    case 'rect':
      return { ...g, start: m(g.start), end: m(g.end) }
    case 'circle':
      return { ...g, center: m(g.center) }
    case 'arc':
      return { ...g, start: m(g.start), mid: m(g.mid), end: m(g.end) }
    case 'text':
      return { ...g, at: m(g.at) }
  }
}

/** A box with pins named in the order given: first half on the left, the rest on the right. */
function quickBox(names: string[]): Pick<SymbolDef, 'pins' | 'graphics' | 'ref_at' | 'value_at'> {
  const half = Math.ceil(names.length / 2)
  const left = names.slice(0, half)
  const right = names.slice(half)
  const rows = Math.max(left.length, right.length, 1)
  const halfW = G * Math.max(3, Math.ceil(Math.max(...names.map((n) => n.length), 1) * 0.5) + 2)
  const top = -(rows - 1) * G
  const pins: Pin[] = []
  const graphics: Graphic[] = [
    { kind: 'rect', start: [-halfW, top - G], end: [halfW, top + 2 * G * (rows - 1) + G], fill: false },
  ]
  left.forEach((name, i) => {
    const y = top + 2 * G * i
    pins.push({
      number: String(i + 1),
      name,
      at: [-halfW - 2 * G, y],
      length: 2 * G,
      orientation: 'left',
      type: 'passive',
    })
    graphics.push({ kind: 'text', at: [-halfW + 40 + name.length * 31, y], text: name, size: 100 })
  })
  right.forEach((name, i) => {
    const y = top + 2 * G * i
    pins.push({
      number: String(half + i + 1),
      name,
      at: [halfW + 2 * G, y],
      length: 2 * G,
      orientation: 'right',
      type: 'passive',
    })
    graphics.push({ kind: 'text', at: [halfW - 40 - name.length * 31, y], text: name, size: 100 })
  })
  const bottom = top + 2 * G * (rows - 1) + G
  return { pins, graphics, ref_at: [-halfW, top - G - 110], value_at: [-halfW, bottom + 110] }
}

/** Bounds of the drawing (graphics, pins, texts) for "fit". */
function drawingBox(d: SymbolDef, margin = true): { x: number; y: number; w: number; h: number } {
  const xs: number[] = []
  const ys: number[] = []
  const add = ([x, y]: Point, pad = 0) => {
    xs.push(x - pad, x + pad)
    ys.push(y - pad, y + pad)
  }
  for (const g of d.graphics) {
    if (g.kind === 'polyline') for (const p of g.points) add(p)
    if (g.kind === 'rect') for (const p of [g.start, g.end]) add(p)
    if (g.kind === 'circle') add(g.center, g.radius)
    if (g.kind === 'arc') for (const p of [g.start, g.mid, g.end]) add(p)
    if (g.kind === 'text') add(g.at, g.size)
  }
  for (const p of d.pins) add(p.at)
  if (d.ref_at) add(d.ref_at, 100)
  if (d.value_at) add(d.value_at, 100)
  if (!xs.length) return { x: -1500, y: -1000, w: 3000, h: 2000 }
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  if (!margin) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
  const w = Math.max(x1 - x0, 1000) * 1.6
  const h = Math.max(y1 - y0, 800) * 1.6
  return { x: (x0 + x1) / 2 - w / 2, y: (y0 + y1) / 2 - h / 2, w, h }
}

const same = (a: Point, b: Point) => a[0] === b[0] && a[1] === b[1]

/** Selection keys: "g3" graphic, "p1" pin, "ref", "value". */
const keyOf = (s: Selected): string | null =>
  !s
    ? null
    : s.kind === 'ref' || s.kind === 'value'
      ? s.kind
      : `${s.kind === 'graphic' ? 'g' : 'p'}${(s as { index: number }).index}`
const fromKey = (k: string | undefined): Selected =>
  !k
    ? null
    : k === 'ref' || k === 'value'
      ? { kind: k }
      : { kind: k[0] === 'g' ? 'graphic' : 'pin', index: Number(k.slice(1)) }

const shift = ([x, y]: Point, [dx, dy]: Point): Point => [x + dx, y + dy]

/** The drawing with the selected items moved by `delta`. */
function moveItems(d: SymbolDef, keys: Set<string>, delta: Point): SymbolDef {
  return {
    ...d,
    graphics: d.graphics.map((g, i) => (keys.has(`g${i}`) ? moveGraphic(g, delta) : g)),
    pins: d.pins.map((pin, i) => (keys.has(`p${i}`) ? { ...pin, at: shift(pin.at, delta) } : pin)),
    ref_at: d.ref_at && keys.has('ref') ? shift(d.ref_at, delta) : d.ref_at,
    value_at: d.value_at && keys.has('value') ? shift(d.value_at, delta) : d.value_at,
  }
}

/** Keys of everything touching the box (rubber-band selection). */
function itemsIn(d: SymbolDef, [a, b]: [Point, Point]): Set<string> {
  const [x0, x1, y0, y1] = [
    Math.min(a[0], b[0]),
    Math.max(a[0], b[0]),
    Math.min(a[1], b[1]),
    Math.max(a[1], b[1]),
  ]
  const inside = ([x, y]: Point) => x >= x0 && x <= x1 && y >= y0 && y <= y1
  const out = new Set<string>()
  d.graphics.forEach((g, i) => {
    const box = drawingBox({ ...d, graphics: [g], pins: [], ref_at: null, value_at: null }, false)
    const corners: Point[] = [
      [box.x, box.y],
      [box.x + box.w, box.y + box.h],
    ]
    // Wholly inside the box (a band across a big rectangle does not pick it up).
    if (corners.every(inside)) out.add(`g${i}`)
  })
  d.pins.forEach((pin, i) => {
    if (inside(pin.at)) out.add(`p${i}`)
  })
  if (d.ref_at && inside(d.ref_at)) out.add('ref')
  if (d.value_at && inside(d.value_at)) out.add('value')
  return out
}

const TOOL_KEYS: Record<string, Tool> = {
  s: 'select',
  v: 'select',
  l: 'line',
  r: 'rect',
  c: 'circle',
  a: 'arc',
  t: 'text',
  p: 'pin',
}

const STEPS: Record<Tool, (pending: number) => string> = {
  select: () =>
    'Click to select (Shift adds), drag on empty space for a box · drag or arrow keys move · Ctrl+A all · Delete removes',
  line: (n) =>
    n
      ? 'Click the next point · Enter, double-click or right-click ends the line'
      : 'Click where the line starts',
  rect: (n) => (n ? 'Click (or release) at the opposite corner' : 'Click or press at the first corner'),
  circle: (n) => (n ? 'Click (or release) on the circle' : 'Click or press at the centre'),
  arc: (n) => ['Click where the arc starts', 'Click a point on the arc', 'Click where the arc ends'][n] ?? '',
  text: () => 'Click where the text goes',
  pin: () => 'Click on the 1.27 mm grid where the pin connects; it points away from the centre',
}

export function SymbolEditor() {
  const initial = useSymbolEditor((s) => s.symbol)
  const target = useSymbolEditor((s) => s.target)
  const block = target.kind === 'block' ? target : null
  const [draft, setDraft] = useState<SymbolDef>(EMPTY)
  const [library, setLibrary] = useState('My symbols')
  // Save as a new symbol (''), or as another drawing of an existing one with the same pins.
  const [drawingOf, setDrawingOf] = useState('')
  // Where another drawing applies: this project's parts, new parts in every project, or only
  // offered per part in the inspector.
  const [where, setWhere] = useState<'project' | 'everywhere' | 'offered'>('project')
  const allSymbols = useProject((s) => s.symbols)
  const samePins = useMemo(() => {
    const key = (pins: Pin[]) =>
      pins
        .map((p) => `${p.number}@${p.at[0]},${p.at[1]}:${p.orientation}`)
        .sort()
        .join(' ')
    const mine = key(draft.pins)
    if (!draft.pins.length) return []
    return [...allSymbols.values()].filter(
      (s) => /^(bpt|user|kicad|std|part):/.test(s.id) && s.id !== draft.id && key(s.pins) === mine,
    )
  }, [allSymbols, draft.pins, draft.id])
  const [tool, setToolRaw] = useState<Tool>('select')
  const [selection, setSelection] = useState<Set<string>>(new Set())
  const [band, setBand] = useState<[Point, Point] | null>(null)
  const selected = selection.size === 1 ? fromKey([...selection][0]) : null
  const setSelected = (sel: Selected) => {
    const key = keyOf(sel)
    setSelection(new Set(key ? [key] : []))
  }
  const [pending, setPending] = useState<Point[]>([]) // points of the shape being drawn
  const [cursor, setCursor] = useState<Point>([0, 0])
  const [view, setView] = useState({ x: -1500, y: -1100, w: 3000, h: 2200 })
  const drag = useRef<{ from: Point; moved: boolean; start: SymbolDef; keys: Set<string> } | null>(null)
  const pan = useRef<{ client: Point; view: typeof view } | null>(null)
  const pressed = useRef<Point | null>(null) // where a rectangle / circle press started
  const space = useRef(false)
  const svg = useRef<SVGSVGElement>(null)
  const root = useRef<HTMLDivElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const history = useRef<{ past: SymbolDef[]; future: SymbolDef[] }>({ past: [], future: [] })

  useEffect(() => {
    if (!initial) return
    setDraft(initial)
    if (target.kind === 'library') setLibrary(target.library)
    // Editing a built-in or library symbol: another drawing of it, for this project.
    setDrawingOf(target.kind === 'library' && target.basedOn ? target.basedOn : '')
    setWhere('project')
    setSelection(new Set())
    setPending([])
    setToolRaw('select')
    setView(drawingBox(initial))
    history.current = { past: [], future: [] }
    root.current?.focus()
  }, [initial, target])

  /** A change of the drawing that Undo can take back. */
  const change = (next: SymbolDef) => {
    history.current.past.push(draftRef.current)
    history.current.future = []
    setDraft(next)
  }
  const undo = () => {
    const prev = history.current.past.pop()
    if (!prev) return
    history.current.future.push(draftRef.current)
    setDraft(prev)
    setSelected(null)
  }
  const redo = () => {
    const next = history.current.future.pop()
    if (!next) return
    history.current.past.push(draftRef.current)
    setDraft(next)
  }

  const setTool = (next: Tool) => {
    finishLine()
    setPending([])
    pressed.current = null
    setToolRaw(next)
  }

  const toWorld = (e: { clientX: number; clientY: number }): Point => {
    const el = svg.current
    const ctm = el?.getScreenCTM()
    if (!el || !ctm) return [0, 0]
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse())
    return [p.x, p.y]
  }

  const hit = (p: Point): Selected => {
    const tol = view.w / 120
    const marks: [Selected, Point | null][] = [
      [{ kind: 'ref' }, draft.ref_at],
      [{ kind: 'value' }, draft.value_at],
    ]
    for (const [sel, at] of marks) if (at && Math.hypot(p[0] - at[0], p[1] - at[1]) < tol * 2) return sel
    let best: Selected = null
    let bestD = tol
    draft.pins.forEach((pin, index) => {
      const [dx, dy] = DIRS[pin.orientation]
      const d = distToSegment(p, pin.at, [pin.at[0] - dx * pin.length, pin.at[1] - dy * pin.length])
      if (d < bestD) {
        bestD = d
        best = { kind: 'pin', index }
      }
    })
    draft.graphics.forEach((g, index) => {
      const d = graphicDistance(g, p)
      if (d < bestD) {
        bestD = d
        best = { kind: 'graphic', index }
      }
    })
    return best
  }

  const add = (g: Graphic) => {
    change({ ...draftRef.current, graphics: [...draftRef.current.graphics, g] })
    setPending([])
    pressed.current = null
  }

  /** Ends the line being drawn (repeated points from a double-click are dropped). */
  const finishLine = (points = pending) => {
    const clean = points.filter((p, i) => i === 0 || !same(p, points[i - 1]))
    if (tool === 'line' && clean.length >= 2) add({ kind: 'polyline', points: clean, fill: false })
    else setPending([])
  }

  const finishShape = (end: Point) => {
    const start = pending[0]
    if (!start || same(start, end)) return
    if (tool === 'rect') add({ kind: 'rect', start, end, fill: false })
    if (tool === 'circle') {
      const radius = Math.round(Math.hypot(end[0] - start[0], end[1] - start[1]))
      if (radius > 0) add({ kind: 'circle', center: start, radius, fill: false })
    }
  }

  const onDown = (e: React.PointerEvent) => {
    root.current?.focus()
    if (e.button === 1 || (e.button === 0 && space.current)) {
      pan.current = { client: [e.clientX, e.clientY], view }
      ;(e.target as Element).setPointerCapture?.(e.pointerId)
      return
    }
    if (e.button === 2) {
      if (tool === 'line')
        finishLine() // right click ends the line, as in schematic editors
      else setPending([])
      return
    }
    if (e.button !== 0) return
    const raw = toWorld(e)
    const p: Point = [snap(raw[0], FINE), snap(raw[1], FINE)]
    switch (tool) {
      case 'select': {
        const key = keyOf(hit(raw))
        ;(e.target as Element).setPointerCapture?.(e.pointerId)
        if (!key) {
          // Empty place: a band selects what it covers (Shift adds to the selection).
          if (!e.shiftKey) setSelection(new Set())
          setBand([raw, raw])
          return
        }
        let keys = selection
        if (e.shiftKey) {
          keys = new Set(selection)
          if (keys.has(key)) keys.delete(key)
          else keys.add(key)
        } else if (!selection.has(key)) keys = new Set([key]) // pressing a selected item drags them all
        setSelection(keys)
        if (keys.has(key)) drag.current = { from: p, moved: false, start: draftRef.current, keys }
        return
      }
      case 'line':
        setPending((pts) => [...pts, p])
        return
      case 'rect':
      case 'circle':
        // Two ways: click, click (second click ends it) or press, drag, release.
        if (pending.length === 1) finishShape(p)
        else {
          setPending([p])
          pressed.current = p
        }
        return
      case 'arc':
        if (pending.length === 2) add({ kind: 'arc', start: pending[0], mid: pending[1], end: p })
        else setPending((pts) => [...pts, p])
        return
      case 'text':
        void prompt({ title: 'Text', label: 'Text on the symbol' }).then((text) => {
          if (text?.trim()) add({ kind: 'text', at: p, text: text.trim(), size: 100 })
        })
        return
      case 'pin': {
        const at: Point = [snap(raw[0], G), snap(raw[1], G)]
        const d = draftRef.current
        const numbers = d.pins.map((x) => Number.parseInt(x.number, 10)).filter(Number.isFinite)
        const orientation: Orientation =
          Math.abs(at[0]) >= Math.abs(at[1]) ? (at[0] < 0 ? 'left' : 'right') : at[1] < 0 ? 'up' : 'down'
        // A block pin is a port: the next one without a pin yet.
        const port = block
          ? (block.ports.find((n) => !d.pins.some((x) => x.number === n)) ?? block.ports[0])
          : null
        const pin: Pin = {
          number: port ?? String(Math.max(0, ...numbers) + 1),
          name: port ?? '',
          at,
          length: 2 * G,
          orientation,
          type: 'passive',
        }
        change({ ...d, pins: [...d.pins, pin] })
        setSelected({ kind: 'pin', index: d.pins.length })
        return
      }
    }
  }

  const onMove = (e: React.PointerEvent) => {
    if (pan.current) {
      const el = svg.current?.getBoundingClientRect()
      const { client, view: v } = pan.current
      if (!el) return
      const k = Math.max(v.w / el.width, v.h / el.height) // world units per screen pixel ("meet")
      setView({ ...v, x: v.x - (e.clientX - client[0]) * k, y: v.y - (e.clientY - client[1]) * k })
      return
    }
    const raw = toWorld(e)
    const p: Point = [snap(raw[0], FINE), snap(raw[1], FINE)]
    setCursor(p)
    if (band) {
      setBand([band[0], raw])
      return
    }
    const d = drag.current
    if (!d) return
    // With a pin among them everything moves in pin steps, so pins stay on their grid.
    const step = [...d.keys].some((k) => k[0] === 'p') ? G : FINE
    const delta: Point = [snap(p[0] - d.from[0], step), snap(p[1] - d.from[1], step)]
    if (!delta[0] && !delta[1] && !d.moved) return
    d.moved = true
    setDraft(moveItems(d.start, d.keys, delta))
  }

  const onUp = (e: React.PointerEvent) => {
    if (pan.current) {
      pan.current = null
      return
    }
    if (band) {
      const found = itemsIn(draftRef.current, band)
      setSelection((current) => (e.shiftKey ? new Set([...current, ...found]) : found))
      setBand(null)
      return
    }
    const d = drag.current
    drag.current = null
    if (d?.moved) {
      history.current.past.push(d.start) // the whole drag is one undo step
      history.current.future = []
    }
    // Press-drag-release draws the rectangle / circle; a plain click waits for the second click.
    const start = pressed.current
    pressed.current = null
    if ((tool === 'rect' || tool === 'circle') && start) {
      const raw = toWorld(e)
      const end: Point = [snap(raw[0], FINE), snap(raw[1], FINE)]
      if (!same(start, end)) finishShape(end)
    }
  }

  const remove = () => {
    const keys = selection
    if (![...keys].some((k) => k[0] === 'g' || k[0] === 'p')) return // the texts stay (hide them instead)
    const d = draftRef.current
    change({
      ...d,
      graphics: d.graphics.filter((_g, i) => !keys.has(`g${i}`)),
      pins: d.pins.filter((_p, i) => !keys.has(`p${i}`)),
    })
    setSelection(new Set())
  }

  const selectAll = () => {
    const d = draftRef.current
    const keys = [...d.graphics.map((_g, i) => `g${i}`), ...d.pins.map((_p, i) => `p${i}`)]
    if (d.ref_at) keys.push('ref')
    if (d.value_at) keys.push('value')
    setSelection(new Set(keys))
  }

  const nudge = (dx: number, dy: number) => {
    if (!selection.size) return
    const step = [...selection].some((k) => k[0] === 'p') ? G : FINE
    change(moveItems(draftRef.current, selection, [dx * step, dy * step]))
  }

  const onKey = (e: KeyboardEvent) => {
    // Typing in a field, or a prompt on top: the keys are theirs.
    if ((e.target as HTMLElement | null)?.closest?.('input, select, textarea, [role="dialog"]')) return
    // The schematic's shortcuts (R rotate, W wire...) must not fire while drawing here.
    e.stopPropagation()
    const key = e.key.toLowerCase()
    if (e.key === ' ') {
      space.current = e.type === 'keydown'
      e.preventDefault()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'z') {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'y') {
      e.preventDefault()
      redo()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 'a') {
      e.preventDefault()
      setTool('select')
      selectAll()
      return
    }
    if ((e.ctrlKey || e.metaKey) && key === 's') {
      e.preventDefault()
      if (!problems.length) void save()
      return
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const arrows: Record<string, Point> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    if (arrows[e.key] && selection.size) {
      e.preventDefault()
      nudge(...arrows[e.key])
    } else if (e.key === 'Delete' || e.key === 'Backspace') remove()
    else if (e.key === 'Enter') finishLine()
    else if (e.key === 'Escape') {
      e.preventDefault()
      if (pending.length) setPending([])
      else if (tool !== 'select') setTool('select')
      else setSelected(null)
    } else if (key === 'f') setView(drawingBox(draftRef.current))
    else if (TOOL_KEYS[key]) setTool(TOOL_KEYS[key])
  }

  const onWheel = (e: React.WheelEvent) => {
    const p = toWorld(e)
    const f = e.deltaY > 0 ? 1.15 : 1 / 1.15
    setView((v) => ({ x: p[0] - (p[0] - v.x) * f, y: p[1] - (p[1] - v.y) * f, w: v.w * f, h: v.h * f }))
  }

  const problems = useMemo(() => {
    const out: string[] = []
    const numbers = draft.pins.map((p) => p.number)
    if (new Set(numbers).size !== numbers.length) out.push('pin numbers must be unique')
    if (block) {
      const missing = block.ports.filter((n) => !numbers.includes(n))
      if (missing.length) out.push(`ports without a pin: ${missing.join(', ')}`)
      const extra = numbers.filter((n) => !block.ports.includes(n))
      if (extra.length) out.push(`pins that are not ports: ${extra.join(', ')}`)
      return out
    }
    if (!draft.name.trim()) out.push('give the symbol a name')
    if (drawingOf) {
      if (!draft.graphics.length) out.push('draw something')
      return out // the pins and the simulation are those of the original
    }
    if (draft.spice) {
      const missing = draft.spice.nodes.filter((n) => n !== '=0' && !numbers.includes(n))
      if (missing.length) out.push(`SPICE pins not on the symbol: ${missing.join(', ')}`)
      if (draft.spice.element === 'X' && !draft.default_model)
        out.push('a subcircuit part needs a model name')
    }
    if (!draft.pins.length && !draft.graphics.length) out.push('draw something')
    return out
  }, [draft, block, drawingOf])

  const changed = initial !== null && JSON.stringify(initial) !== JSON.stringify(draft)

  // Keys reach the editor whenever its tab is shown (no need to click into it first); they are
  // taken before the schematic's shortcuts see them. Re-bound each render: the handler reads state.
  const keyHandler = useRef(onKey)
  keyHandler.current = onKey
  useEffect(() => {
    const visible = () => Boolean(root.current?.offsetParent)
    const down = (e: KeyboardEvent) => visible() && keyHandler.current(e)
    const up = (e: KeyboardEvent) => {
      if (e.key === ' ') space.current = false
    }
    window.addEventListener('keydown', down, true)
    window.addEventListener('keyup', up, true)
    return () => {
      window.removeEventListener('keydown', down, true)
      window.removeEventListener('keyup', up, true)
    }
  }, [])

  const closeEditor = async (force = false) => {
    if (changed && !force) {
      const answer = await choose({
        title: 'Close the symbol editor?',
        description: 'The drawing has changes that are not saved.',
        choices: [
          { label: 'Keep editing', value: 'stay', variant: 'outline' },
          { label: 'Close without saving', value: 'close', variant: 'destructive' },
        ],
      })
      if (answer !== 'close') return
    }
    closeSymbolEditor()
  }

  const saveBlock = async (symbol: SymbolDef | null) => {
    if (!block) return
    const ok = await useProject.getState().execute({
      type: 'set_sheet_symbol',
      sheet: block.sheet,
      symbol: symbol && { ...symbol, id: `sheet:${block.sheet}`, name: block.sheet, ref_prefix: 'X' },
    })
    if (!ok) return
    toast.success(
      symbol ? `Block symbol of “${block.sheet}” drawn` : `“${block.sheet}” uses the automatic box`,
    )
    closeSymbolEditor()
  }

  const saveDrawing = async (targetId: string) => {
    const name = draft.name.trim()
    const original = allSymbols.get(targetId)?.name ?? targetId
    if (where === 'project') return saveProjectDrawing(targetId, name, original)
    try {
      await apiPost('/api/library/looks', {
        library: library.trim(),
        target: targetId,
        name,
        graphics: draft.graphics,
        default: where === 'everywhere',
      })
      await reloadLibrary()
      toast.success(`Saved as another drawing of ${original}`, {
        description:
          where === 'everywhere'
            ? `New ${original} parts get it in every project; placed ones keep theirs.`
            : `Choose “${name}” in the part's Symbol list in the inspector.`,
      })
      closeSymbolEditor()
    } catch (e) {
      toast.error(`Cannot save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  /** The drawing for this project: its placed parts take it, new ones get it (one undo step). */
  const saveProjectDrawing = async (targetId: string, name: string, original: string) => {
    const { project, execute } = useProject.getState()
    if (!project) return
    const look = { name: `project:${name}`, label: name, standard: null, graphics: draft.graphics }
    const placed = project.sheets
      .filter((s) => !s.owner)
      .flatMap((s) =>
        s.instances.filter((i) => i.symbol === targetId).map((i) => ({ sheet: s.name, id: i.id })),
      )
    const ok = await execute({
      type: 'transaction',
      label: `draw ${original} as ${name}`,
      commands: [
        { type: 'set_project_look', symbol: targetId, name: look.name, look },
        { type: 'set_default_look', symbol: targetId, look: look.name },
        ...placed.map((p) => ({
          type: 'update_instance' as const,
          sheet: p.sheet,
          id: p.id,
          look: look.name,
        })),
      ],
    })
    if (!ok) return
    toast.success(`${original} drawn as “${name}” in this project`, {
      description: `${placed.length} placed part${placed.length === 1 ? '' : 's'} changed; new ones get it too. Undo goes back.`,
    })
    closeSymbolEditor()
  }

  const save = async () => {
    if (block) return saveBlock(draft)
    if (drawingOf) return saveDrawing(drawingOf)
    const name = draft.name.trim()
    const id = draft.id || `user:${library.trim()}/${name}`
    try {
      await apiPost('/api/library/symbols', { library: library.trim(), symbol: { ...draft, id, name } })
      await reloadLibrary()
      toast.success(`Saved ${name} in library “${library.trim()}”`)
      closeSymbolEditor()
    } catch (e) {
      toast.error(`Cannot save: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  if (!initial)
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
        <p>No symbol is open in the editor.</p>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => editSymbol(null)}>
            New symbol
          </Button>
          <Button variant="ghost" size="sm" onClick={() => closeSymbolEditor()}>
            Close
          </Button>
        </div>
      </div>
    )
  const grid: ReactNode[] = []
  // Wider than the view box: the canvas is rarely its exact shape ("meet" adds margins).
  const [gx0, gx1, gy0, gy1] = [view.x - view.w, view.x + 2 * view.w, view.y - view.h, view.y + 2 * view.h]
  for (let x = snap(gx0, G); x < gx1; x += G)
    grid.push(
      <line
        key={`x${x}`}
        x1={x}
        y1={gy0}
        x2={x}
        y2={gy1}
        className={x === 0 ? 'stroke-muted-foreground/50' : 'stroke-muted/60'}
      />,
    )
  for (let y = snap(gy0, G); y < gy1; y += G)
    grid.push(
      <line
        key={`y${y}`}
        x1={gx0}
        y1={y}
        x2={gx1}
        y2={y}
        className={y === 0 ? 'stroke-muted-foreground/50' : 'stroke-muted/60'}
      />,
    )
  const stroke = view.w / 500
  const isSel = (kind: 'graphic' | 'pin', index: number) =>
    selection.has(`${kind === 'graphic' ? 'g' : 'p'}${index}`)
  const preview: Graphic | null =
    tool === 'line' && pending.length
      ? { kind: 'polyline', points: [...pending, cursor], fill: false }
      : tool === 'rect' && pending.length === 1
        ? { kind: 'rect', start: pending[0], end: cursor, fill: false }
        : tool === 'circle' && pending.length === 1
          ? {
              kind: 'circle',
              center: pending[0],
              radius: Math.hypot(cursor[0] - pending[0][0], cursor[1] - pending[0][1]),
              fill: false,
            }
          : tool === 'arc' && pending.length === 2
            ? { kind: 'arc', start: pending[0], mid: pending[1], end: cursor }
            : tool === 'arc' && pending.length
              ? { kind: 'polyline', points: [...pending, cursor], fill: false }
              : null

  const drawGraphic = (g: Graphic, key: string, className?: string) => {
    switch (g.kind) {
      case 'polyline':
        return g.fill ? (
          <polygon key={key} points={g.points.map(pt).join(' ')} className={className} fill="currentColor" />
        ) : (
          <polyline key={key} points={g.points.map(pt).join(' ')} className={className} />
        )
      case 'rect':
        return (
          <rect
            key={key}
            className={className}
            x={Math.min(g.start[0], g.end[0])}
            y={Math.min(g.start[1], g.end[1])}
            width={Math.abs(g.end[0] - g.start[0])}
            height={Math.abs(g.end[1] - g.start[1])}
            fill={g.fill ? 'currentColor' : 'none'}
          />
        )
      case 'circle':
        return (
          <circle
            key={key}
            className={className}
            cx={g.center[0]}
            cy={g.center[1]}
            r={g.radius}
            fill={g.fill ? 'currentColor' : 'none'}
          />
        )
      case 'arc':
        return (
          <polyline
            key={key}
            className={className}
            points={arcPoints(g.start, g.mid, g.end).map(pt).join(' ')}
          />
        )
      case 'text':
        return (
          <text
            key={key}
            className={cn('fill-current', className)}
            x={g.at[0]}
            y={g.at[1]}
            fontSize={g.size}
            textAnchor="middle"
            dominantBaseline="central"
            stroke="none"
          >
            {g.text}
          </text>
        )
    }
  }

  const tools: [Tool, ReactNode, string, string][] = [
    ['select', <MousePointer2 key="s" />, 'Select / move', 'S'],
    ['line', <PenLine key="l" />, 'Line', 'L'],
    ['rect', <Square key="r" />, 'Rectangle', 'R'],
    ['circle', <Circle key="c" />, 'Circle', 'C'],
    ['arc', <Spline key="a" />, 'Arc (3 points)', 'A'],
    ['text', <Type key="t" />, 'Text', 'T'],
    ['pin', <Minus key="p" />, 'Pin', 'P'],
  ]
  const sel = selected
  const selGraphic = sel?.kind === 'graphic' ? draft.graphics[sel.index] : null
  const setPin = (index: number, pin: Partial<Pin>) =>
    setDraft((d) => ({ ...d, pins: d.pins.map((p, i) => (i === index ? { ...p, ...pin } : p)) }))

  return (
    // The editor takes its own keyboard shortcuts (focusable application area).
    <div
      ref={root}
      tabIndex={-1}
      role="application"
      aria-label="Symbol editor"
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <h2 className="font-medium">
          {block ? `Block symbol – ${block.sheet}` : `Symbol – ${draft.name || 'new symbol'}`}
          {changed && <span className="text-muted-foreground"> ●</span>}
        </h2>
        <p className="hidden truncate text-xs text-muted-foreground lg:block">
          {block
            ? 'How the sheet looks as a block. Every port needs a pin; wires on placed blocks follow their pins.'
            : 'Draw it, put pins on the grid, say how it is simulated. Saved into a library of yours.'}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Undo (Ctrl+Z)"
            aria-label="Undo"
            onClick={undo}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Redo (Ctrl+Y)"
            aria-label="Redo"
            onClick={redo}
          >
            <Redo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Full screen on / off"
            aria-label="Full screen"
            onClick={() => window.dispatchEvent(new CustomEvent('bpt:maximize-panel', { detail: PANEL }))}
          >
            <Expand />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            title="Fit the drawing (F)"
            aria-label="Fit"
            onClick={() => setView(drawingBox(draftRef.current))}
          >
            <Maximize />
          </Button>
          {block?.drawn && (
            <Button variant="outline" size="sm" onClick={() => void saveBlock(null)}>
              Use automatic box
            </Button>
          )}
          <Button variant="outline" size="sm" onClick={() => void closeEditor()}>
            Close
          </Button>
          <Button
            size="sm"
            disabled={problems.length > 0 || (!block && !library.trim())}
            title={problems.length ? problems.join('; ') : 'Ctrl+S'}
            onClick={() => void save()}
          >
            {block ? 'Use for the block' : drawingOf ? 'Save drawing' : 'Save to library'}
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-[3rem_1fr_22rem]">
        <div
          className="flex flex-col items-center gap-1 border-r py-2"
          role="toolbar"
          aria-label="Drawing tools"
        >
          {tools.map(([id, icon, title, key]) => (
            <Button
              key={id}
              variant={tool === id ? 'default' : 'ghost'}
              size="icon"
              className="size-9"
              title={`${title} (${key})`}
              aria-label={title}
              aria-pressed={tool === id}
              onClick={() => setTool(id)}
            >
              {icon}
            </Button>
          ))}
          <Button
            variant="ghost"
            size="icon"
            className="mt-2 size-9"
            title="Quick box: a rectangle with named pins"
            aria-label="Quick box"
            onClick={() =>
              void prompt({
                title: 'Quick box',
                label: 'Pin names, in order (first half left, rest right)',
                placeholder: 'IN+, IN-, V+, V-, OUT',
                initial: block?.ports.join(', '),
              }).then((text) => {
                const names = (text ?? '').split(/[,\s]+/).filter(Boolean)
                if (names.length) {
                  const next = { ...draftRef.current, ...quickBox(names) }
                  change(next)
                  setView(drawingBox(next))
                }
              })
            }
          >
            <Zap />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-9"
            title="Delete the selected item (Delete)"
            aria-label="Delete item"
            disabled={!sel || sel.kind === 'ref' || sel.kind === 'value'}
            onClick={remove}
          >
            <Trash2 />
          </Button>
        </div>
        <div className="relative min-h-0 overflow-hidden bg-background">
          <svg
            ref={svg}
            role="application"
            aria-label="Symbol canvas"
            className={cn(
              'size-full touch-none select-none text-foreground',
              tool === 'select' ? 'cursor-default' : 'cursor-crosshair',
            )}
            viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
            preserveAspectRatio="xMidYMid meet"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onDoubleClick={() => finishLine()}
            onContextMenu={(e) => e.preventDefault()}
            onWheel={onWheel}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <g strokeWidth={stroke / 2}>{grid}</g>
            {draft.graphics.map((g, i) =>
              drawGraphic(g, `g${i}`, isSel('graphic', i) ? 'text-amber-400' : undefined),
            )}
            {draft.pins.map((pin, i) => {
              const [dx, dy] = DIRS[pin.orientation]
              const end: Point = [pin.at[0] - dx * pin.length, pin.at[1] - dy * pin.length]
              return (
                <g
                  // biome-ignore lint/suspicious/noArrayIndexKey: pins have no id; numbers may repeat while edited
                  key={`p${pin.number}-${i}`}
                  className={isSel('pin', i) ? 'text-amber-400' : 'text-sky-500'}
                >
                  <line x1={pin.at[0]} y1={pin.at[1]} x2={end[0]} y2={end[1]} />
                  <circle cx={pin.at[0]} cy={pin.at[1]} r={22} />
                  <text
                    x={pin.at[0] + (dx ? -dx * 60 : 50)}
                    y={pin.at[1] + (dy ? -dy * 60 : -40)}
                    fontSize={70}
                    stroke="none"
                    className="fill-current"
                    textAnchor="middle"
                  >
                    {pin.number}
                  </text>
                </g>
              )
            })}
            {preview && drawGraphic(preview, 'preview', 'text-primary')}
            {pending.map((p) => (
              <circle key={pt(p)} cx={p[0]} cy={p[1]} r={20} className="text-primary" fill="currentColor" />
            ))}
            {draft.ref_at && (
              <text
                x={draft.ref_at[0]}
                y={draft.ref_at[1]}
                fontSize={90}
                stroke="none"
                className={cn(
                  'fill-current',
                  selection.has('ref') ? 'text-amber-400' : 'text-muted-foreground',
                )}
                dominantBaseline="central"
              >
                {draft.ref_prefix}1
              </text>
            )}
            {draft.value_at && (
              <text
                x={draft.value_at[0]}
                y={draft.value_at[1]}
                fontSize={90}
                stroke="none"
                className={cn(
                  'fill-current',
                  selection.has('value') ? 'text-amber-400' : 'text-muted-foreground',
                )}
                dominantBaseline="central"
              >
                value
              </text>
            )}
            {/* Handles: texts can be grabbed here and dragged (drawn in select mode). */}
            {tool === 'select' &&
              [
                ...(draft.ref_at ? [['ref', draft.ref_at] as const] : []),
                ...(draft.value_at ? [['value', draft.value_at] as const] : []),
                ...draft.graphics.flatMap((g, i) => (g.kind === 'text' ? [[`g${i}`, g.at] as const] : [])),
              ].map(([key, at]) => (
                <rect
                  key={`h-${key}`}
                  data-testid={`handle-${key}`}
                  x={at[0] - view.w / 160}
                  y={at[1] - view.w / 160}
                  width={view.w / 80}
                  height={view.w / 80}
                  strokeWidth={stroke * 0.8}
                  className={selection.has(key) ? 'text-amber-400' : 'text-sky-500'}
                  fill={selection.has(key) ? 'currentColor' : 'none'}
                />
              ))}
            {band && (
              <rect
                x={Math.min(band[0][0], band[1][0])}
                y={Math.min(band[0][1], band[1][1])}
                width={Math.abs(band[1][0] - band[0][0])}
                height={Math.abs(band[1][1] - band[0][1])}
                strokeDasharray={`${stroke * 4} ${stroke * 3}`}
                className="text-primary"
                fill="currentColor"
                fillOpacity={0.08}
              />
            )}
            <circle cx={cursor[0]} cy={cursor[1]} r={12} className="text-muted-foreground" />
          </svg>
          <p className="pointer-events-none absolute top-2 left-3 rounded bg-background/80 px-2 py-0.5 text-xs">
            {STEPS[tool](pending.length)}
          </p>
          <p className="pointer-events-none absolute bottom-1 left-3 font-mono text-[11px] text-muted-foreground">
            {(cursor[0] / 100).toFixed(2)}, {(cursor[1] / 100).toFixed(2)} mm · wheel zooms · middle button or
            Space+drag pans · F fits · Ctrl+Z undoes
          </p>
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-auto border-l p-3 text-sm">
          {block ? (
            <TextFields draft={draft} setDraft={setDraft} />
          ) : (
            <>
              <Fields draft={draft} setDraft={setDraft} library={library} setLibrary={setLibrary} />
              <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                <span className="text-muted-foreground">Save as</span>
                <select
                  aria-label="Save as"
                  className="h-8 w-full min-w-0 rounded-md border bg-background px-2"
                  value={drawingOf}
                  title="Another drawing keeps the original's pins and simulation; parts choose it in the inspector"
                  onChange={(e) => setDrawingOf(e.target.value)}
                >
                  <option value="">a new symbol</option>
                  {samePins
                    .sort((a, b) => {
                      const basedOn = target.kind === 'library' ? target.basedOn : undefined
                      return Number(b.id === basedOn) - Number(a.id === basedOn)
                    })
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        another drawing of {s.name}
                      </option>
                    ))}
                </select>
              </div>
              {drawingOf && (
                <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
                  <span className="text-muted-foreground">For</span>
                  <select
                    aria-label="Drawing for"
                    className="h-8 w-full min-w-0 rounded-md border bg-background px-2"
                    value={where}
                    onChange={(e) => setWhere(e.target.value as typeof where)}
                  >
                    <option value="project">this project (its parts change)</option>
                    <option value="everywhere">my new parts in every project</option>
                    <option value="offered">a choice in the inspector only</option>
                  </select>
                </div>
              )}
              {!drawingOf && samePins.length > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  Same pins as {samePins.map((s) => s.name).join(', ')}: it can also be saved as another
                  drawing of {samePins.length === 1 ? 'it' : 'one of them'}, chosen per part in the inspector.
                </p>
              )}
              {draft.id && <VersionFields draft={draft} setDraft={setDraft} />}
            </>
          )}
          {selGraphic && (
            <section className="flex flex-col gap-1 rounded-md border p-2">
              <p className="text-xs font-medium text-muted-foreground uppercase">
                Selected {selGraphic.kind}
              </p>
              {'fill' in selGraphic && (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={selGraphic.fill}
                    onChange={(e) =>
                      sel?.kind === 'graphic' &&
                      change({
                        ...draftRef.current,
                        graphics: draftRef.current.graphics.map((g, i) =>
                          i === sel.index && 'fill' in g ? { ...g, fill: e.target.checked } : g,
                        ),
                      })
                    }
                  />
                  Filled
                </label>
              )}
              {selGraphic.kind === 'text' && (
                <Input
                  aria-label="Text"
                  className="h-8"
                  value={selGraphic.text}
                  onChange={(e) =>
                    sel?.kind === 'graphic' &&
                    setDraft((d) => ({
                      ...d,
                      graphics: d.graphics.map((g, i) =>
                        i === sel.index && g.kind === 'text' ? { ...g, text: e.target.value } : g,
                      ),
                    }))
                  }
                />
              )}
            </section>
          )}
          <section className="flex flex-col gap-1">
            <p className="text-xs font-medium text-muted-foreground uppercase">Pins ({draft.pins.length})</p>
            {draft.pins.map((pin, i) => (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: pins have no id; numbers may repeat while edited
                key={`${i}-${pin.number}`}
                className={cn(
                  'grid grid-cols-[3rem_1fr_5.5rem_4.5rem] gap-1',
                  isSel('pin', i) && 'rounded bg-accent',
                )}
              >
                {block ? (
                  <select
                    aria-label={`Pin ${i + 1} port`}
                    className="h-7 rounded border bg-background font-mono text-xs"
                    value={pin.number}
                    onChange={(e) => setPin(i, { number: e.target.value, name: e.target.value })}
                    onFocus={() => setSelected({ kind: 'pin', index: i })}
                  >
                    {[...new Set([...block.ports, pin.number])].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                ) : (
                  <Input
                    aria-label={`Pin ${i + 1} number`}
                    className="h-7 px-1 font-mono text-xs"
                    value={pin.number}
                    onChange={(e) => setPin(i, { number: e.target.value.trim() })}
                    onFocus={() => setSelected({ kind: 'pin', index: i })}
                  />
                )}
                <Input
                  aria-label={`Pin ${i + 1} name`}
                  className="h-7 px-1 text-xs"
                  value={pin.name}
                  placeholder="name"
                  onChange={(e) => setPin(i, { name: e.target.value })}
                  onFocus={() => setSelected({ kind: 'pin', index: i })}
                />
                <select
                  aria-label={`Pin ${i + 1} type`}
                  className="h-7 rounded border bg-background text-xs"
                  value={pin.type}
                  onChange={(e) => setPin(i, { type: e.target.value })}
                >
                  {PIN_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace('_', ' ')}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={`Pin ${i + 1} direction`}
                  className="h-7 rounded border bg-background text-xs"
                  value={pin.orientation}
                  onChange={(e) => setPin(i, { orientation: e.target.value as Orientation })}
                >
                  {(['left', 'right', 'up', 'down'] as const).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {!draft.pins.length && (
              <p className="text-xs text-muted-foreground">Use the pin tool (P), or Quick box (⚡).</p>
            )}
          </section>
          {!block && !drawingOf && <SpiceFields draft={draft} setDraft={setDraft} />}
          {problems.length > 0 && (
            <ul className="text-xs text-destructive">
              {problems.map((p) => (
                <li key={p}>• {p}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}

function Fields({
  draft,
  setDraft,
  library,
  setLibrary,
}: {
  draft: SymbolDef
  setDraft: React.Dispatch<React.SetStateAction<SymbolDef>>
  library: string
  setLibrary: (v: string) => void
}) {
  const row = (label: string, input: ReactNode) => (
    <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
      <span className="text-muted-foreground">{label}</span>
      {input}
    </div>
  )
  return (
    <section className="flex flex-col gap-1">
      {row(
        'Name',
        <Input
          aria-label="Symbol name"
          className="h-8"
          value={draft.name}
          disabled={Boolean(draft.id)}
          title={draft.id ? 'Saved symbols keep their name (save a copy to rename)' : ''}
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
        />,
      )}
      {row(
        'Library',
        <Input
          aria-label="Library"
          className="h-8"
          value={library}
          disabled={Boolean(draft.id)}
          onChange={(e) => setLibrary(e.target.value)}
        />,
      )}
      {row(
        'Reference',
        <Input
          aria-label="Reference prefix"
          className="h-8 font-mono"
          value={draft.ref_prefix}
          onChange={(e) => setDraft((d) => ({ ...d, ref_prefix: e.target.value.trim() }))}
        />,
      )}
      {row(
        'Description',
        <Input
          aria-label="Description"
          className="h-8"
          value={draft.description}
          onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
        />,
      )}
      <TextFields draft={draft} setDraft={setDraft} />
    </section>
  )
}

interface Usage {
  project: string
  path: string | null
  parts: number
  version: number
}

/** Editing a saved symbol: what changed (shown to projects using it) and where it is used. */
function VersionFields({
  draft,
  setDraft,
}: {
  draft: SymbolDef
  setDraft: React.Dispatch<React.SetStateAction<SymbolDef>>
}) {
  const [usage, setUsage] = useState<Usage[] | null>(null)
  useEffect(() => {
    apiGet<Usage[]>(`/api/library/symbols/usage?id=${encodeURIComponent(draft.id)}`)
      .then(setUsage)
      .catch(() => setUsage(null))
  }, [draft.id])
  return (
    <section className="flex flex-col gap-1">
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Changes</span>
        <Input
          aria-label="What changed"
          className="h-8"
          value={draft.changes ?? ''}
          placeholder={`what changes in v${(draft.version ?? 1) + 1}`}
          onChange={(e) => setDraft((d) => ({ ...d, changes: e.target.value }))}
        />
      </div>
      <p className="text-[11px] text-muted-foreground">
        v{draft.version ?? 1}
        {draft.updated ? ` of ${draft.updated}` : ''} ·{' '}
        {usage === null
          ? 'usage unknown'
          : usage.length
            ? `used in ${usage.map((u) => `${u.project} (${u.parts}, v${u.version})`).join(', ')}`
            : 'not used in open or recent projects'}
        . Projects keep their copy until they update it.
      </p>
    </section>
  )
}

/** Whether the reference and value texts are shown (they are dragged on the canvas). */
function TextFields({
  draft,
  setDraft,
}: {
  draft: SymbolDef
  setDraft: React.Dispatch<React.SetStateAction<SymbolDef>>
}) {
  return (
    <section className="flex flex-col gap-1">
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Texts</span>
        <div className="flex gap-3 text-xs">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={draft.ref_at !== null}
              onChange={(e) => setDraft((d) => ({ ...d, ref_at: e.target.checked ? [254, -254] : null }))}
            />
            reference
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={draft.value_at !== null}
              onChange={(e) => setDraft((d) => ({ ...d, value_at: e.target.checked ? [254, 254] : null }))}
            />
            value
          </label>
          <span className="text-muted-foreground">(drag them on the canvas)</span>
        </div>
      </div>
    </section>
  )
}

function SpiceFields({
  draft,
  setDraft,
}: {
  draft: SymbolDef
  setDraft: React.Dispatch<React.SetStateAction<SymbolDef>>
}) {
  const element = draft.spice?.element ?? ''
  const nodes = draft.spice?.nodes ?? []
  const setElement = (value: string) =>
    setDraft((d) => ({
      ...d,
      spice: value
        ? { element: value, nodes: d.spice?.nodes.length ? d.spice.nodes : d.pins.map((p) => p.number) }
        : null,
      value_param: ['R', 'C', 'L'].includes(value) ? value : null,
      default_params: ['R', 'C', 'L'].includes(value)
        ? { [value]: { R: '1k', C: '100n', L: '1m' }[value] ?? '' }
        : d.default_params,
    }))
  return (
    <section className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground uppercase">Simulation</p>
      <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
        <span className="text-muted-foreground">Element</span>
        <select
          aria-label="SPICE element"
          className="h-8 w-full min-w-0 rounded-md border bg-background px-2"
          value={element}
          onChange={(e) => setElement(e.target.value)}
        >
          {ELEMENTS.map((e) => (
            <option key={e} value={e}>
              {e ? `${e} – ${ELEMENT_HELP[e]}` : ELEMENT_HELP['']}
            </option>
          ))}
        </select>
      </div>
      {draft.spice && (
        <>
          <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-muted-foreground">Pin order</span>
            <Input
              aria-label="SPICE pin order"
              className="h-8 font-mono"
              value={nodes.join(' ')}
              title="Symbol pin numbers in SPICE order; =0 ties a node to ground"
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  spice: d.spice && { ...d.spice, nodes: e.target.value.split(/\s+/).filter(Boolean) },
                }))
              }
            />
          </div>
          <div className="grid grid-cols-[5.5rem_1fr] items-center gap-2">
            <span className="text-muted-foreground">Model</span>
            <Input
              aria-label="Default model"
              className="h-8 font-mono"
              value={draft.default_model ?? ''}
              placeholder={['D', 'Q', 'M', 'J', 'S', 'X'].includes(element) ? 'model name' : 'none'}
              onChange={(e) => setDraft((d) => ({ ...d, default_model: e.target.value.trim() || null }))}
            />
          </div>
          <p className="text-[11px] text-muted-foreground">{ELEMENT_HELP[element]}</p>
        </>
      )}
    </section>
  )
}
