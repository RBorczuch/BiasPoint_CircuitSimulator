/**
 * Schematic geometry. Units: 10 µm, y down, grid 127 (1.27 mm).
 * `transform` must match the backend (bpt/netlist/connectivity.py): mirror around Y, then
 * rotate clockwise on screen by `rot`, then translate.
 */

import type { Instance, Label, Point, Project, Sheet, SymbolDef, TextField, TextPlace } from '@/api/types'
import { drawn } from '@/lib/looks'
import { shortWave } from '@/lib/sources'

export const GRID = 127

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

type Placement = Pick<Instance, 'at' | 'rot' | 'mirror'> & {
  look?: string | null
  model?: Pick<Instance['model'], 'params'>
}

/**
 * A label is drawn in its own frame (flag and text to the right of its point, text above the
 * wire) and mapped by its rotation: 180 mirrors it (the text stays upright, to the left), 270
 * points it up and 90 down, the text then read bottom to top like a rotated part's.
 */
export function labelFrame(label: Pick<Label, 'at' | 'rot'>): {
  map: (p: Point) => Point
  flip: boolean // the text grows the other way: its anchor flips
  textRotation: number
} {
  const [x0, y0] = label.at
  const map = ([x, y]: Point): Point => {
    switch (label.rot) {
      case 180:
        return [x0 - x, y0 + y]
      case 270:
        return [x0 + y, y0 - x]
      case 90:
        return [x0 + y, y0 + x]
      default:
        return [x0 + x, y0 + y]
    }
  }
  return {
    map,
    flip: label.rot === 180 || label.rot === 90,
    textRotation: label.rot === 90 || label.rot === 270 ? -Math.PI / 2 : 0,
  }
}

/** Box around a label and its text (`textWidth`: width of one character). */
export function labelBox(label: Pick<Label, 'at' | 'rot' | 'text'>, textWidth: number): Box {
  const { map } = labelFrame(label)
  const w = label.text.length * textWidth + 120
  const corners = (
    [
      [-40, -150],
      [w, -150],
      [-40, 40],
      [w, 40],
    ] as Point[]
  ).map(map)
  const xs = corners.map((p) => p[0])
  const ys = corners.map((p) => p[1])
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

export function transform([x, y]: Point, { at, rot, mirror }: Placement): Point {
  let px = mirror ? -x : x
  let py = y
  for (let i = 0; i < rot / 90; i++) {
    ;[px, py] = [-py, px]
  }
  return [px + at[0], py + at[1]]
}

export const snap = (value: number, grid = GRID): number => Math.round(value / grid) * grid
export const snapPoint = ([x, y]: Point, grid = GRID): Point => [snap(x, grid), snap(y, grid)]
export const samePoint = (a: Point, b: Point): boolean => a[0] === b[0] && a[1] === b[1]
export const pointKey = ([x, y]: Point): string => `${x},${y}`

export function onSegment(p: Point, a: Point, b: Point): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])
  if (cross !== 0) return false
  return (
    Math.min(a[0], b[0]) <= p[0] &&
    p[0] <= Math.max(a[0], b[0]) &&
    Math.min(a[1], b[1]) <= p[1] &&
    p[1] <= Math.max(a[1], b[1])
  )
}

export function onWire(p: Point, points: Point[]): boolean {
  for (let i = 0; i + 1 < points.length; i++) if (onSegment(p, points[i], points[i + 1])) return true
  return false
}

const CELL = 1270 // bucket size of the segment index (10 grid steps)

/**
 * Wire segments bucketed by grid cells, so "is this point on a wire?" looks at a few segments
 * instead of all of them (junction dots were O(points × wires), slow on large sheets).
 */
export class SegmentIndex {
  private cells = new Map<string, [Point, Point, Point[]][]>()

