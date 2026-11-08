import { useEffect, useRef } from 'react'
import type { Point, Sheet, SheetNets, SymbolDef } from '@/api/types'
import { sheetScope } from '@/lib/expr'
import { partTag } from '@/lib/partTag'
import { canvasPalette, useTheme } from '@/lib/theme'
import { formatValue } from '@/lib/units'
import { SheetTabs } from '@/panels/SheetTabs'
import { useDialogs } from '@/store/dialogs'
import { useEditor } from '@/store/editor'
import { currentSheet, useProject } from '@/store/project'
import { useSettings } from '@/store/settings'
import { useSimulation } from '@/store/simulation'
import { ContextMenu } from './ContextMenu'
import { activeEditor, EditorController } from './controller'
import { DrawingToolbar } from './DrawingToolbar'
import {
  GRID,
  instanceBox,
  isConnectionPoint,
  labelPoint,
  pinPositions,
  route,
  sheetBounds,
  transform,
} from './geometry'
import { HitIndex } from './hittest'
import { MiniWave } from './MiniWave'
import { editWire, previewSheet } from './preview'
import { type Annotation, SchematicRenderer, TEXT_WIDTH } from './renderer'

declare global {
  interface Window {
    /** Hooks for automation (screenshots for AI agents, end-to-end tests). */
    __bpt?: {
      snapshot: () => Promise<string>
      fit: () => void
      toScreen: (p: Point) => Point
      capture: (target: string, maxPx: number) => CaptureImage
    }
  }
}

/** Operating point texts: one voltage per net (next to its label, else on its longest wire),
 *  and device currents under the part's value text. */
function opAnnotations(
  sheet: Sheet,
  symbols: Map<string, SymbolDef>,
  nets: SheetNets,
  values: Record<string, number>,
  realism: 'always' | 'hover' | 'off',
  show: { voltages: boolean; currents: boolean; power: boolean } = {
    voltages: true,
    currents: true,
    power: false,
  },
): Annotation[] {
  const items: Annotation[] = []
  // Nets already labelled (ground never); with voltages off, every net counts as done.
  const placed = new Set<string>(['0'])
  if (!show.voltages) for (const net of Object.values(nets.wires)) placed.add(net)
  if (!show.voltages) for (const net of Object.values(nets.labels)) placed.add(net)
  const longest = (points: Point[]) => {
    let best: [Point, Point] = [points[0], points[1]]
    for (let i = 0; i + 1 < points.length; i++) {
      const [a, b] = [points[i], points[i + 1]]
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > Math.hypot(best[1][0] - best[0][0], best[1][1] - best[0][1]))
        best = [a, b]
    }
    return best
  }
  // Labels first: the value goes right after the label text, so it never covers it.
  for (const label of sheet.labels) {
    const net = nets.labels[label.id]
    const value = values[`V(${net})`]
    if (!net || placed.has(net) || value === undefined) continue
    placed.add(net)
    const width = label.text.length * TEXT_WIDTH + (label.kind === 'global' ? 150 : 25)
    const y = label.kind === 'global' ? label.at[1] : label.at[1] - 95
    items.push({ at: [label.at[0] + width + 70, y], text: `= ${formatValue(value, 'V', 3)}` })
  }
  for (const wire of sheet.wires) {
    const net = nets.wires[wire.id]
    const value = values[`V(${net})`]
    if (!net || placed.has(net) || value === undefined) continue
    placed.add(net)
    const [a, b] = longest(wire.points)
    items.push({ at: [(a[0] + b[0]) / 2 + 30, (a[1] + b[1]) / 2 - 90], text: formatValue(value, 'V', 3) })
  }
  for (const inst of sheet.instances) {
    const symbol = symbols.get(inst.symbol)
    if (!symbol?.spice || inst.symbol.startsWith('bpt:probe_')) continue // probes show their own
    const current =
      values[`I(${inst.ref})`] ??
      values[`I(${inst.ref}.C)`] ??
      values[`I(${inst.ref}.D)`] ??
      values[`I(${inst.ref}.out+)`]
    if (current === undefined) continue
    const anchor = symbol.value_at ?? symbol.ref_at ?? [152, 0]
    // Same side as the value text, one line below it (two when the parasitics line is shown).
    const [x, y] = transform(anchor, inst)
    const side = transform(anchor, { ...inst, at: [0, 0] })[0] >= 0 ? 'left' : 'right'
    let lines = realism === 'always' && partTag(symbol, inst) ? 2 : 1
    if (show.currents) {
      items.push({ at: [x, y + 135 * lines], text: formatValue(current, 'A', 3), align: side })
      lines++
    }
    // Power of a two-terminal part: the voltage across it times the current into pin 1.
    const pins = symbol.pins.map((pin) => nets.pins[`${inst.id}:${pin.number}`])
    if (show.power && pins.length === 2 && pins.every((n) => n !== undefined)) {
      const v = (net: string) => (net === '0' ? 0 : values[`V(${net})`])
      const [a, b] = [v(pins[0]), v(pins[1])]
      if (a !== undefined && b !== undefined)
        items.push({ at: [x, y + 135 * lines], text: formatValue((a - b) * current, 'W', 3), align: side })
    }
  }
  return items
}

