/**
 * Move / drag preview as a pure function: the same result is rendered while dragging and
 * turned into commands on release, so what you see is what gets committed.
 */
import type { Command, Point, Sheet, SymbolDef } from '@/api/types'
import type { WireEdit, WirePart } from '@/store/editor'
import { pinPositions, pointKey, samePoint, segmentDistance, simplify } from './geometry'

const shift = ([x, y]: Point, [dx, dy]: Point): Point => [x + dx, y + dy]

/**
 * Sheet with the selected objects shifted by `delta`. With `stretch` (drag), wire ends that
 * touch a moved pin follow it; an extra corner keeps the wire orthogonal.
 */
export function previewSheet(
  sheet: Sheet,
  selection: Set<string>,
  delta: Point,
  stretch: boolean,
  symbols: Map<string, SymbolDef>,
): Sheet {
  if (delta[0] === 0 && delta[1] === 0) return sheet
  const moved = new Set<string>()
  if (stretch) {
    for (const inst of sheet.instances) {
      if (!selection.has(inst.id)) continue
      const symbol = symbols.get(inst.symbol)
      if (symbol) for (const pin of pinPositions(symbol, inst)) moved.add(pointKey(pin.at))
    }
    for (const label of sheet.labels) if (selection.has(label.id)) moved.add(pointKey(label.at))
  }
  return {
    ...sheet,
    instances: sheet.instances.map((i) => (selection.has(i.id) ? { ...i, at: shift(i.at, delta) } : i)),
    labels: sheet.labels.map((l) => (selection.has(l.id) ? { ...l, at: shift(l.at, delta) } : l)),
    junctions: sheet.junctions.map((j) => (selection.has(j.id) ? { ...j, at: shift(j.at, delta) } : j)),
    directives: sheet.directives.map((d) => (selection.has(d.id) ? { ...d, at: shift(d.at, delta) } : d)),
    wires: sheet.wires.map((w) => {
      if (selection.has(w.id)) return { ...w, points: w.points.map((p) => shift(p, delta)) }
      if (!stretch) return w
      return { ...w, points: stretchWire(w.points, moved, delta) }
    }),
  }
}

function stretchWire(points: Point[], moved: Set<string>, delta: Point): Point[] {
  const first = moved.has(pointKey(points[0]))
  const last = moved.has(pointKey(points[points.length - 1]))
  if (!first && !last) return points
  if (first && last) return points.map((p) => shift(p, delta))
  return moveWireEnd(points, first ? 'start' : 'end', delta)
}

/** Move one end of a wire, keeping the neighbouring segment's direction (adds a corner). */
export function moveWireEnd(points: Point[], which: 'start' | 'end', delta: Point): Point[] {
  const pts = which === 'start' ? [...points].reverse() : [...points]
  const end = pts[pts.length - 1]
  const prev = pts[pts.length - 2]
  const target = shift(end, delta)
  const horizontal = prev[1] === end[1]
  const corner: Point = horizontal ? [target[0], prev[1]] : [prev[0], target[1]]
  const out = simplify([...pts.slice(0, -1), corner, target])
  return which === 'start' ? out.reverse() : out
}

/**
 * Drag one segment perpendicular to itself. The wire's ends stay where they are (connected
 * to pins): an outer segment gets an extra corner instead of moving its end.
 */
export function moveWireSegment(points: Point[], index: number, delta: Point): Point[] {
  const [a, b] = [points[index], points[index + 1]]
  const horizontal = a[1] === b[1]
  const d: Point = horizontal ? [0, delta[1]] : [delta[0], 0]
  if (d[0] === 0 && d[1] === 0) return points
  const out = points.map((p, i) => (i === index || i === index + 1 ? shift(p, d) : p))
  if (index === 0) out.unshift(a)
  if (index + 1 === points.length - 1) out.push(b)
  return simplify(out)
}

/** Commands turning `before` into `after` (only moves and wire reshapes are expected). */
export function moveCommands(
  sheetName: string,
  before: Sheet,
  after: Sheet,
  selection: Set<string>,
  delta: Point,
): Command[] {
  const commands: Command[] = []
  const ids = [...selection]
  if (ids.length > 0 && (delta[0] !== 0 || delta[1] !== 0)) {
    commands.push({ type: 'move_objects', sheet: sheetName, ids, dx: delta[0], dy: delta[1] })
  }
  for (let i = 0; i < before.wires.length; i++) {
    const [old, next] = [before.wires[i], after.wires[i]]
    if (selection.has(old.id)) continue
    const changed =
      old.points.length !== next.points.length || old.points.some((p, k) => !samePoint(p, next.points[k]))
    if (changed) commands.push({ type: 'set_wire_points', sheet: sheetName, id: old.id, points: next.points })
  }
  return commands
}