  constructor(wires: Point[][]) {
    for (const points of wires) {
      for (let i = 0; i + 1 < points.length; i++) {
        const [a, b] = [points[i], points[i + 1]]
        const [x0, x1] = [Math.floor(Math.min(a[0], b[0]) / CELL), Math.floor(Math.max(a[0], b[0]) / CELL)]
        const [y0, y1] = [Math.floor(Math.min(a[1], b[1]) / CELL), Math.floor(Math.max(a[1], b[1]) / CELL)]
        for (let cx = x0; cx <= x1; cx++)
          for (let cy = y0; cy <= y1; cy++) {
            const key = `${cx},${cy}`
            const list = this.cells.get(key)
            if (list) list.push([a, b, points])
            else this.cells.set(key, [[a, b, points]])
          }
      }
    }
  }

  /** Is p on some wire, but not at that wire's own ends? */
  interiorHit(p: Point): boolean {
    const list = this.cells.get(`${Math.floor(p[0] / CELL)},${Math.floor(p[1] / CELL)}`)
    if (!list) return false
    return list.some(
      ([a, b, points]) =>
        onSegment(p, a, b) && !samePoint(p, points[0]) && !samePoint(p, points[points.length - 1]),
    )
  }
}

/** Distance from p to segment ab (for hit testing wires). */
export function segmentDistance(p: Point, a: Point, b: Point): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2))
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

export function pinPositions(symbol: SymbolDef, inst: Placement): { number: string; at: Point }[] {
  return symbol.pins.map((pin) => ({ number: pin.number, at: transform(pin.at, inst) }))
}

const emptyBox = (): Box => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

function grow(box: Box, [x, y]: Point, pad = 0): void {
  box.minX = Math.min(box.minX, x - pad)
  box.minY = Math.min(box.minY, y - pad)
  box.maxX = Math.max(box.maxX, x + pad)
  box.maxY = Math.max(box.maxY, y + pad)
}

/** Bounding box of a symbol in its own coordinates (graphics + pins). */
export function symbolBox(symbol: SymbolDef): Box {
  const box = emptyBox()
  for (const g of symbol.graphics) {
    switch (g.kind) {
      case 'polyline':
        for (const p of g.points) grow(box, p)
        break
      case 'rect':
        grow(box, g.start)
        grow(box, g.end)
        break
      case 'circle':
        grow(box, g.center, g.radius)
        break
      case 'arc':
        grow(box, g.start)
        grow(box, g.mid)
        grow(box, g.end)
        break
      case 'text':
        grow(box, g.at, g.size / 2)
        break
    }
  }
  for (const pin of symbol.pins) grow(box, pin.at)
  if (!Number.isFinite(box.minX)) grow(box, [0, 0], GRID / 2)
  return box
}

/** Where a part's reference or value is drawn: put by hand, or where its symbol puts it. */
export interface TextSpot {
  at: Point
  anchor: [number, number]
  rotation: number
}

export function textSpot(symbol: SymbolDef, inst: Instance, field: TextField): TextSpot | null {
  const own = inst.texts?.[field]
  if (own) {
    return {
      at: [inst.at[0] + own.at[0], inst.at[1] + own.at[1]],
      anchor: [0, 0.5],
      rotation: own.rot === 90 ? -Math.PI / 2 : 0,
    }
  }
  const local = field === 'ref' ? symbol.ref_at : symbol.value_at
  if (!local) return null
  const world = transform(local, { ...inst, at: [0, 0] })
  return { at: transform(local, inst), anchor: [world[0] >= 0 ? 0 : 1, 0.5], rotation: 0 }
}

/** Box of a text of `length` characters at `spot` (`charWidth`, `height` in world units). */
export function textBox(spot: TextSpot, length: number, charWidth: number, height = 140): Box {
  const w = length * charWidth
  const x0 = -spot.anchor[0] * w
  const corners: Point[] = [
    [x0, -height / 2],
    [x0 + w, -height / 2],
    [x0, height / 2],
    [x0 + w, height / 2],
  ]
  // Rotated -90°: the text reads upwards from its anchor.
  const turned = spot.rotation ? corners.map(([x, y]): Point => [y, -x]) : corners
  const xs = turned.map((p) => spot.at[0] + p[0])
  const ys = turned.map((p) => spot.at[1] + p[1])
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
}

