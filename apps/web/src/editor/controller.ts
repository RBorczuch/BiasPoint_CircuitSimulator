/**
 * Schematic interaction: pointer, wheel and editor actions. Reads and writes the project /
 * editor stores; every document change goes through backend commands (undoable).
 */

import { toast } from 'sonner'
import type {
  Command,
  Directive,
  Instance,
  Junction,
  Label,
  Point,
  Rotation,
  Sheet,
  TextField,
  TextPlace,
  Wire,
} from '@/api/types'
import { openComponentWizard } from '@/components/ComponentWizard'
import { registerActions } from '@/keymap/keymap'
import { newId } from '@/lib/ids'
import { toRealPart } from '@/lib/realParts'
import { createBlock, viewSteps } from '@/lib/sheets'
import { pickSymbol, prompt } from '@/store/dialogs'
import { useEditor, type View, type WirePart } from '@/store/editor'
import { currentSheet, useProject } from '@/store/project'
import { useRecentSymbols } from '@/store/recent'
import { useSettings } from '@/store/settings'
import { useSimulation } from '@/store/simulation'
import { type AlignMode, alignCommands } from './align'
import {
  GRID,
  isConnectionPoint,
  labelPoint,
  pinPositions,
  placeOf,
  route,
  samePoint,
  sheetBounds,
  simplify,
  snapPoint,
  textBox,
  textSpot,
  valueText,
  type WireMode,
  wireCrossings,
} from './geometry'
import type { HitIndex } from './hittest'

const TEXT_CHAR = 110 * 0.62 // width of a character of a part's text (world units)

import {
  editWire,
  mirroredRotation,
  moveCommands,
  previewSheet,
  transformCommands,
  wirePartAt,
} from './preview'

const DRAG_THRESHOLD_PX = 4
const PICK_TOLERANCE_PX = 6
const MIN_SCALE = 0.01
const MAX_SCALE = 3

interface Clipboard {
  origin: Point
  instances: Instance[]
  wires: Wire[]
  labels: Label[]
  junctions: Junction[]
  directives: Directive[]
}

const project = () => useProject.getState()
const editor = () => useEditor.getState()
const rotate = (r: Rotation, by: number) => ((((r + by) % 360) + 360) % 360) as Rotation

/** The controller of the mounted schematic view (menus and panels call into it). */
export let activeEditor: EditorController | null = null

const ALIGN_LABELS: Record<AlignMode, string> = {
  left: 'align left',
  right: 'align right',
  top: 'align top',
  bottom: 'align bottom',
  centerX: 'align centres',
  centerY: 'align centres',
  distributeX: 'distribute horizontally',
  distributeY: 'distribute vertically',
}

const TOOLBAR_PX = 64 // floating tool bar at the right edge of the canvas

export class EditorController {
  private canvas: HTMLElement
  private index: HitIndex
  private pointerStart: { screen: Point; world: Point; button: number } | null = null
  private panning: { screen: Point; view: View; button: number; client: Point } | null = null
  private dragging = false
  private altPreview = false
  private pendingWireEdit: { wireId: string; part: WirePart } | null = null
  // A selected part's reference or value under the pointer: dragging moves the text alone.
  private pendingText: { id: string; field: TextField; place: TextPlace; from: Point } | null = null
  private spaceDown = false
  private clipboard: Clipboard | null = null
  private cleanups: (() => void)[] = []

