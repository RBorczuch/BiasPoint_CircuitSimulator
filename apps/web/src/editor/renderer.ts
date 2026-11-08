/**
 * PixiJS renderer of one schematic sheet.
 *
 * Layers: grid (screen space, redrawn on view change), scene (document, in world space,
 * redrawn on document / selection / preview change) and overlay (ghost, wire preview,
 * selection box, cursor; redrawn on pointer moves). Texts are BitmapText in world space,
 * so panning and zooming only change one container transform.
 */
import {
  Application,
  BitmapText,
  Container,
  CullerPlugin,
  extensions,
  Graphics,
  GraphicsContext,
  Rectangle,
} from 'pixi.js'

// Skip drawing symbols and texts outside the view (large sheets zoomed in).
extensions.add(CullerPlugin)

import type { Graphic, Instance, Label, Point, Sheet, SymbolDef } from '@/api/types'
import { braced, evaluate, type Scope } from '@/lib/expr'
import { drawn, lookName } from '@/lib/looks'
import { partTag } from '@/lib/partTag'
import type { CanvasPalette } from '@/lib/theme'
import { formatValue } from '@/lib/units'
import {
  type Box,
  GRID,
  instanceBox,
  junctionDots,
  labelFrame,
  textSpot,
  transform,
  valueText,
} from './geometry'

const LINE = 16 // world units (0.16 mm)
const WIRE = 18
const DOT_RADIUS = 32
const TEXT_SIZE = 110
const FONT = 'Inter, ui-sans-serif, system-ui, sans-serif'
const MONO = 'JetBrains Mono, ui-monospace, monospace'

export interface Scene {
  sheet: Sheet
  symbols: Map<string, SymbolDef>
  selection: Set<string>
  errorRefs: Set<string>
  stressRefs?: Map<string, 'over' | 'margin'> // ratings exceeded / without margin
  palette: CanvasPalette
  realism?: 'always' | 'hover' | 'off' // when the ideal / real / part-name tags show
  hover?: string | null // the object under the pointer (tags in 'hover' mode)
  openPins?: Point[] // unconnected pin ends (ERC), drawn as small rings
  scope?: Scope // parameters the sheet sees: expression values are shown computed too
}

/** Text drawn over the schematic (operating point values); `align` = which side `at` is on. */
export interface Annotation {
  at: Point
  text: string
  align?: 'left' | 'right'
}

/** Approximate width of one character of schematic text (world units). */
export const TEXT_WIDTH = 110 * 0.62

export interface Overlay {
  ghost: { symbol: SymbolDef; at: Point; rot: 0 | 90 | 180 | 270; mirror: boolean } | null
  wire: Point[] | null
  bus?: boolean // the wire being drawn is a bus
  label: { text: string; at: Point; kind: 'local' | 'global' | 'port' } | null
  junction?: Point | null
  directive?: { text: string; at: Point } | null
  box: { from: Point; to: Point } | null
  cursor: Point | null
  attach: boolean // the cursor is on a pin or wire: a wire would connect here
  fullCrosshair?: boolean
  palette: CanvasPalette
}

export interface ViewTransform {
  scale: number
  x: number
  y: number
}

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const

function arcThroughPoints(g: GraphicsContext, start: Point, mid: Point, end: Point): void {
  const [ax, ay] = start
  const [bx, by] = mid
  const [cx, cy] = end
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) {
    g.moveTo(ax, ay).lineTo(cx, cy)
    return
  }
  const ux =
    ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const a0 = Math.atan2(ay - uy, ax - ux)
  const a1 = Math.atan2(cy - uy, cx - ux)
  const am = Math.atan2(by - uy, bx - ux)
  const norm = (a: number) => (a + 4 * Math.PI) % (2 * Math.PI)
  const clockwiseHasMid = norm(am - a0) < norm(a1 - a0)
  g.moveTo(ax, ay).arc(ux, uy, r, a0, a1, !clockwiseHasMid)
}