/** The hand placement equal to where a text is now (left end, as a moved text is anchored). */
export function placeOf(spot: TextSpot, inst: Instance, length: number, charWidth: number): TextPlace {
  const w = length * charWidth
  const shift = spot.anchor[0] * w // a right-aligned text starts this much to the left
  const left: Point = spot.rotation ? [spot.at[0], spot.at[1] + shift] : [spot.at[0] - shift, spot.at[1]]
  return {
    at: [Math.round(left[0] - inst.at[0]), Math.round(left[1] - inst.at[1])],
    rot: spot.rotation ? 90 : 0,
  }
}

/** World bounding box of a placed symbol. */
export function instanceBox(symbol: SymbolDef, inst: Placement, pad = 25): Box {
  const local = symbolBox(drawn(symbol, inst.look, inst.model?.params?.tran))
  const box = emptyBox()
  for (const corner of [
    [local.minX, local.minY],
    [local.maxX, local.minY],
    [local.minX, local.maxY],
    [local.maxX, local.maxY],
  ] as Point[]) {
    grow(box, transform(corner, inst), pad)
  }
  return box
}

export function wireBox(points: Point[], pad = 25): Box {
  const box = emptyBox()
  for (const p of points) grow(box, p, pad)
  return box
}

export function boxContains(outer: Box, inner: Box): boolean {
  return (
    inner.minX >= outer.minX &&
    inner.maxX <= outer.maxX &&
    inner.minY >= outer.minY &&
    inner.maxY <= outer.maxY
  )
}

/** Text shown as the component value (R/C/L value, source spec, model name). */
export function valueText(symbol: SymbolDef, inst: Instance): string {
  const params = { ...symbol.default_params, ...inst.model.params }
  if (symbol.power_net !== null) return ''
  if (symbol.default_model !== null || inst.model.model) return inst.model.model ?? symbol.default_model ?? ''
  if (symbol.spice?.element === 'V' || symbol.spice?.element === 'I') {
    const parts: string[] = []
    const unit = symbol.spice.element === 'I' ? 'A' : 'V'
    if (params.tran) parts.push(shortWave(params.tran, unit))
    else if (params.dc?.trim()) parts.push(`DC ${params.dc}`)
    if (params.ac) parts.push(`AC ${params.ac}`)
    return parts.join(' ')
  }
  if (symbol.spice?.element === 'B') {
    // A current source has its expression in i (the default v = 0 does not apply then).
    return inst.model.params.i ? `I=${inst.model.params.i}` : `V=${params.v ?? ''}`
  }
  if (symbol.spice?.element === 'X' && !symbol.value_param) {
    // A block: its parameter overrides (the defaults are on its sheet); a real part without
    // them shows its name (1N4148), unless its drawing has it already (a titled box).
    const overrides = Object.entries(inst.model.params)
      .filter(([, v]) => v.trim())
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')
    if (overrides || !symbol.kind) return overrides
    return symbol.graphics.some((g) => g.kind === 'text' && g.text === symbol.name) ? '' : symbol.name
  }
  return symbol.value_param ? (params[symbol.value_param] ?? '') : ''
}

/**
 * Where junction dots are drawn: explicit junctions, T-connections (a wire end or pin on
 * another wire's interior) and points where three or more wire ends / pins meet.
 */