  constructor(canvas: HTMLElement, index: HitIndex) {
    this.canvas = canvas
    this.index = index
    const on = <K extends keyof HTMLElementEventMap>(
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
      opts?: AddEventListenerOptions,
    ) => {
      canvas.addEventListener(type, fn as EventListener, opts)
      this.cleanups.push(() => canvas.removeEventListener(type, fn as EventListener))
    }
    on('pointerdown', (e) => this.onPointerDown(e))
    on('pointermove', (e) => this.onPointerMove(e))
    on('pointerup', (e) => this.onPointerUp(e))
    on('dblclick', () => this.onDoubleClick())
    // The cross must appear where the pointer is, not where it left the canvas.
    on('pointerenter', (e) => {
      editor().setCursor(snapPoint(this.toWorld(this.screenPoint(e))))
      editor().setPointerInside(true)
    })
    on('pointerleave', () => {
      editor().setPointerInside(false)
      editor().setHover(null)
    })
    on('wheel', (e) => this.onWheel(e), { passive: false })
    on('contextmenu', (e) => e.preventDefault())
    const keys = (e: KeyboardEvent) => {
      if (e.key === ' ') this.spaceDown = e.type === 'keydown'
    }
    // Switching windows (Alt+Tab) gives no pointerleave: hide the cross until the pointer is back.
    const blur = () => editor().setPointerInside(false)
    window.addEventListener('keydown', keys)
    window.addEventListener('keyup', keys)
    window.addEventListener('blur', blur)
    this.cleanups.push(() => {
      window.removeEventListener('keydown', keys)
      window.removeEventListener('keyup', keys)
      window.removeEventListener('blur', blur)
    })
    // Only while the schematic is on screen: behind a full-window tab (symbol editor, component
    // maker) Delete or R must not change parts nobody sees.
    const visible = () => this.canvas.getClientRects().length > 0
    const guarded = Object.fromEntries(
      Object.entries(this.actions()).map(([id, run]) => [
        id,
        (event?: KeyboardEvent) => {
          const go = () => (run as (e?: KeyboardEvent) => unknown)(event)
          if (visible()) return go()
          // From a menu or the palette (no key event): show the schematic, then do it.
          if (!event) {
            window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'schematic' }))
            setTimeout(go, 150)
          }
        },
      ]),
    )
    this.cleanups.push(registerActions(guarded))
    activeEditor = this
  }

  dispose(): void {
    for (const cleanup of this.cleanups) cleanup()
    if (activeEditor === this) activeEditor = null
  }

  // -- coordinates ------------------------------------------------------------------------

  private screenPoint(e: MouseEvent): Point {
    const rect = this.canvas.getBoundingClientRect()
    return [e.clientX - rect.left, e.clientY - rect.top]
  }

  private toWorld([sx, sy]: Point): Point {
    const { scale, x, y } = editor().view
    return [(sx - x) / scale, (sy - y) / scale]
  }

  private tolerance(): number {
    return PICK_TOLERANCE_PX / editor().view.scale
  }

  private sheet(): Sheet | null {
    return currentSheet(project())
  }

  private get sheetName(): string {
    return project().sheetName
  }

  // -- pointer ------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    // The canvas does not take focus: leave a text field (library search, inspector) so that
    // shortcuts such as Ctrl+Z, R or Delete reach the schematic after a click on it.
    const active = document.activeElement
    if (active instanceof HTMLElement && active.closest('input, textarea, select, [contenteditable="true"]'))
      active.blur()
    this.canvas.setPointerCapture(e.pointerId)
    const screen = this.screenPoint(e)
    const world = this.toWorld(screen)
    editor().setContextMenu(null)
    if (e.button === 1 || e.button === 2 || (e.button === 0 && this.spaceDown)) {
      // Right button: a click opens the context menu, a drag pans (Altium style).
      this.panning = { screen, view: editor().view, button: e.button, client: [e.clientX, e.clientY] }
      return
    }
    if (e.button !== 0) return
    this.pointerStart = { screen, world, button: e.button }
    this.dragging = false
    const tool = editor().tool
    const cursor = snapPoint(world)

    const move = editor().move
    if (move?.fromKeyboard) {
      void this.commitMove()
      return
    }
    switch (tool.kind) {
      case 'wire':
        this.addWirePoint(cursor)
        return
      case 'place':
        void this.placeSymbol(cursor)
        return
      case 'label':
        void this.placeLabel(cursor)
        return
      case 'junction':
        void this.addJunctionAt(labelPoint(cursor, this.sheet()?.wires ?? [], editor().view.scale))
        return
      case 'directive':
        void this.placeDirective(cursor)
        return
      case 'probe':
        this.probe(world, e.shiftKey, e.altKey)
        return
      case 'highlight':
        this.highlightAt(world)
        return
      case 'select': {
        const additive = e.shiftKey || e.ctrlKey || e.metaKey
        // Clicking the free end of a pin starts a wire there (KiCad).
        const pinEnd = !additive ? this.freePinAt(world) : null
        if (pinEnd) {
          editor().clearSelection()
          editor().setTool({ kind: 'wire', points: [pinEnd], horizontalFirst: true })
          return
        }
        const text = additive ? null : this.selectedTextAt(world)
        if (text) {
          this.pendingText = { ...text, from: world }
          return
        }
        const hit = this.index.at(world, this.tolerance())
        const selection = editor().selection
        if (
          hit?.kind === 'wires' &&
          hit.points &&
          !additive &&
          (selection.size <= 1 || !selection.has(hit.id))
        ) {
          // A single wire: dragging reshapes it (segment or end) instead of moving it.
          editor().select([hit.id])
          this.pendingWireEdit = {
            wireId: hit.id,
            part: wirePartAt(hit.points, world, this.tolerance() * 1.5),
          }
          return
        }
        if (hit) {
          if (additive) editor().select([hit.id], 'toggle')
          else if (!editor().selection.has(hit.id)) editor().select([hit.id])
        } else if (!additive) {
          editor().clearSelection()
        }
        if (!hit) editor().setBoxSelect({ from: world, to: world })
      }
    }
  }

  private onPointerMove(e: PointerEvent): void {
    const screen = this.screenPoint(e)
    const world = this.toWorld(screen)
    const cursor = snapPoint(world)
    if (this.panning) {
      const { view, screen: start } = this.panning
      editor().setView({ ...view, x: view.x + screen[0] - start[0], y: view.y + screen[1] - start[1] })
      return
    }
    if (!samePoint(cursor, editor().cursor)) editor().setCursor(cursor)
    if (!editor().pointerInside) editor().setPointerInside(true)
    const hovering = ['select', 'probe', 'highlight'].includes(editor().tool.kind)
    if (e.buttons === 0 && hovering && !editor().move) {
      const hit = this.index.at(world, this.tolerance())
      editor().setHover(hit?.id ?? null)
      // Alt + hover previews the net under the pointer.
      if (e.altKey && editor().tool.kind === 'select') {
        const nets = useSimulation.getState().nets
        const net = hit && nets ? (nets.wires[hit.id] ?? nets.labels[hit.id]) : undefined
        this.altPreview = true
        editor().setHighlightNet(net ?? null)
      } else if (this.altPreview) {
        this.altPreview = false
        editor().setHighlightNet(null)
      }
    }

    const move = editor().move
    if (move?.fromKeyboard) {
      editor().setMove({ ...move, delta: [cursor[0] - move.anchor[0], cursor[1] - move.anchor[1]] })
      return
    }
    const start = this.pointerStart
    if (!start) return
    const box = editor().boxSelect
    if (box) {
      editor().setBoxSelect({ from: box.from, to: world })
      return
    }
    const travelled = Math.hypot(screen[0] - start.screen[0], screen[1] - start.screen[1])
    if (this.pendingText) {
      if (this.dragging || travelled > DRAG_THRESHOLD_PX) {
        this.dragging = true
        const { id, field, place, from } = this.pendingText
        const step = GRID / 4 // texts sit finer than parts, still on a grid
        const snap = (v: number) => Math.round(Math.round(v / step) * step) // whole units, as stored
        editor().setTextDrag({
          id,
          field,
          place: {
            at: [snap(place.at[0] + world[0] - from[0]), snap(place.at[1] + world[1] - from[1])],
            rot: place.rot,
          },
        })
      }
      return
    }
    if (this.pendingWireEdit) {
      if (this.dragging || travelled > DRAG_THRESHOLD_PX) {
        this.dragging = true
        const from = snapPoint(start.world)
        editor().setWireEdit({ ...this.pendingWireEdit, delta: [cursor[0] - from[0], cursor[1] - from[1]] })
      }
      return
    }
    if (
      editor().tool.kind === 'select' &&
      editor().selection.size > 0 &&
      (this.dragging || travelled > DRAG_THRESHOLD_PX)
    ) {
      this.dragging = true
      const from = snapPoint(start.world)
      editor().setMove({
        delta: [cursor[0] - from[0], cursor[1] - from[1]],
        stretchWires: !e.altKey, // wires follow the part (beginners expect it); Alt+drag detaches
        fromKeyboard: false,
        anchor: from,
      })
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.canvas.releasePointerCapture(e.pointerId)
    if (this.panning) {
      const { button, screen: start, client } = this.panning
      this.panning = null
      const screen = this.screenPoint(e)
      if (button === 2 && Math.hypot(screen[0] - start[0], screen[1] - start[1]) < DRAG_THRESHOLD_PX) {
        this.openContextMenu(screen, client)
      }
      return
    }
    const box = editor().boxSelect
    if (box) {
      editor().setBoxSelect(null)
      const [x0, y0] = box.from
      const [x1, y1] = box.to
      const crossing = x1 < x0 // right-to-left: everything the box touches (KiCad / AutoCAD)
      const ids = this.index.inside(
        {
          minX: Math.min(x0, x1),
          minY: Math.min(y0, y1),
          maxX: Math.max(x0, x1),
          maxY: Math.max(y0, y1),
        },
        crossing,
      )
      if (ids.length) editor().select(ids, e.shiftKey || e.ctrlKey ? 'add' : 'replace')
    }
    if (this.pendingText) {
      const drag = editor().textDrag
      this.pendingText = null
      editor().setTextDrag(null)
      if (drag) void this.setTextPlace(drag.id, drag.field, drag.place)
    } else if (this.pendingWireEdit) {
      if (this.dragging) void this.commitWireEdit()
      this.pendingWireEdit = null
    } else if (this.dragging) {
      void this.commitMove()
    }
    this.pointerStart = null
    this.dragging = false
  }

  private onDoubleClick(): void {
    const tool = editor().tool
    if (tool.kind === 'wire') {
      void this.finishWire()
      return
    }
    if (tool.kind === 'select' && editor().selection.size === 1) {
      // A block of a hierarchical sheet: double-click goes inside (like KiCad).
      if (this.enterBlock()) return
      window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'properties' }))
      window.dispatchEvent(new CustomEvent('bpt:edit-properties'))
    }
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault()
    if (e.shiftKey) {
      const view = editor().view
      editor().setView({ ...view, x: view.x - e.deltaY })
      return
    }
    this.zoomAt(this.screenPoint(e), Math.exp(-e.deltaY * 0.0015))
  }

  zoomAt([sx, sy]: Point, factor: number): void {
    const view = editor().view
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor))
    const k = scale / view.scale
    editor().setView({ scale, x: sx - (sx - view.x) * k, y: sy - (sy - view.y) * k })
  }

  /** Align or distribute the selected parts; wires follow, one undo step. */
  private async align(mode: AlignMode): Promise<void> {
    const sheet = this.sheet()
    if (!sheet) return
    const commands = alignCommands(this.sheetName, sheet, project().symbols, editor().selection, mode)
    if (!commands.length) {
      const few = mode.startsWith('distribute') ? 'three' : 'two'
      toast.info(
        `Select at least ${few} parts to ${mode.startsWith('distribute') ? 'distribute' : 'align'} them`,
      )
      return
    }
    await project().execute({ type: 'transaction', label: ALIGN_LABELS[mode], commands })
  }

  /** Bring objects into the middle of the view (zooming in only if they would be tiny). */
  centerOn(ids: Set<string>): void {
    const sheet = this.sheet()
    const box = sheet && sheetBounds(sheet, project().symbols, { ids })
    if (!box) return
    const rect = this.canvas.getBoundingClientRect()
    const scale = Math.max(editor().view.scale, 0.08)
    editor().setView({
      scale,
      x: rect.width / 2 - ((box.minX + box.maxX) / 2) * scale,
      y: rect.height / 2 - ((box.minY + box.maxY) / 2) * scale,
    })
  }

  /** Zoom to the whole sheet, or to the given objects. */
  fit(ids?: Set<string>): void {
    const sheet = this.sheet()
    if (!sheet) return
    const box = sheetBounds(sheet, project().symbols, ids && ids.size > 0 ? { ids } : undefined)
    const rect = this.canvas.getBoundingClientRect()
    if (!box) {
      editor().setView({ scale: 0.1, x: rect.width / 2, y: rect.height / 2 })
      return
    }
    const { minX, maxX, minY, maxY } = box
    // Screen margins: room for part names/values next to the bounds and for the floating tool
    // bar on the right edge of the canvas (TOOLBAR_PX), so nothing ends up hidden under it.
    const margin = 48
    const pad = 4 * GRID // world margin too, so a small circuit is not blown up to fill the view
    const width = Math.max(50, rect.width - 2 * margin - TOOLBAR_PX)
    const height = Math.max(50, rect.height - 2 * margin)
    const scale = Math.min(
      MAX_SCALE,
      Math.max(MIN_SCALE, Math.min(width / (maxX - minX + 2 * pad), height / (maxY - minY + 2 * pad))),
    )
    editor().setView({
      scale,
      x: margin + width / 2 - ((minX + maxX) / 2) * scale,
      y: margin + height / 2 - ((minY + maxY) / 2) * scale,
    })
  }

  // -- wires ------------------------------------------------------------------------------------

  /** True if p connects to something (pin, wire, label) so a wire ending there is done. */
  private isConnectionPoint(p: Point): boolean {
    const sheet = this.sheet()
    return sheet !== null && isConnectionPoint(sheet, project().symbols, p)
  }

  private addWirePoint(p: Point): void {
    const tool = editor().tool
    if (tool.kind !== 'wire') return
    if (tool.points.length === 0) {
      editor().setTool({ ...tool, points: [p] })
      return
    }
    const last = tool.points[tool.points.length - 1]
    if (samePoint(last, p)) {
      void this.finishWire()
      return
    }
    const mode = useSettings.getState().wireMode
    const points = [...tool.points, ...route(last, p, mode, tool.horizontalFirst).slice(1)]
    editor().setTool({ ...tool, points })
    if (this.isConnectionPoint(p)) void this.finishWire()
  }

  private async finishWire(): Promise<void> {
    const tool = editor().tool
    if (tool.kind !== 'wire') return
    const points = simplify(tool.points)
    editor().setTool({ ...tool, points: [] })
    if (points.length < 2) return
    const crossings = useSettings.getState().autoJunctions
      ? wireCrossings(points, this.sheet()?.wires ?? [])
      : []
    await project().execute({
      type: 'add_objects',
      sheet: this.sheetName,
      wires: [{ id: newId(), points, ...(tool.bus ? { bus: true } : {}) }],
      junctions: tool.bus ? [] : crossings.map((at) => ({ id: newId(), at })),
    })
  }

  /** A pin connection point under the pointer that has nothing attached yet. */
  private freePinAt(world: Point): Point | null {
    const sheet = this.sheet()
    if (!sheet) return null
    const tolerance = this.tolerance()
    const symbols = project().symbols
    for (const inst of sheet.instances) {
      const symbol = symbols.get(inst.symbol)
      if (!symbol?.spice) continue
      for (const pin of pinPositions(symbol, inst)) {
        if (Math.hypot(pin.at[0] - world[0], pin.at[1] - world[1]) > tolerance) continue
        const used =
          sheet.wires.some((w) => w.points.some((p) => samePoint(p, pin.at))) ||
          sheet.labels.some((l) => samePoint(l.at, pin.at))
        return used ? null : pin.at
      }
    }
    return null
  }

  private openContextMenu(screen: Point, client: Point): void {
    const world = this.toWorld(screen)
    const tool = editor().tool
    if (tool.kind === 'wire' && tool.points.length > 1) {
      void this.finishWire() // like KiCad: right click ends the wire in progress
      return
    }
    if (tool.kind !== 'select') editor().setTool({ kind: 'select' })
    const hit = this.index.at(world, this.tolerance())
    if (hit && !editor().selection.has(hit.id)) editor().select([hit.id])
    editor().setContextMenu({
      client,
      world: snapPoint(world),
      target: hit ? { kind: hit.kind, id: hit.id } : { kind: 'empty' },
    })
  }

  // -- operations used by menus -------------------------------------------------------------

  /** Add a net label (asks for the name) at a point on a wire. */
  async addLabelAt(at: Point): Promise<void> {
    const text = await prompt({ title: 'Net label', label: 'Net name', placeholder: 'out' })
    if (!text) return
    await project().execute({
      type: 'add_objects',
      sheet: this.sheetName,
      labels: [{ id: newId(), kind: 'local', text: text.trim(), at, rot: 0 }],
    })
  }

  async addJunctionAt(at: Point): Promise<void> {
    await project().execute({ type: 'add_objects', sheet: this.sheetName, junctions: [{ id: newId(), at }] })
  }

  probeAt(world: Point, power = false): void {
    this.probe(world, false, power)
  }

  highlightNetAt(world: Point): void {
    this.highlightAt(world)
  }

  /** Edit the main value of a part (R, C, source spec, model) in a small prompt. */
  async editValue(id: string): Promise<void> {
    const inst = this.sheet()?.instances.find((i) => i.id === id)
    const symbol = inst && project().symbols.get(inst.symbol)
    if (!inst || !symbol) return
    const usesModel = symbol.default_model !== null || inst.model.model
    const key =
      symbol.value_param ?? (symbol.spice?.element === 'V' || symbol.spice?.element === 'I' ? 'dc' : null)
    const current = usesModel
      ? (inst.model.model ?? symbol.default_model ?? '')
      : key
        ? (inst.model.params[key] ?? symbol.default_params[key] ?? '')
        : ''
    const value = await prompt({
      title: `${inst.ref} value`,
      label: usesModel ? 'Model name' : `Parameter ${key}`,
      initial: current,
    })
    if (value === null || value === current) return
    await project().execute(
      usesModel
        ? { type: 'set_params', sheet: this.sheetName, id, params: {}, model: value.trim() }
        : { type: 'set_params', sheet: this.sheetName, id, params: { [key ?? 'value']: value.trim() } },
    )
  }

  async editLabel(id: string): Promise<void> {
    const label = this.sheet()?.labels.find((l) => l.id === id)
    if (!label) return
    const text = await prompt({ title: 'Net label', label: 'Net name', initial: label.text })
    if (text && text !== label.text)
      await project().execute({ type: 'update_label', sheet: this.sheetName, id, text: text.trim() })
  }

  /** Highlight the net of the wire / label / pin under the pointer (click again to clear). */
  private highlightAt(world: Point): void {
    const nets = useSimulation.getState().nets
    const hit = this.index.at(world, this.tolerance())
    let net: string | undefined
    if (nets && hit?.kind === 'wires') net = nets.wires[hit.id]
    else if (nets && hit?.kind === 'labels') net = nets.labels[hit.id]
    else if (nets && hit?.kind === 'instances') {
      const inst = this.sheet()?.instances.find((i) => i.id === hit.id)
      const symbol = inst && project().symbols.get(inst.symbol)
      if (inst && symbol) {
        const nearest = pinPositions(symbol, inst).reduce((best, p) =>
          Math.hypot(p.at[0] - world[0], p.at[1] - world[1]) <
          Math.hypot(best.at[0] - world[0], best.at[1] - world[1])
            ? p
            : best,
        )
        net = nets.pins[`${inst.id}:${nearest.number}`]
      }
    }
    editor().setHighlightNet(net && net !== editor().highlightNet ? net : null)
    if (net) toast(`Net ${net}`, { duration: 1500 })
  }

  // -- probes ----------------------------------------------------------------------------------

  /** Add a plot trace for what is under the pointer (see the probe tool docs in the UI). */
  private probe(world: Point, setReference: boolean, power: boolean): void {
    const sheet = this.sheet()
    const sim = useSimulation.getState()
    const nets = sim.nets
    const hit = this.index.at(world, this.tolerance())
    if (!sheet || !nets || !hit) return
    if (hit.kind === 'wires' || hit.kind === 'labels') {
      const net = hit.kind === 'wires' ? nets.wires[hit.id] : nets.labels[hit.id]
      if (!net) return
      if (setReference) {
        sim.setProbeReference(net)
        toast(`Reference node: ${net}`, { description: 'Click another net for a differential voltage.' })
        return
      }
      const reference = sim.probeReference
      if (reference && reference !== net) {
        sim.addTrace(`V(${net},${reference})`)
        sim.setProbeReference(null)
      } else if (net !== '0') {
        sim.addTrace(`V(${net})`)
      }
      return
    }
    if (hit.kind !== 'instances') return
    const inst = sheet.instances.find((i) => i.id === hit.id)
    const symbol = inst && project().symbols.get(inst.symbol)
    if (!inst || !symbol?.spice) return
    const pins = pinPositions(symbol, inst)
    if (pins.length === 2) {
      if (power) {
        const [a, b] = pins.map((p) => nets.pins[`${inst.id}:${p.number}`] ?? '0')
        sim.addTrace(`(V(${a})-V(${b}))*I(${inst.ref})`)
      } else {
        sim.addTrace(`I(${inst.ref})`)
      }
      return
    }
    // Multi-terminal parts: current into the pin nearest to the click.
    const nearest = pins.reduce((best, p) =>
      Math.hypot(p.at[0] - world[0], p.at[1] - world[1]) <
      Math.hypot(best.at[0] - world[0], best.at[1] - world[1])
        ? p
        : best,
    )
    if (symbol.spice.element === 'E' || symbol.spice.element === 'G')
      sim.addTrace(`V(${nets.pins[`${inst.id}:${nearest.number}`]})`)
    else sim.addTrace(`I(${inst.ref}.${nearest.number})`)
  }

  // -- placing ---------------------------------------------------------------------------------

  private async placeSymbol(at: Point): Promise<void> {
    const tool = editor().tool
    if (tool.kind !== 'place') return
    await this.placeAt(tool.symbolId, at, tool.rot, tool.mirror, tool.params)
  }

  /** Add one symbol instance with its default parameters (ref numbered by the backend). */
  async placeAt(
    symbolId: string,
    at: Point,
    rot: Rotation = 0,
    mirror = false,
    params: Record<string, string> = {},
  ): Promise<boolean> {
    const symbol = project().symbols.get(symbolId)
    if (!symbol || !project().project) return false
    const look = project().project?.default_looks?.[symbol.id] ?? symbol.looks?.find((l) => l.default)?.name
    const instance: Instance = {
      id: newId(),
      ref: `${symbol.ref_prefix}?`, // numbered by the backend (no collisions between clients)
      symbol: symbol.id,
      model: { kind: 'builtin', model: null, params: { ...symbol.default_params, ...params } },
      at,
      rot,
      mirror,
      ...(look ? { look } : {}),
    }
    const ok = await project().execute({ type: 'add_objects', sheet: this.sheetName, instances: [instance] })
    if (ok) {
      editor().select([instance.id])
      useRecentSymbols.getState().use(symbol.id)
    }
    return ok
  }

  /** A sheet parameter dropped on a part (template editor): the part's value becomes {name}. */
  async dropParameter(name: string, clientX: number, clientY: number): Promise<boolean> {
    const rect = this.canvas.getBoundingClientRect()
    const world = this.toWorld([clientX - rect.left, clientY - rect.top])
    const hit = this.index.at(world, this.tolerance() * 2)
    const inst = hit?.kind === 'instances' ? this.sheet()?.instances.find((i) => i.id === hit.id) : undefined
    const symbol = inst && project().symbols.get(inst.symbol)
    const key =
      symbol?.value_param ?? (symbol?.spice?.element === 'V' || symbol?.spice?.element === 'I' ? 'dc' : null)
    if (!inst || !key) {
      toast.info('Drop the parameter on a part with a value (R, C, L, a source…)')
      return false
    }
    editor().select([inst.id])
    const value = `{${name}}`
    return project().execute({
      type: 'set_params',
      sheet: this.sheetName,
      id: inst.id,
      params: { [key]: value },
    })
  }

  /** Drop from the library: place where the symbol was released (client coordinates). */
  async dropSymbol(symbolId: string, clientX: number, clientY: number): Promise<void> {
    const rect = this.canvas.getBoundingClientRect()
    const world = this.toWorld([clientX - rect.left, clientY - rect.top])
    editor().setTool({ kind: 'select' })
    // Dropped on a placed part with as many pins (an ideal C, a real one): it takes its place,
    // keeping its position, rotation and wiring.
    const hit = this.index.at(world, this.tolerance())
    const inst = hit?.kind === 'instances' ? this.sheet()?.instances.find((i) => i.id === hit.id) : undefined
    const placed = inst && project().symbols.get(inst.symbol)
    const dropped = project().symbols.get(symbolId)
    const fits = placed && dropped && placed.pins.length > 1 && placed.pins.length === dropped.pins.length
    if (inst && dropped && fits && inst.symbol !== symbolId) {
      editor().select([inst.id])
      await project().execute({
        type: 'transaction',
        label: `${inst.ref} → ${dropped.name}`,
        commands: toRealPart(this.sheetName, inst, symbolId),
      })
      toast.success(`${inst.ref} is now ${dropped.name} (Ctrl+Z to undo)`)
      return
    }
    await this.placeAt(symbolId, snapPoint(world))
  }

  private async placeDirective(at: Point): Promise<void> {
    const tool = editor().tool
    if (tool.kind !== 'directive') return
    editor().setTool({ kind: 'select' })
    await project().execute({
      type: 'add_objects',
      sheet: this.sheetName,
      directives: [{ id: newId(), text: tool.text, at }],
    })
  }

  private async placeLabel(cursor: Point): Promise<void> {
    const tool = editor().tool
    if (tool.kind !== 'label' || !tool.text) return
    // Dropped next to a wire, the label goes onto it (otherwise it would connect to nothing).
    const at = labelPoint(cursor, this.sheet()?.wires ?? [], editor().view.scale)
    const ok = await project().execute({
      type: 'add_objects',
      sheet: this.sheetName,
      labels: [{ id: newId(), kind: tool.labelKind, text: tool.text, at, rot: 0 }],
    })
    // Like KiCad: the next label continues the number (D0 -> D1) – unless the user left the
    // tool (Esc, another tool) while the label was being added.
    const current = editor().tool
    if (ok && current.kind === 'label' && current.text === tool.text) {
      const next = tool.text.replace(/(\d+)$/, (n) => String(Number(n) + 1))
      editor().setTool({ ...current, text: next })
    }
  }

  private async startPlacing(symbolId: string | null, params?: Record<string, string>): Promise<void> {
    if (!symbolId) return
    editor().clearSelection()
    editor().setTool({ kind: 'place', symbolId, rot: 0, mirror: false, params })
  }

  // -- selection edits --------------------------------------------------------------------------

  private selected(): { sheet: Sheet; ids: string[] } | null {
    const sheet = this.sheet()
    const ids = [...editor().selection]
    if (!sheet || ids.length === 0) return null
    return { sheet, ids }
  }

  private async commitMove(): Promise<void> {
    const move = editor().move
    const sheet = this.sheet()
    editor().setMove(null)
    if (!move || !sheet) return
    const selection = editor().selection
    const after = previewSheet(sheet, selection, move.delta, move.stretchWires, project().symbols)
    const commands = moveCommands(this.sheetName, sheet, after, selection, move.delta)
    if (commands.length) await project().execute({ type: 'transaction', label: 'move', commands })
  }

  private async commitWireEdit(): Promise<void> {
    const edit = editor().wireEdit
    editor().setWireEdit(null)
    const wire = this.sheet()?.wires.find((w) => w.id === edit?.wireId)
    if (!edit || !wire) return
    const points = editWire(wire.points, edit)
    if (points.length === wire.points.length && points.every((p, i) => samePoint(p, wire.points[i]))) return
    await project().execute({ type: 'set_wire_points', sheet: this.sheetName, id: wire.id, points })
  }

  /** Arrow keys: the selection one grid step (Shift: ten) with its wires following. */
  private async nudge(x: number, y: number, event?: KeyboardEvent): Promise<void> {
    const sheet = this.sheet()
    const selection = editor().selection
    if (!sheet || selection.size === 0 || editor().move) return
    const step = GRID * (event?.shiftKey ? 10 : 1)
    const delta: Point = [x * step, y * step]
    const after = previewSheet(sheet, selection, delta, true, project().symbols)
    const commands = moveCommands(this.sheetName, sheet, after, selection, delta)
    if (commands.length) await project().execute({ type: 'transaction', label: 'move', commands })
  }

  private startKeyboardMove(stretch: boolean): void {
    if (editor().selection.size === 0) {
      const hit = this.index.at(editor().cursor, this.tolerance())
      if (!hit) return
      editor().select([hit.id])
    }
    editor().setMove({ delta: [0, 0], stretchWires: stretch, fromKeyboard: true, anchor: editor().cursor })
  }

  private async transform(kind: 'rotate' | 'mirrorX' | 'mirrorY'): Promise<void> {
    const drag = editor().textDrag
    if (drag && this.pendingText && kind === 'rotate') {
      const place: TextPlace = { ...drag.place, rot: drag.place.rot === 90 ? 0 : 90 }
      this.pendingText.place = { ...this.pendingText.place, rot: place.rot }
      editor().setTextDrag({ ...drag, place })
      return
    }
    const tool = editor().tool
    if (tool.kind === 'place') {
      if (kind === 'rotate') editor().setTool({ ...tool, rot: rotate(tool.rot, 90) })
      // The same as for placed parts (a part at 90° used to flip about its diagonal).
      else editor().setTool({ ...tool, mirror: !tool.mirror, rot: mirroredRotation(tool.rot, kind) })
      return
    }
    const sel = this.selected()
    if (!sel) return
    const commands = transformCommands(this.sheetName, sel.sheet, editor().selection, kind)
    if (commands.length) await project().execute({ type: 'transaction', label: kind, commands })
  }

  /** The reference or value of a selected part under `world`, with its placement now. */
  private selectedTextAt(world: Point): { id: string; field: TextField; place: TextPlace } | null {
    const sheet = this.sheet()
    if (!sheet) return null
    const selection = editor().selection
    const pad = this.tolerance() / 2
    for (const inst of sheet.instances) {
      if (!selection.has(inst.id)) continue
      const symbol = project().symbols.get(inst.symbol)
      if (!symbol) continue
      for (const field of ['ref', 'value'] as const) {
        const spot = textSpot(symbol, inst, field)
        const content = field === 'ref' ? inst.ref : valueText(symbol, inst)
        if (!spot || !content) continue
        const box = textBox(spot, content.length, TEXT_CHAR)
        if (
          world[0] >= box.minX - pad &&
          world[0] <= box.maxX + pad &&
          world[1] >= box.minY - pad &&
          world[1] <= box.maxY + pad
        )
          return { id: inst.id, field, place: placeOf(spot, inst, content.length, TEXT_CHAR) }
      }
    }
    return null
  }

  /** Put a part's text by hand (one undo step); null = back where the symbol puts it. */
  async setTextPlace(id: string, field: TextField, place: TextPlace | null): Promise<void> {
    const inst = this.sheet()?.instances.find((i) => i.id === id)
    if (!inst) return
    const texts = { ...inst.texts }
    if (place) texts[field] = place
    else delete texts[field]
    await project().execute({ type: 'update_instance', sheet: this.sheetName, id, texts })
  }

  private async deleteSelection(): Promise<void> {
    const sel = this.selected()
    if (!sel) return
    editor().clearSelection()
    await project().execute({ type: 'remove_objects', sheet: this.sheetName, ids: sel.ids })
  }

  private copy(): void {
    const sel = this.selected()
    if (!sel) return
    const pick = <T extends { id: string }>(items: T[]) =>
      structuredClone(items.filter((i) => editor().selection.has(i.id)))
    this.clipboard = {
      origin: editor().cursor,
      instances: pick(sel.sheet.instances),
      wires: pick(sel.sheet.wires),
      labels: pick(sel.sheet.labels),
      junctions: pick(sel.sheet.junctions),
      directives: pick(sel.sheet.directives),
    }
  }

  private async paste(offset: Point = [2 * GRID, 2 * GRID]): Promise<void> {
    const clip = this.clipboard
    if (!clip) return
    const shift = ([x, y]: Point): Point => [x + offset[0], y + offset[1]]
    const instances = clip.instances.map((inst) => {
      const prefix = project().symbols.get(inst.symbol)?.ref_prefix ?? inst.ref.replace(/\d+$/, '')
      return { ...inst, id: newId(), ref: `${prefix}?`, at: shift(inst.at) }
    })
    const command: Command = {
      type: 'add_objects',
      sheet: this.sheetName,
      instances,
      wires: clip.wires.map((w) => ({ ...w, id: newId(), points: w.points.map(shift) })),
      labels: clip.labels.map((l) => ({ ...l, id: newId(), at: shift(l.at) })),
      junctions: clip.junctions.map((j) => ({ ...j, id: newId(), at: shift(j.at) })),
      directives: clip.directives.map((d) => ({ ...d, id: newId(), at: shift(d.at) })),
    }
    if (await project().execute(command)) {
      const ids = [
        ...instances,
        ...(command.wires ?? []),
        ...(command.labels ?? []),
        ...(command.junctions ?? []),
        ...(command.directives ?? []),
      ].map((o) => o.id)
      editor().select(ids)
    }
  }

  /** Open the sheet of the selected block; false when the selection is not one block. */
  private enterBlock(): boolean {
    const selection = editor().selection
    if (selection.size !== 1) return false
    const [id] = selection
    const block = this.sheet()?.instances.find((i) => i.id === id && i.symbol.startsWith('sheet:'))
    if (!block) return false
    editor().clearSelection()
    // Seen through this block: probes inside are named X2.<net> when entered through X2.
    const { project: doc, sheetName, viewPath } = project()
    const above = viewSteps(doc?.sheets ?? [], sheetName, viewPath).map((s) => s.ref)
    project().setSheet(block.symbol.slice('sheet:'.length), [...above, block.ref])
    return true
  }

  private cancel(): void {
    const { tool, move } = editor()
    if (move) {
      editor().setMove(null)
      return
    }
    if (tool.kind === 'wire' && tool.points.length > 1) {
      void this.finishWire()
      return
    }
    if (tool.kind !== 'select') {
      editor().setTool({ kind: 'select' })
      if (tool.kind === 'highlight') editor().setHighlightNet(null)
      return
    }
    if (editor().highlightNet) {
      editor().setHighlightNet(null)
      return
    }
    editor().clearSelection()
  }

  private actions() {
    const centerZoom = (factor: number) => {
      const rect = this.canvas.getBoundingClientRect()
      this.zoomAt([rect.width / 2, rect.height / 2], factor)
    }
    return {
      'tool.select': () => editor().setTool({ kind: 'select' }),
      // Ś9: the selection as a block, then the part editor on it; saved, the part takes its place.
      'edit.makePart': async () => {
        const ref = await createBlock([...editor().selection])
        const block = ref ? this.sheet()?.instances.find((i) => i.ref === ref) : undefined
        if (!block) return
        const sheet = block.symbol.replace(/^sheet:/, '')
        openComponentWizard({
          mode: 'sheet',
          sheet,
          name: sheet,
          replace: { sheet: this.sheetName, id: block.id },
          page: 'data',
        })
      },
      'edit.makeBlock': async () => {
        const ref = await createBlock([...editor().selection])
        const block = ref ? this.sheet()?.instances.find((i) => i.ref === ref) : undefined
        if (block) editor().select([block.id])
      },
      'sheet.enter': () => {
        if (!this.enterBlock()) toast.info('Select a block (a sheet placed as a part) to open it')
      },
      'sheet.up': () => {
        const sheets = project().project?.sheets ?? []
        const path = viewSteps(sheets, project().sheetName, project().viewPath)
        if (path.length)
          project().setSheet(
            path[path.length - 1].sheet,
            path.length > 1 ? path.slice(0, -1).map((p) => p.ref) : null,
          )
      },
      'tool.wire': () => {
        editor().clearSelection()
        editor().setTool({ kind: 'wire', points: [], horizontalFirst: true })
      },
      'tool.bus': () => {
        editor().clearSelection()
        editor().setTool({ kind: 'wire', points: [], horizontalFirst: true, bus: true })
      },
      'tool.label': async () => {
        const text = await prompt({ title: 'Net label', label: 'Net name', placeholder: 'out' })
        if (text) editor().setTool({ kind: 'label', text: text.trim(), labelKind: 'local' })
      },
      'tool.portLabel': async () => {
        const text = await prompt({
          title: 'Port (hierarchical label)',
          label: 'Port name – this sheet can then be placed as a block with this pin',
          placeholder: 'in',
        })
        if (text) editor().setTool({ kind: 'label', text: text.trim(), labelKind: 'port' })
      },
      'tool.globalLabel': async () => {
        const text = await prompt({
          title: 'Global label',
          label: 'Net name (joins all sheets)',
          placeholder: 'VCC',
        })
        if (text) editor().setTool({ kind: 'label', text: text.trim(), labelKind: 'global' })
      },
      'tool.directive': async () => {
        const text = await prompt({
          title: 'SPICE directive',
          label: 'Text',
          placeholder: '.param Rload=1k',
          multiline: true,
        })
        if (text) editor().setTool({ kind: 'directive', text })
      },
      'place.symbol': async () => this.startPlacing(await pickSymbol()),
      'place.ground': () => this.startPlacing('bpt:gnd'),
      'place.resistor': () => this.startPlacing('bpt:resistor'),
      'place.capacitor': () => this.startPlacing('bpt:capacitor'),
      'place.inductor': () => this.startPlacing('bpt:inductor'),
      'place.diode': () => this.startPlacing('bpt:diode'),
      'place.vsource': () => this.startPlacing('bpt:vsource'),
      'place.isource': () => this.startPlacing('bpt:isource'),
      'place.npn': () => this.startPlacing('bpt:npn'),
      'place.pnp': () => this.startPlacing('bpt:pnp'),
      'place.nmos': () => this.startPlacing('bpt:nmos'),
      'place.opamp': () => this.startPlacing('bpt:opamp_ideal'),
      'place.power': async () => {
        const net = await prompt({ title: 'Power net', label: 'Net name', initial: 'VCC' })
        if (net) await this.startPlacing('bpt:power', { net: net.trim() })
      },
      'place.junction': () => {
        editor().clearSelection()
        editor().setTool({ kind: 'junction' })
      },
      'edit.rotate': () => this.transform('rotate'),
      'edit.mirrorX': () => this.transform('mirrorX'),
      'edit.mirrorY': () => this.transform('mirrorY'),
      'edit.alignLeft': () => void this.align('left'),
      'edit.alignRight': () => void this.align('right'),
      'edit.alignTop': () => void this.align('top'),
      'edit.alignBottom': () => void this.align('bottom'),
      'edit.alignCenterX': () => void this.align('centerX'),
      'edit.alignCenterY': () => void this.align('centerY'),
      'edit.distributeX': () => void this.align('distributeX'),
      'edit.distributeY': () => void this.align('distributeY'),
      'edit.move': () => this.startKeyboardMove(false),
      'edit.nudgeLeft': (e?: KeyboardEvent) => void this.nudge(-1, 0, e),
      'edit.nudgeRight': (e?: KeyboardEvent) => void this.nudge(1, 0, e),
      'edit.nudgeUp': (e?: KeyboardEvent) => void this.nudge(0, -1, e),
      'edit.nudgeDown': (e?: KeyboardEvent) => void this.nudge(0, 1, e),
      'edit.drag': () => this.startKeyboardMove(true),
      'edit.delete': () => this.deleteSelection(),
      'edit.copy': () => this.copy(),
      'edit.cut': () => {
        this.copy()
        void this.deleteSelection()
      },
      'edit.paste': () => this.paste(),
      'edit.duplicate': () => {
        this.copy()
        void this.paste()
      },
      'edit.selectAll': () => {
        const sheet = this.sheet()
        if (sheet)
          editor().select(
            [
              ...sheet.instances,
              ...sheet.wires,
              ...sheet.labels,
              ...sheet.junctions,
              ...sheet.directives,
            ].map((o) => o.id),
          )
      },
      'edit.cancel': () => this.cancel(),
      'wire.toggleCorner': () => {
        const tool = editor().tool
        if (tool.kind === 'wire') editor().setTool({ ...tool, horizontalFirst: !tool.horizontalFirst })
      },
      'wire.cycleMode': () => {
        const modes: WireMode[] = ['90', '45', 'free']
        const next = modes[(modes.indexOf(useSettings.getState().wireMode) + 1) % modes.length]
        useSettings.getState().update({ wireMode: next })
        toast(`Wire: ${next === 'free' ? 'any angle' : `${next}°`}`, { duration: 1500 })
      },
      'edit.properties': () => {
        if (editor().selection.size === 0) {
          const hit = this.index.at(editor().cursor, this.tolerance())
          if (hit) editor().select([hit.id])
        }
        window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'properties' }))
        window.dispatchEvent(new CustomEvent('bpt:edit-properties'))
      },
      'tool.highlightNet': () => {
        editor().clearSelection()
        editor().setTool({ kind: 'highlight' })
      },
      'sim.probe': () => {
        editor().clearSelection()
        editor().setTool({ kind: 'probe' })
      },
      'view.fit': () => this.fit(),
      'view.zoomSelection': () => this.fit(editor().selection),
      'view.zoomIn': () => centerZoom(1.25),
      'view.zoomOut': () => centerZoom(0.8),
    }
  }
}