/** Pin ends whose net has nothing else on it (no other pin, wire or label). */
function unconnectedPins(sheet: Sheet, symbols: Map<string, SymbolDef>, nets: SheetNets): Point[] {
  const uses = new Map<string, number>()
  for (const net of [
    ...Object.values(nets.pins),
    ...Object.values(nets.wires),
    ...Object.values(nets.labels),
  ])
    uses.set(net, (uses.get(net) ?? 0) + 1)
  const out: Point[] = []
  for (const inst of sheet.instances) {
    const symbol = symbols.get(inst.symbol)
    if (!symbol?.spice) continue
    for (const pin of symbol.pins) {
      if (pin.implicit_net) continue // hidden power pin: joined by name, never drawn
      const net = nets.pins[`${inst.id}:${pin.number}`]
      if (net !== undefined && uses.get(net) === 1) out.push(transform(pin.at, inst))
    }
  }
  return out
}

export interface CaptureImage {
  image: string
  meta: Record<string, unknown>
}

/** Off-screen picture of (part of) the current sheet for AI agents. */
function captureSheet(renderer: SchematicRenderer, target: string, maxPx: number): CaptureImage {
  const state = useProject.getState()
  const sheet = currentSheet(state)
  if (!sheet) throw new Error('no sheet is open')
  if (target.startsWith('sheet:') && target.slice(6) !== sheet.name) {
    throw new Error(`sheet ${target.slice(6)} is not open in the editor`)
  }
  let filter: { ids?: Set<string>; refs?: Set<string> } | undefined
  if (target === 'selection' && useEditor.getState().selection.size > 0) {
    filter = { ids: useEditor.getState().selection }
  } else if (target.startsWith('refs:')) {
    filter = {
      refs: new Set(
        target
          .slice(5)
          .split(',')
          .map((r) => r.trim().toLowerCase()),
      ),
    }
  }
  const bounds = sheetBounds(sheet, state.symbols, filter)
  if (!bounds) throw new Error(filter ? 'nothing matches the capture target' : 'the sheet is empty')
  const pad = 3 * GRID
  const box = {
    minX: bounds.minX - pad,
    minY: bounds.minY - pad,
    maxX: bounds.maxX + pad,
    maxY: bounds.maxY + pad,
  }
  const visible = sheet.instances.filter((inst) => {
    const symbol = state.symbols.get(inst.symbol)
    if (!symbol || symbol.power_net !== null) return false
    const b = instanceBox(symbol, inst)
    return b.maxX > box.minX && b.minX < box.maxX && b.maxY > box.minY && b.minY < box.maxY
  })
  return {
    image: renderer.captureRegion(box, maxPx),
    meta: {
      target,
      sheet: sheet.name,
      refs: visible.map((i) => i.ref),
      width_mm: (box.maxX - box.minX) / 100,
      height_mm: (box.maxY - box.minY) / 100,
    },
  }
}

const EXAMPLE = `V1 in 0 DC 0 AC 1 SIN(0 1 1k)
R1 in out 1k
C1 out 0 159n`