export function junctionDots(sheet: Sheet, symbols: Map<string, SymbolDef>): Point[] {
  const counts = new Map<string, { at: Point; n: number }>()
  const add = (p: Point) => {
    const key = pointKey(p)
    const entry = counts.get(key)
    if (entry) entry.n++
    else counts.set(key, { at: p, n: 1 })
  }
  const wires = sheet.wires.filter((w) => !w.bus) // buses connect nothing: no dots on them
  for (const wire of wires) {
    add(wire.points[0])
    add(wire.points[wire.points.length - 1])
  }
  for (const inst of sheet.instances) {
    const symbol = symbols.get(inst.symbol)
    if (symbol) for (const pin of pinPositions(symbol, inst)) add(pin.at)
  }
  const dots = new Map<string, Point>()
  const segments = new SegmentIndex(wires.map((w) => w.points))
  for (const { at, n } of counts.values()) {
    if (n >= 3) dots.set(pointKey(at), at)
    else if (segments.interiorHit(at)) dots.set(pointKey(at), at) // T: an end on another wire's middle
  }
  for (const j of sheet.junctions) dots.set(pointKey(j.at), j.at)
  return [...dots.values()]
}

/** Lower-cased references used on all sheets. */
export function usedRefs(project: Project): Set<string> {
  return new Set(project.sheets.flatMap((s) => s.instances.map((i) => i.ref.toLowerCase())))
}

export function nextFreeRef(prefix: string, used: Set<string>): string {
  for (let n = 1; ; n++) {
    const ref = `${prefix}${n}`
    if (!used.has(ref.toLowerCase())) return ref
  }
}

/** Next free reference with a prefix (R1, R2, ...) across all sheets. */
export const nextRef = (prefix: string, project: Project): string => nextFreeRef(prefix, usedRefs(project))

/** Orthogonal route from a to b: horizontal first (or vertical first). */
export function orthogonal(a: Point, b: Point, horizontalFirst: boolean): Point[] {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b]
  const corner: Point = horizontalFirst ? [b[0], a[1]] : [a[0], b[1]]
  return [a, corner, b]
}

export type WireMode = '90' | '45' | 'free'

/** Route of a new wire segment from `a` to `b`: 90° (one corner), 45° (straight + diagonal)
 *  or a straight line at any angle. `firstStraight` swaps the corner. */
export function route(a: Point, b: Point, mode: WireMode, firstStraight: boolean): Point[] {
  if (mode === '90') return orthogonal(a, b, firstStraight)
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
  if (mode === 'free' || dx === 0 || dy === 0 || Math.abs(dx) === Math.abs(dy)) return [a, b]
  const m = Math.min(Math.abs(dx), Math.abs(dy))
  const [sx, sy] = [Math.sign(dx), Math.sign(dy)]
  const corner: Point = firstStraight
    ? Math.abs(dx) > Math.abs(dy)
      ? [b[0] - sx * m, a[1]]
      : [a[0], b[1] - sy * m]
    : [a[0] + sx * m, a[1] + sy * m]
  return [a, corner, b]
}

/** Remove zero-length segments and merge collinear ones. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = []
  for (const p of points) {
    if (out.length && samePoint(out[out.length - 1], p)) continue
    if (out.length >= 2) {
      const [a, b] = [out[out.length - 2], out[out.length - 1]]
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) {
        out[out.length - 1] = p
        continue
      }
    }
    out.push(p)
  }
  return out
}

/**
 * Bounds of sheet objects in world units: all of them, or only those whose id or
 * instance ref is listed. Labels and texts use an estimated text width.
 */
export function sheetBounds(
  sheet: Sheet,
  symbols: Map<string, SymbolDef>,
  filter?: { ids?: Set<string>; refs?: Set<string> },
): Box | null {
  const box = emptyBox()
  const wanted = (id: string, ref?: string) =>
    !filter || filter.ids?.has(id) || (ref !== undefined && filter.refs?.has(ref.toLowerCase()))
  for (const inst of sheet.instances) {
    if (!wanted(inst.id, inst.ref)) continue
    const symbol = symbols.get(inst.symbol)
    const b = symbol ? instanceBox(symbol, inst) : wireBox([inst.at], 127)
    grow(box, [b.minX, b.minY])
    grow(box, [b.maxX, b.maxY])
  }
  for (const wire of sheet.wires) if (wanted(wire.id)) for (const p of wire.points) grow(box, p)
  for (const label of sheet.labels) {
    if (!wanted(label.id)) continue
    const b = labelBox(label, 70)
    grow(box, [b.minX, b.minY])
    grow(box, [b.maxX, b.maxY])
  }
  for (const d of sheet.directives) {
    if (!wanted(d.id)) continue
    const lines = d.text.split('\n')
    grow(box, d.at, 60)
    grow(box, [d.at[0] + Math.max(...lines.map((l) => l.length)) * 70, d.at[1] + lines.length * 143])
  }
  return Number.isFinite(box.minX) ? box : null
}