function drawGraphic(g: GraphicsContext, item: Graphic, color: number): void {
  const stroke = { width: LINE, color, cap: 'round', join: 'round' } as const
  switch (item.kind) {
    case 'polyline': {
      if (item.fill) {
        g.poly(item.points.flat()).fill(color)
      } else {
        g.moveTo(...item.points[0])
        for (const p of item.points.slice(1)) g.lineTo(...p)
        g.stroke(stroke)
      }
      break
    }
    case 'rect': {
      const [x0, y0] = item.start
      const [x1, y1] = item.end
      g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      if (item.fill) g.fill(color)
      else g.stroke(stroke)
      break
    }
    case 'circle':
      g.circle(item.center[0], item.center[1], item.radius)
      if (item.fill) g.fill(color)
      else g.stroke(stroke)
      break
    case 'arc':
      arcThroughPoints(g, item.start, item.mid, item.end)
      g.stroke(stroke)
      break
    case 'text':
      break // drawn as upright text by the scene
  }
}

export class SchematicRenderer {
  private app = new Application()
  private grid = new Graphics()
  private world = new Container()
  private scene = new Container()
  private overlay = new Container()
  private annotations = new Container()
  private highlights = new Graphics()
  private contexts = new Map<string, GraphicsContext>()
  private textPool = new Map<string, BitmapText[]>()
  private view: ViewTransform = { scale: 0.1, x: 0, y: 0 }
  private gridColors: [number, number] = [0, 0]
  private background = 0x000000
  ready = false

  private resizeObserver: ResizeObserver | null = null

  async init(parent: HTMLElement): Promise<void> {
    const { width, height } = parent.getBoundingClientRect()
    await this.app.init({
      width: Math.max(1, Math.floor(width)),
      height: Math.max(1, Math.floor(height)),
      antialias: true,
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      background: this.background,
      preference: 'webgl',
      // Drawn on demand (requestRender) instead of 60 times a second: an idle editor costs
      // nothing, a big sheet is drawn once per change.
      autoStart: false,
      preserveDrawingBuffer: true, // window screenshots (html-to-image) read the canvas
      // The editor handles the mouse itself; Pixi's hit testing of every object per pointer
      // or wheel event only cost frames on big sheets.
      eventFeatures: { move: false, globalMove: false, click: false, wheel: false },
    })
    this.app.stage.eventMode = 'none'
    this.app.stage.interactiveChildren = false
    // Absolutely positioned: the canvas never affects the panel's own size.
    Object.assign(this.app.canvas.style, { position: 'absolute', inset: '0', display: 'block' })
    parent.appendChild(this.app.canvas)
    this.world.addChild(this.highlights, this.scene, this.annotations, this.overlay)
    this.app.stage.addChild(this.grid, this.world)
    // Follow the panel (dockview splits, workspace changes), not only the window.
    this.resizeObserver = new ResizeObserver(([entry]) => {
      const w = Math.max(1, Math.floor(entry.contentRect.width))
      const h = Math.max(1, Math.floor(entry.contentRect.height))
      if (w === this.app.screen.width && h === this.app.screen.height) return
      this.app.renderer.resize(w, h)
      this.drawGrid()
      this.app.render()
    })
    this.resizeObserver.observe(parent)
    // Texts drawn before a web font arrived are redrawn with it.
    document.fonts?.addEventListener('loadingdone', this.onFonts)
    this.ready = true
  }

  private frame = 0