/** Small text next to the cursor: move deltas, wire length, net and voltage under a probe. */
function CursorTip() {
  const enabled = useSettings((s) => s.cursorTips)
  const { cursor, view, pointerInside, move, wireEdit, tool, hover } = useEditor()
  const nets = useSimulation((s) => s.nets)
  const opValues = useSimulation((s) => s.opValues)
  const meta = useSimulation((s) => s.meta)
  const sheet = useProject((s) => currentSheet(s))
  if (!pointerInside || !enabled) return null
  // After a run with waveforms: hovering a wire shows its net's waveform in small.
  const waveNet =
    tool.kind === 'select' && !move && hover && nets && meta?.status === 'ok' && meta.scale
      ? (nets.wires[hover] ?? nets.labels[hover])
      : undefined
  const mm = (v: number) => (v / 100).toFixed(2)
  let text: string | null = null
  const delta = move?.delta ?? wireEdit?.delta
  if (delta && (delta[0] || delta[1])) text = `Δ ${mm(delta[0])}, ${mm(delta[1])} mm`
  else if (tool.kind === 'wire' && tool.points.length > 0) {
    const last = tool.points[tool.points.length - 1]
    text = `${mm(Math.abs(cursor[0] - last[0]) + Math.abs(cursor[1] - last[1]))} mm`
  } else if ((tool.kind === 'probe' || tool.kind === 'highlight') && hover && nets && sheet) {
    const net = nets.wires[hover] ?? nets.labels[hover]
    const inst = sheet.instances.find((i) => i.id === hover)
    if (net) {
      const v = opValues?.[`V(${net})`]
      text = v === undefined ? net : `${net}: ${formatValue(v, 'V')}`
    } else if (inst) {
      const i = opValues?.[`I(${inst.ref})`]
      text = i === undefined ? inst.ref : `${inst.ref}: ${formatValue(i, 'A')}`
    }
  }
  const signal = waveNet && waveNet !== '0' ? `V(${waveNet})` : null
  if (!text && signal) text = signal
  if (!text) return null
  const x = cursor[0] * view.scale + view.x + 16
  const y = cursor[1] * view.scale + view.y + 16
  return (
    <div
      className="pointer-events-none absolute z-20 rounded border bg-background/90 px-1.5 py-0.5 font-mono text-[11px] shadow-sm"
      style={{ left: x, top: y }}
    >
      {text}
      {signal && meta && <MiniWave runId={meta.run_id} signal={signal} ac={meta.analysis.kind === 'ac'} />}
    </div>
  )
}

/** On a placed component's sheet: what it is, read-only, and how to edit a copy. */
function ComponentBanner() {
  const sheet = useProject((s) => currentSheet(s))
  const project = useProject((s) => s.project)
  if (!sheet?.owner || !project) return null
  const top = project.sheets.find((s) => s.owner === sheet.owner && s.component)
  const info = top?.component
  return (
    <div className="absolute top-12 left-2 z-[5] flex max-w-[70%] items-center gap-2 rounded-md border bg-background/90 px-2 py-1 text-xs shadow-sm backdrop-blur">
      <span>
        Library part <span className="font-medium">{info?.name ?? sheet.owner}</span>
        {info && (
          <span className="text-muted-foreground">
            {' '}
            · {info.kind} · v{info.version}
          </span>
        )}{' '}
        – read-only
      </span>
      <button
        type="button"
        className="rounded border px-2 py-0.5 hover:bg-accent"
        title="Make the part's sheets ordinary sheets of this project, so they can be edited"
        onClick={() => {
          const owner = sheet.owner
          if (owner) void useProject.getState().execute({ type: 'detach_component', owner })
        }}
      >
        Make a copy
      </button>
    </div>
  )
}

/** Shown on an empty sheet: how to start. */
function EmptyHint() {
  const empty = useProject((s) => {
    const sheet = currentSheet(s)
    return sheet !== null && sheet.instances.length + sheet.wires.length + sheet.labels.length === 0
  })
  const selecting = useEditor((s) => s.tool.kind === 'select')
  if (!empty || !selecting) return null
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 z-[5] flex justify-center">
      {/* Only the buttons take the pointer: parts dropped or clicked onto the card still land. */}
      <div className="max-w-sm rounded-lg border bg-background/90 p-4 text-center text-sm shadow-sm backdrop-blur [&_button]:pointer-events-auto">
        <p className="mb-2 font-medium">Empty schematic</p>
        <p className="text-muted-foreground">
          Press <kbd className="rounded border px-1 font-mono text-xs">A</kbd> to add a symbol,{' '}
          <kbd className="rounded border px-1 font-mono text-xs">W</kbd> to draw a wire, drag parts from the
          library, or type a SPICE line in the console.
        </p>
        <button
          type="button"
          className="mt-3 rounded-md border px-3 py-1 text-xs hover:bg-accent"
          onClick={() => useProject.getState().importNetlist(EXAMPLE)}
        >
          Insert an example RC filter
        </button>
        <button
          type="button"
          className="mt-3 ml-2 rounded-md border px-3 py-1 text-xs hover:bg-accent"
          onClick={() => useDialogs.getState().setExamples(true)}
        >
          Open an example project…
        </button>
        <button
          type="button"
          className="mt-3 ml-2 rounded-md border px-3 py-1 text-xs hover:bg-accent"
          onClick={() => useDialogs.getState().setGuide(true)}
        >
          First time? Getting started (F1)
        </button>
      </div>
    </div>
  )
}