/** True if a wire ending at `p` would connect to something (pin, wire, label). */
export function isConnectionPoint(sheet: Sheet, symbols: Map<string, SymbolDef>, p: Point): boolean {
  for (const inst of sheet.instances) {
    const symbol = symbols.get(inst.symbol)
    if (symbol && pinPositions(symbol, inst).some((pin) => samePoint(pin.at, p))) return true
  }
  return sheet.wires.some((w) => onWire(p, w.points)) || sheet.labels.some((l) => samePoint(l.at, p))
}

/** Point where segments ab and cd meet (only crossings of perpendicular axis-aligned segments). */
function axisCrossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const horizontal = (p: Point, q: Point) => p[1] === q[1] && p[0] !== q[0]
  const vertical = (p: Point, q: Point) => p[0] === q[0] && p[1] !== q[1]
  let h: [Point, Point]
  let v: [Point, Point]
  if (horizontal(a, b) && vertical(c, d))
    [h, v] = [
      [a, b],
      [c, d],
    ]
  else if (vertical(a, b) && horizontal(c, d))
    [h, v] = [
      [c, d],
      [a, b],
    ]
  else return null
  const p: Point = [v[0][0], h[0][1]]
  return onSegment(p, ...h) && onSegment(p, ...v) ? p : null
}

/**
 * Points where the wire `points` crosses existing wires away from any wire end: there the
 * wires only connect through a junction (used by the automatic junction option).
 */
export function wireCrossings(points: Point[], wires: { points: Point[] }[]): Point[] {
  const ends = (pts: Point[]) => [pts[0], pts[pts.length - 1]]
  const found = new Map<string, Point>()
  for (const wire of wires) {
    for (let i = 0; i + 1 < points.length; i++) {
      for (let j = 0; j + 1 < wire.points.length; j++) {
        const p = axisCrossing(points[i], points[i + 1], wire.points[j], wire.points[j + 1])
        if (!p || [...ends(points), ...ends(wire.points)].some((e) => samePoint(e, p))) continue
        found.set(pointKey(p), p)
      }
    }
  }
  return [...found.values()]
}

/** Nearest grid point on a wire within `tolerance` of p (labels snap onto wires), or null. */
export function pointOnWire(p: Point, wires: { points: Point[] }[], tolerance: number): Point | null {
  let best: Point | null = null
  let bestDistance = tolerance
  for (const wire of wires) {
    for (let i = 0; i + 1 < wire.points.length; i++) {
      const [a, b] = [wire.points[i], wire.points[i + 1]]
      let q: Point
      if (a[1] === b[1])
        q = [Math.min(Math.max(snap(p[0]), Math.min(a[0], b[0])), Math.max(a[0], b[0])), a[1]]
      else if (a[0] === b[0])
        q = [a[0], Math.min(Math.max(snap(p[1]), Math.min(a[1], b[1])), Math.max(a[1], b[1]))]
      else continue
      const distance = Math.hypot(p[0] - q[0], p[1] - q[1])
      if (distance <= bestDistance) [best, bestDistance] = [q, distance]
    }
  }
  return best
}

/** Where a label or junction clicked at `cursor` goes: onto a wire within a grid step, else the cursor. */
export function labelPoint(cursor: Point, wires: { points: Point[] }[], scale: number): Point {
  return pointOnWire(cursor, wires, Math.max(GRID, 8 / scale)) ?? cursor
}