/** Which part of a wire is under `p`: an end (within `endTolerance`) or the nearest segment. */
export function wirePartAt(points: Point[], p: Point, endTolerance: number): WirePart {
  const dist = (q: Point) => Math.hypot(q[0] - p[0], q[1] - p[1])
  if (dist(points[0]) <= endTolerance) return { kind: 'end', which: 'start' }
  if (dist(points[points.length - 1]) <= endTolerance) return { kind: 'end', which: 'end' }
  let best = 0
  for (let i = 1; i + 1 < points.length; i++) {
    if (segmentDistance(p, points[i], points[i + 1]) < segmentDistance(p, points[best], points[best + 1]))
      best = i
  }
  return { kind: 'segment', index: best }
}

/** Points of a wire after a segment / end drag. */
export function editWire(points: Point[], edit: Pick<WireEdit, 'part' | 'delta'>): Point[] {
  return edit.part.kind === 'end'
    ? moveWireEnd(points, edit.part.which, edit.delta)
    : moveWireSegment(points, edit.part.index, edit.delta)
}

export type TransformKind = 'rotate' | 'mirrorX' | 'mirrorY'

const turn = (r: number, by: number) => ((((r + by) % 360) + 360) % 360) as 0 | 90 | 180 | 270

/** Rotation after mirroring a part about the vertical (X) or horizontal (Y) axis; the mirror
 *  flag toggles too. A rotated part needs both, or it flips about its diagonal. */
export const mirroredRotation = (rot: number, kind: 'mirrorX' | 'mirrorY') =>
  kind === 'mirrorX' ? turn(-rot, 0) : turn(180 - rot, 0)

/**
 * Rotate (90° clockwise on screen) or mirror the selection. One part turns in place; a group
 * turns around the centre of its points (snapped to the grid, so everything stays on grid).
 * Mirroring a rotated part: horizontal flip = (rot -> -rot, mirror toggled), vertical flip =
 * (rot -> 180 - rot, mirror toggled), which matches transform() in geometry.ts.
 */
export function transformCommands(
  sheetName: string,
  sheet: Sheet,
  selection: Set<string>,
  kind: TransformKind,
): Command[] {
  const instances = sheet.instances.filter((i) => selection.has(i.id))
  const wires = sheet.wires.filter((w) => selection.has(w.id))
  const labels = sheet.labels.filter((l) => selection.has(l.id))
  const junctions = sheet.junctions.filter((j) => selection.has(j.id))
  const directives = sheet.directives.filter((d) => selection.has(d.id))
  const points: Point[] = [
    ...instances.map((i) => i.at),
    ...wires.flatMap((w) => w.points),
    ...labels.map((l) => l.at),
    ...junctions.map((j) => j.at),
    ...directives.map((d) => d.at),
  ]
  if (points.length === 0) return []
  const xs = points.map((p) => p[0])
  const ys = points.map((p) => p[1])
  const grid = 127
  const center: Point =
    instances.length === 1 && points.length === 1
      ? instances[0].at
      : [
          Math.round((Math.min(...xs) + Math.max(...xs)) / 2 / grid) * grid,
          Math.round((Math.min(...ys) + Math.max(...ys)) / 2 / grid) * grid,
        ]
  const [cx, cy] = center
  const map = ([x, y]: Point): Point =>
    kind === 'rotate'
      ? [cx - (y - cy), cy + (x - cx)]
      : kind === 'mirrorX'
        ? [2 * cx - x, y]
        : [x, 2 * cy - y]
  const commands: Command[] = []
  // A text put by hand keeps its place around the part: its offset turns the same way.
  const offset = ([x, y]: Point): Point =>
    kind === 'rotate' ? [-y, x] : kind === 'mirrorX' ? [-x, y] : [x, -y]
  for (const inst of instances) {
    const rot = kind === 'rotate' ? turn(inst.rot, 90) : mirroredRotation(inst.rot, kind)
    const texts =
      inst.texts && Object.keys(inst.texts).length
        ? Object.fromEntries(Object.entries(inst.texts).map(([k, t]) => [k, t && { ...t, at: offset(t.at) }]))
        : undefined
    commands.push({
      type: 'update_instance',
      sheet: sheetName,
      id: inst.id,
      at: map(inst.at),
      rot,
      ...(kind === 'rotate' ? {} : { mirror: !inst.mirror }),
      ...(texts ? { texts } : {}),
    })
  }
  for (const wire of wires) {
    commands.push({ type: 'set_wire_points', sheet: sheetName, id: wire.id, points: wire.points.map(map) })
  }
  for (const label of labels) {
    commands.push({
      type: 'update_label',
      sheet: sheetName,
      id: label.id,
      at: map(label.at),
      ...(kind === 'rotate' ? { rot: turn(label.rot, 90) } : {}),
    })
  }
  for (const j of junctions) {
    const at = map(j.at)
    commands.push({
      type: 'move_objects',
      sheet: sheetName,
      ids: [j.id],
      dx: at[0] - j.at[0],
      dy: at[1] - j.at[1],
    })
  }
  for (const d of directives)
    commands.push({ type: 'update_directive', sheet: sheetName, id: d.id, at: map(d.at) })
  return commands
}