  /** Draw at the next animation frame (several changes in one frame draw once). */
  private requestRender(): void {
    if (!this.ready || this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      if (this.ready) this.app.render()
    })
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas
  }

  private onFonts = (): void => this.requestRender()

  destroy(): void {
    if (this.frame) cancelAnimationFrame(this.frame)
    document.fonts?.removeEventListener('loadingdone', this.onFonts)
    this.resizeObserver?.disconnect()
    if (this.ready) this.app.destroy(true, { children: true })
    for (const context of this.contexts.values()) context.destroy()
    this.contexts.clear()
  }

  /** Render the canvas now and return it as a PNG data URL (screenshots for agents). */
  async snapshot(): Promise<string> {
    this.app.render()
    return this.app.canvas.toDataURL('image/png')
  }

  /**
   * Render a region of the scene off-screen (no grid, cursor or overlays) at most `maxPx`
   * pixels wide or high; the user's view is not touched. Returns a PNG data URL.
   */
  captureRegion(box: Box, maxPx: number): string {
    const width = box.maxX - box.minX
    const height = box.maxY - box.minY
    const resolution = Math.min(maxPx / Math.max(width, height), 1)
    const canvas = this.app.renderer.extract.canvas({
      target: this.scene,
      frame: new Rectangle(box.minX, box.minY, width, height),
      resolution,
      clearColor: this.background,
      antialias: true,
    }) as HTMLCanvasElement
    return canvas.toDataURL('image/png')
  }

  setView(view: ViewTransform): void {
    this.view = view
    this.world.position.set(view.x, view.y)
    this.world.scale.set(view.scale)
    this.drawGrid()
    this.requestRender()
  }

  setTheme(palette: CanvasPalette): void {
    this.background = palette.background
    this.app.renderer.background.color = palette.background
    this.gridColors = [palette.gridDot, palette.gridDotMajor]
    for (const context of this.contexts.values()) context.destroy()
    this.contexts.clear()
    this.drawGrid()
    this.requestRender()
  }

  showGrid = true

  setShowGrid(show: boolean): void {
    this.showGrid = show
    this.drawGrid()
    this.requestRender()
  }

  private drawGrid(): void {
    if (!this.ready) return
    const g = this.grid.clear()
    if (!this.showGrid) return
    const { scale, x, y } = this.view
    // CSS pixels: renderer.width already is (divided by the resolution, the grid covered only a
    // part of the sheet on a scaled display).
    const { width, height } = this.app.screen
    let step = GRID
    while (step * scale < 8) step *= 5
    const size = Math.max(1, Math.min(2, step * scale * 0.08))
    const startX = Math.floor(-x / scale / step) * step
    const startY = Math.floor(-y / scale / step) * step
    // One path per colour, filled once: a fill per dot made zooming slow (thousands of draw calls).
    for (const wantMajor of [false, true]) {
      for (let wx = startX; wx * scale + x < width; wx += step) {
        for (let wy = startY; wy * scale + y < height; wy += step) {
          const major = wx % (step * 10) === 0 && wy % (step * 10) === 0
          if (major === wantMajor) g.rect(wx * scale + x - size / 2, wy * scale + y - size / 2, size, size)
        }
      }
      g.fill(wantMajor ? this.gridColors[1] : this.gridColors[0])
    }
  }

  private symbolContext(symbol: SymbolDef, color: number): GraphicsContext {
    const key = `${symbol.id}|${lookName(symbol)}|${color}`
    let context = this.contexts.get(key)
    if (!context) {
      context = new GraphicsContext()
      for (const pin of symbol.pins) {
        if (pin.length <= 0) continue
        const [dx, dy] = DIRS[pin.orientation]
        const [px, py] = pin.at
        context
          .moveTo(px, py)
          .lineTo(px - dx * pin.length, py - dy * pin.length)
          .stroke({ width: LINE, color, cap: 'round' })
      }
      for (const item of symbol.graphics) drawGraphic(context, item, color)
      this.contexts.set(key, context)
    }
    return context
  }

  private text(
    content: string,
    at: Point,
    color: number,
    options: { size?: number; anchor?: [number, number]; mono?: boolean } = {},
  ): BitmapText {
    // Reuse a text of the same content and style from the previous scene: laying out text is
    // the most expensive part of a redraw (measuring glyphs), positions and colours are cheap.
    const key = `${options.mono ? 'm' : 's'}|${options.size ?? TEXT_SIZE}|${content}`
    const text =
      this.textPool.get(key)?.pop() ??
      new BitmapText({
        text: content,
        style: {
          fontFamily: options.mono ? MONO : FONT,
          fontSize: options.size ?? TEXT_SIZE,
          fill: 0xffffff,
        },
      })
    text.label = key
    text.rotation = 0
    text.cullable = true
    text.tint = color
    text.anchor.set(...(options.anchor ?? [0, 0.5]))
    text.position.set(at[0], at[1])
    return text
  }

  private placeSymbol(
    parent: Container,
    symbol: SymbolDef,
    inst: Pick<Instance, 'at' | 'rot' | 'mirror'>,
    color: number,
  ): void {
    const gfx = new Graphics(this.symbolContext(symbol, color))
    gfx.cullable = true
    gfx.position.set(inst.at[0], inst.at[1])
    gfx.rotation = (inst.rot * Math.PI) / 180
    gfx.scale.x = inst.mirror ? -1 : 1
    parent.addChild(gfx)
  }

  private symbolTexts(
    parent: Container,
    symbol: SymbolDef,
    inst: Instance,
    palette: CanvasPalette,
    color: number,
    scope: Scope,
  ) {
    const params = { ...symbol.default_params, ...inst.model.params }
    for (const item of symbol.graphics) {
      if (item.kind !== 'text') continue
      const content = item.text.replace('{net}', params.net ?? '').replace('{ref}', inst.ref)
      parent.addChild(
        this.text(content, transform(item.at, inst), color, { size: item.size, anchor: [0.5, 0.5] }),
      )
    }
    const ref = textSpot(symbol, inst, 'ref')
    if (ref) {
      const text = this.text(inst.ref, ref.at, palette.ref, { anchor: ref.anchor })
      text.rotation = ref.rotation
      parent.addChild(text)
    }
    let value = valueText(symbol, inst)
    const inner = braced(value)
    const computed = inner === null ? null : evaluate(inner, scope)
    if (computed !== null) value = `${value} = ${formatValue(computed, '', 3).replace(' ', '')}` // {1k*(vout/1.23-1)} = 3.07k
    const spot = textSpot(symbol, inst, 'value')
    if (spot && value) {
      const text = this.text(value, spot.at, palette.text, { anchor: spot.anchor, mono: true })
      text.rotation = spot.rotation
      parent.addChild(text)
    }
  }

  /** Third line under the value: which parasitics a part has ("≈ ESR, ESL") or "ideal". */
  private realismText(
    parent: Container,
    symbol: SymbolDef,
    inst: Instance,
    palette: CanvasPalette,
    shown: boolean,
  ): void {
    const spot = textSpot(symbol, inst, 'value') ?? textSpot(symbol, inst, 'ref')
    const tag = shown && spot ? partTag(symbol, inst) : null
    if (!tag || !spot) return
    // Under the value: one line further from it, whichever way the value reads.
    const [x, y] = spot.at
    const at: Point = spot.rotation ? [x + TEXT_SIZE * 1.1, y] : [x, y + TEXT_SIZE * 1.1]
    const text = this.text(tag.text, at, tag.real ? palette.parasitic : palette.text, {
      anchor: spot.anchor,
      size: TEXT_SIZE * 0.7, // clearly smaller than the value and the reference
    })
    text.rotation = spot.rotation
    parent.addChild(text)
  }

  private label(parent: Container, g: Graphics, label: Label, color: number): void {
    // Drawn in the label's own frame (pointing right) and mapped by its rotation.
    const { map, flip, textRotation } = labelFrame(label)
    const flat = (points: Point[]) => points.flatMap(map)
    const place = (at: Point, anchor: [number, number]) => {
      const text = this.text(label.text, map(at), color, {
        anchor: [flip ? 1 - anchor[0] : anchor[0], anchor[1]],
        mono: true,
      })
      text.rotation = textRotation
      parent.addChild(text)
    }
    const w = label.text.length * TEXT_SIZE * 0.62 + 90
    if (label.kind === 'port') {
      // Hierarchical port: a flag pointing into the sheet, text inside (a pin of the block).
      const h = 70
      const outline: Point[] = [
        [0, 0],
        [50, -h],
        [w, -h],
        [w + 50, 0],
        [w, h],
        [50, h],
      ]
      g.poly(flat(outline)).stroke({ width: LINE * 1.2, color })
      place([70, 0], [0, 0.5])
    } else if (label.kind === 'global') {
      const h = 80
      const outline: Point[] = [
        [0, 0],
        [60, -h],
        [w, -h],
        [w, h],
        [60, h],
      ]
      g.poly(flat(outline)).stroke({ width: LINE, color })
      place([80, 0], [0, 0.5])
    } else {
      g.rect(label.at[0] - 20, label.at[1] - 20, 40, 40).fill(color)
      place([25, -40], [0, 1])
    }
  }

  drawScene({
    sheet,
    symbols,
    selection,
    errorRefs,
    stressRefs,
    palette,
    realism,
    hover,
    openPins = [],
    scope = {},
  }: Scene): void {
    this.requestRender() // drawn at the next frame, after this method
    // Texts of the previous scene go back to the pool; everything else is rebuilt.
    for (const pooled of this.textPool.values()) for (const t of pooled) t.destroy()
    this.textPool.clear()
    for (const child of this.scene.removeChildren()) {
      if (child.label === 'texts') {
        for (const t of child.removeChildren()) {
          const list = this.textPool.get(t.label)
          if (list) list.push(t as BitmapText)
          else this.textPool.set(t.label, [t as BitmapText])
        }
      }
      child.destroy()
    }
    const wires = new Graphics()
    const buses = new Graphics()
    const selectedWires = new Graphics()
    const marks = new Graphics()
    const texts = new Container({ label: 'texts' })
    this.scene.addChild(buses, wires, selectedWires, marks)

    for (const wire of sheet.wires) {
      const g = selection.has(wire.id) ? selectedWires : wire.bus ? buses : wires
      g.moveTo(...wire.points[0])
      for (const p of wire.points.slice(1)) g.lineTo(...p)
    }
    wires.stroke({ width: WIRE, color: palette.wire, cap: 'round', join: 'round' })
    buses.stroke({ width: WIRE * 3, color: palette.bus, cap: 'round', join: 'round' })
    selectedWires.stroke({ width: WIRE * 1.6, color: palette.selection, cap: 'round', join: 'round' })
    for (const [x, y] of junctionDots(sheet, symbols)) marks.circle(x, y, DOT_RADIUS).fill(palette.junction)
    for (const [x, y] of openPins) marks.circle(x, y, 32).stroke({ width: LINE, color: palette.error })

    for (const inst of sheet.instances) {
      const own = symbols.get(inst.symbol)
      const symbol = own && drawn(own, inst.look, inst.model.params.tran)
      if (!symbol) {
        marks.rect(inst.at[0] - 127, inst.at[1] - 127, 254, 254).stroke({ width: LINE, color: palette.error })
        continue
      }
      const selected = selection.has(inst.id)
      const base = symbol.power_net !== null ? palette.power : palette.symbol
      this.placeSymbol(this.scene, symbol, inst, selected ? palette.selection : base)
      this.symbolTexts(texts, symbol, inst, palette, selected ? palette.selection : palette.text, scope)
      const tagged =
        realism === 'always' || (realism === 'hover' && (hover === inst.id || selection.has(inst.id)))
      this.realismText(texts, symbol, inst, palette, tagged)
      const stressed = stressRefs?.get(inst.ref)
      if (errorRefs.has(inst.ref) || stressed) {
        const box = instanceBox(symbol, inst, 60)
        const color = errorRefs.has(inst.ref) || stressed === 'over' ? palette.error : palette.stress
        marks
          .roundRect(box.minX, box.minY, box.maxX - box.minX, box.maxY - box.minY, 60)
          .stroke({ width: LINE * 1.5, color, alpha: 0.9 })
      }
    }

    for (const label of sheet.labels) {
      this.label(texts, marks, label, selection.has(label.id) ? palette.selection : palette.label)
    }
    for (const directive of sheet.directives) {
      const color = selection.has(directive.id) ? palette.selection : palette.directive
      directive.text.split('\n').forEach((line, i) => {
        texts.addChild(
          this.text(line, [directive.at[0], directive.at[1] + i * TEXT_SIZE * 1.3], color, { mono: true }),
        )
      })
    }
    this.scene.addChild(texts)
  }

  /**
   * Hover and net highlight, drawn under the scene so it is cheap to update on every
   * pointer move: a soft box behind the hovered object, a glow along the highlighted net.
   */
  drawHighlights(
    hover: Box | null,
    net: { wires: Point[][]; pins: Point[] } | null,
    palette: CanvasPalette,
    flash: Box[] = [],
  ): void {
    this.requestRender() // drawn at the next frame, after this method
    const g = this.highlights.clear()
    for (const box of flash) {
      g.roundRect(box.minX - 40, box.minY - 40, box.maxX - box.minX + 80, box.maxY - box.minY + 80, 60)
        .fill({ color: palette.annotation, alpha: 0.18 })
        .stroke({ width: LINE, color: palette.annotation, alpha: 0.8 })
    }
    if (hover) {
      g.roundRect(hover.minX, hover.minY, hover.maxX - hover.minX, hover.maxY - hover.minY, 40).fill({
        color: palette.selection,
        alpha: 0.1,
      })
    }
    if (net) {
      for (const points of net.wires) {
        g.moveTo(...points[0])
        for (const p of points.slice(1)) g.lineTo(...p)
      }
      g.stroke({ width: WIRE * 5, color: palette.highlight, alpha: 0.35, cap: 'round', join: 'round' })
      for (const [x, y] of net.pins) g.circle(x, y, 55).fill({ color: palette.highlight, alpha: 0.6 })
    }
  }

  /** Simulation values on the schematic (operating point): small texts with a backdrop. */
  drawAnnotations(items: Annotation[], palette: CanvasPalette): void {
    this.requestRender() // drawn at the next frame, after this method
    for (const child of this.annotations.removeChildren()) child.destroy()
    const backdrop = new Graphics()
    this.annotations.addChild(backdrop)
    for (const item of items) {
      const right = item.align === 'right'
      const text = this.text(item.text, item.at, palette.annotation, {
        size: 95,
        anchor: [right ? 1 : 0, 0.5],
        mono: true,
      })
      const w = item.text.length * 95 * 0.6 + 40
      const x = right ? item.at[0] - w + 20 : item.at[0] - 20
      backdrop.roundRect(x, item.at[1] - 65, w, 130, 30).fill({ color: palette.background, alpha: 0.85 })
      this.annotations.addChild(text)
    }
  }

  drawOverlay({
    ghost,
    wire,
    bus,
    label,
    junction,
    directive,
    box,
    cursor,
    attach,
    fullCrosshair,
    palette,
  }: Overlay): void {
    this.requestRender() // drawn at the next frame, after this method
    for (const child of this.overlay.removeChildren()) child.destroy()
    const g = new Graphics()
    this.overlay.addChild(g)
    if (ghost) this.placeSymbol(this.overlay, drawn(ghost.symbol), ghost, palette.ghost)
    if (wire && wire.length > 1) {
      g.moveTo(...wire[0])
      for (const p of wire.slice(1)) g.lineTo(...p)
      g.stroke({
        width: bus ? WIRE * 3 : WIRE,
        color: bus ? palette.bus : palette.wire,
        alpha: 0.6,
        cap: 'round',
        join: 'round',
      })
    }
    if (label) {
      const ghostLabel = { id: '', rot: 0 as const, ...label, text: label.text || 'label' }
      this.label(this.overlay, g, ghostLabel, palette.ghost)
    }
    if (junction) g.circle(junction[0], junction[1], DOT_RADIUS).fill({ color: palette.wire, alpha: 0.7 })
    if (directive) {
      directive.text.split('\n').forEach((line, i) => {
        const at: Point = [directive.at[0], directive.at[1] + i * TEXT_SIZE * 1.3]
        this.overlay.addChild(this.text(line, at, palette.ghost, { mono: true }))
      })
    }
    if (box) {
      const [x0, y0] = box.from
      const [x1, y1] = box.to
      g.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
        .fill({ color: palette.selection, alpha: 0.08 })
        .stroke({ width: 1 / this.view.scale, color: palette.selection, alpha: 0.8 })
    }
    if (cursor) {
      // Full crosshair: arms reach the canvas edges (KiCad / AutoCAD style).
      const arm = fullCrosshair
        ? Math.max(this.app.screen.width, this.app.screen.height) / this.view.scale
        : 9 / this.view.scale
      g.moveTo(cursor[0] - arm, cursor[1])
        .lineTo(cursor[0] + arm, cursor[1])
        .moveTo(cursor[0], cursor[1] - arm)
        .lineTo(cursor[0], cursor[1] + arm)
        .stroke({ width: 1 / this.view.scale, color: palette.ghost })
      if (attach) {
        g.circle(cursor[0], cursor[1], 7 / this.view.scale).stroke({
          width: 2 / this.view.scale,
          color: palette.wire,
        })
      }
    }
  }
}