export function SchematicView() {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = host.current
    if (!element) return
    const renderer = new SchematicRenderer()
    const index = new HitIndex()
    let controller: EditorController | null = null
    let disposed = false
    const unsubscribers: (() => void)[] = []
    let fitted = false
    let lastCount = 0

    const palette = () => canvasPalette[useTheme.getState().theme]

    const drawScene = () => {
      const { project, symbols, issues } = useProject.getState()
      const sheet = currentSheet(useProject.getState())
      if (!project || !sheet || !renderer.ready) return
      index.build(sheet, symbols)
      const { selection, move, wireEdit, textDrag } = useEditor.getState()
      let shown: Sheet = move ? previewSheet(sheet, selection, move.delta, move.stretchWires, symbols) : sheet
      if (textDrag) {
        shown = {
          ...shown,
          instances: shown.instances.map((i) =>
            i.id === textDrag.id ? { ...i, texts: { ...i.texts, [textDrag.field]: textDrag.place } } : i,
          ),
        }
      }
      if (wireEdit) {
        shown = {
          ...shown,
          wires: shown.wires.map((w) =>
            w.id === wireEdit.wireId ? { ...w, points: editWire(w.points, wireEdit) } : w,
          ),
        }
      }
      // Unconnected pins get a small ring at the pin; a frame around the whole part (for every
      // part just placed) would make the schematic look broken while it is being drawn.
      const nets = useSimulation.getState().nets
      const openPins = nets ? unconnectedPins(shown, symbols, nets) : []
      const errorRefs = new Set(
        issues
          .filter((i) => i.severity === 'error' && (i.code !== 'unconnected-pin' || !nets))
          .flatMap((i) => i.refs),
      )
      // Stress analysis: the worst status of each part (over beats margin).
      const stressRefs = new Map<string, 'over' | 'margin'>()
      for (const item of useSimulation.getState().stress?.items ?? [])
        if (item.status === 'over' || (item.status === 'margin' && !stressRefs.has(item.ref)))
          stressRefs.set(item.ref, item.status)
      const { sheetName, viewPath } = useProject.getState()
      renderer.drawScene({
        sheet: shown,
        scope: sheetScope(project, sheetName, viewPath),
        symbols,
        selection,
        errorRefs,
        stressRefs,
        openPins,
        palette: palette(),
        realism: useSettings.getState().realism,
        hover: useEditor.getState().hover,
      })
      // Fit when a document is first shown with content, and when an empty sheet gets its first
      // parts at once (example, pasted netlist); never while the user is placing parts one by one.
      const count = sheet.instances.length + sheet.wires.length
      if (controller && !fitted) {
        fitted = true
        if (count > 0) controller.fit()
      } else if (controller && lastCount === 0 && count > 2) controller.fit()
      lastCount = count
    }

    const drawAnnotations = () => {
      if (!renderer.ready) return
      const { showOp, opValues, nets, probeValues } = useSimulation.getState()
      const sheet = currentSheet(useProject.getState())
      const items =
        showOp && opValues && nets && sheet
          ? opAnnotations(
              sheet,
              useProject.getState().symbols,
              nets,
              opValues,
              useSettings.getState().realism,
              {
                voltages: useSettings.getState().opVoltages,
                currents: useSettings.getState().opCurrents,
                power: useSettings.getState().opPower,
              },
            )
          : []
      // Probes show their value whatever the OP overlay does: that is what they are for.
      for (const inst of sheet?.instances ?? []) {
        const value = probeValues[inst.ref]
        const symbol = useProject.getState().symbols.get(inst.symbol)
        if (!value || !symbol?.ref_at || !inst.symbol.startsWith('bpt:probe_')) continue
        // Right after the probe's name: "VP1 = 2.5 V".
        const [x, y] = transform(symbol.ref_at, inst)
        items.push({ at: [x + inst.ref.length * TEXT_WIDTH + 80, y], text: `= ${value}` })
      }
      renderer.drawAnnotations(items, palette())
    }

    const drawHighlights = () => {
      if (!renderer.ready) return
      const { hover, highlightNet, selection, flash } = useEditor.getState()
      const sheet = currentSheet(useProject.getState())
      const nets = useSimulation.getState().nets
      const hoverBox = hover && !selection.has(hover) ? index.boxOf(hover) : null
      let net: { wires: Point[][]; pins: Point[] } | null = null
      if (highlightNet && sheet && nets) {
        const symbols = useProject.getState().symbols
        const pins: Point[] = []
        for (const inst of sheet.instances) {
          const symbol = symbols.get(inst.symbol)
          if (!symbol) continue
          for (const pin of pinPositions(symbol, inst)) {
            if (nets.pins[`${inst.id}:${pin.number}`] === highlightNet) pins.push(pin.at)
          }
        }
        net = {
          wires: sheet.wires.filter((w) => nets.wires[w.id] === highlightNet).map((w) => w.points),
          pins,
        }
      }
      const flashBoxes = [...flash].map((id) => index.boxOf(id)).filter((box) => box !== null)
      renderer.drawHighlights(hoverBox, net, palette(), flashBoxes)
    }

    const drawOverlay = () => {
      if (!renderer.ready) return
      const { tool, cursor, boxSelect, pointerInside, move } = useEditor.getState()
      const symbols = useProject.getState().symbols
      let wire: Point[] | null = null
      if (tool.kind === 'wire' && tool.points.length > 0) {
        const last = tool.points[tool.points.length - 1]
        const mode = useSettings.getState().wireMode
        wire = [...tool.points, ...route(last, cursor, mode, tool.horizontalFirst).slice(1)]
      }
      const symbol = tool.kind === 'place' ? symbols.get(tool.symbolId) : undefined
      const sheet = currentSheet(useProject.getState())
      // Labels and junctions go onto a nearby wire; the preview shows exactly where.
      const onWire = labelPoint(cursor, sheet?.wires ?? [], useEditor.getState().view.scale)
      const shown = pointerInside // previews at a stale position would mislead
      renderer.drawOverlay({
        ghost:
          shown && symbol && tool.kind === 'place'
            ? { symbol, at: cursor, rot: tool.rot, mirror: tool.mirror }
            : null,
        wire,
        bus: tool.kind === 'wire' && tool.bus,
        label: shown && tool.kind === 'label' ? { text: tool.text, at: onWire, kind: tool.labelKind } : null,
        junction: shown && tool.kind === 'junction' ? onWire : null,
        directive: shown && tool.kind === 'directive' ? { text: tool.text, at: cursor } : null,
        box: boxSelect,
        // One cursor only: drawing tools hide the system pointer and show the snapped cross.
        cursor: pointerInside && (tool.kind !== 'select' || move?.fromKeyboard) ? cursor : null,
        fullCrosshair: useSettings.getState().crosshair === 'full',
        attach: (() => {
          const at = tool.kind === 'label' || tool.kind === 'junction' ? onWire : cursor
          return (
            (tool.kind === 'wire' || tool.kind === 'label' || tool.kind === 'junction') &&
            pointerInside &&
            sheet !== null &&
            isConnectionPoint(sheet, symbols, at)
          )
        })(),
        palette: palette(),
      })
    }

    void renderer.init(element).then(() => {
      if (disposed) {
        renderer.destroy()
        return
      }
      renderer.setTheme(palette())
      renderer.setShowGrid(useSettings.getState().showGrid)
      const rect = element.getBoundingClientRect()
      const view = useEditor.getState().view
      if (view.x === 400 && view.y === 300)
        useEditor.getState().setView({ ...view, x: rect.width / 2, y: rect.height / 2 })
      renderer.setView(useEditor.getState().view)
      controller = new EditorController(renderer.canvas, index)
      window.__bpt = {
        snapshot: () => renderer.snapshot(),
        fit: () => controller?.fit(),
        toScreen: ([x, y]) => {
          const { scale, x: ox, y: oy } = useEditor.getState().view
          const rect = renderer.canvas.getBoundingClientRect()
          return [rect.left + x * scale + ox, rect.top + y * scale + oy]
        },
        capture: (target, maxPx) => captureSheet(renderer, target, maxPx),
      }
      drawScene()
      drawOverlay()
      drawAnnotations()
      unsubscribers.push(
        useEditor.subscribe((state, prev) => {
          if (state.view !== prev.view) renderer.setView(state.view)
          if (
            state.selection !== prev.selection ||
            state.move !== prev.move ||
            state.wireEdit !== prev.wireEdit ||
            state.textDrag !== prev.textDrag
          )
            drawScene()
          if (
            state.tool !== prev.tool ||
            state.cursor !== prev.cursor ||
            state.boxSelect !== prev.boxSelect ||
            state.pointerInside !== prev.pointerInside ||
            state.move !== prev.move ||
            state.view !== prev.view
          )
            drawOverlay()
        }),
        useProject.subscribe((state, prev) => {
          if (state.sheetName !== prev.sheetName) fitted = false // another sheet: show all of it
          if (
            state.project !== prev.project ||
            state.issues !== prev.issues ||
            state.sheetName !== prev.sheetName ||
            state.symbols !== prev.symbols // block symbols arrive after the document
          )
            drawScene()
        }),
        useSettings.subscribe((state, prev) => {
          if (state.showGrid !== prev.showGrid) renderer.setShowGrid(state.showGrid)
          if (state.crosshair !== prev.crosshair) drawOverlay()
          if (state.realism !== prev.realism || state.symbolStandard !== prev.symbolStandard) drawScene()
          if (
            state.opVoltages !== prev.opVoltages ||
            state.opCurrents !== prev.opCurrents ||
            state.opPower !== prev.opPower
          )
            drawAnnotations()
        }),
        useTheme.subscribe(() => {
          renderer.setTheme(palette())
          drawScene()
          drawOverlay()
          drawAnnotations()
        }),
        useEditor.subscribe((state, prev) => {
          if (
            state.hover !== prev.hover ||
            state.highlightNet !== prev.highlightNet ||
            state.selection !== prev.selection ||
            state.flash !== prev.flash
          )
            drawHighlights()
          // Tags shown on hover: redraw when the hovered part changes (not on every move).
          if (state.hover !== prev.hover && useSettings.getState().realism === 'hover') drawScene()
        }),
        useProject.subscribe((state, prev) => {
          if (state.project !== prev.project) drawHighlights()
        }),
        useSimulation.subscribe((state, prev) => {
          if (state.nets !== prev.nets) {
            drawHighlights()
            drawScene()
          } else if (state.stress !== prev.stress) drawScene()
        }),
        useSimulation.subscribe((state, prev) => {
          if (
            state.showOp !== prev.showOp ||
            state.opValues !== prev.opValues ||
            state.nets !== prev.nets ||
            state.probeValues !== prev.probeValues
          )
            drawAnnotations()
        }),
        useEditor.subscribe((state, prev) => {
          // One cursor: the system pointer is hidden only while the cross is drawn in its place.
          const style = (s: typeof state) =>
            s.tool.kind === 'select' && !s.move?.fromKeyboard
              ? 'default'
              : s.pointerInside
                ? 'none'
                : 'crosshair'
          if (style(state) !== style(prev)) renderer.canvas.style.cursor = style(state)
        }),
      )
    })

    return () => {
      disposed = true
      for (const unsubscribe of unsubscribers) unsubscribe()
      controller?.dispose()
      if (window.__bpt) delete window.__bpt
      renderer.destroy()
    }
  }, [])

  return (
    <div className="relative h-full w-full overflow-hidden">
      <DrawingToolbar />
      <EmptyHint />
      <SheetTabs />
      <ComponentBanner />
      <CursorTip />
      <ContextMenu />
      <div
        ref={host}
        className="absolute inset-0 overflow-hidden outline-none"
        data-testid="schematic"
        role="application"
        aria-label="Schematic editor"
        onDragOver={(e) => {
          const types = e.dataTransfer.types
          if (types.includes('application/x-bpt-symbol') || types.includes('application/x-bpt-param'))
            e.preventDefault()
        }}
        onDrop={(e) => {
          const param = e.dataTransfer.getData('application/x-bpt-param')
          if (param) {
            e.preventDefault()
            void activeEditor?.dropParameter(param, e.clientX, e.clientY)
            return
          }
          const symbolId = e.dataTransfer.getData('application/x-bpt-symbol')
          if (!symbolId) return
          e.preventDefault()
          void activeEditor?.dropSymbol(symbolId, e.clientX, e.clientY)
        }}
      />
    </div>
  )
}
