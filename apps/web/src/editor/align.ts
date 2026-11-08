/**
 * Align and distribute parts (FR-SCH-10). Parts move one after another on a copy of the sheet
 * with their wires following (as when dragging), so connections stay; moves are whole grid
 * steps, so pins stay on the grid.
 */
import type { Command, Point, Sheet, SymbolDef } from '@/api/types'
import { type Box, GRID, instanceBox, pinPositions, samePoint } from './geometry'
import { previewSheet } from './preview'

export type AlignMode =
  | 'left'
  | 'right'
  | 'top'
  | 'bottom'
  | 'centerX' // centres on one vertical line
  | 'centerY' // centres on one horizontal line
  | 'distributeX'
  | 'distributeY'

const snap = (v: number) => Math.round(v / GRID) * GRID

/** How far each part moves; parts already in place are left out. */
export function alignDeltas(boxes: Map<string, Box>, mode: AlignMode): Map<string, Point> {
  const all = [...boxes.values()]
  const cx = (b: Box) => (b.minX + b.maxX) / 2
  const cy = (b: Box) => (b.minY + b.maxY) / 2
  const out = new Map<string, Point>()
  const put = (id: string, dx: number, dy: number) => {
    const d: Point = [snap(dx), snap(dy)]
    if (d[0] || d[1]) out.set(id, d)
  }
  if (mode === 'distributeX' || mode === 'distributeY') {
    const horizontal = mode === 'distributeX'
    const centre = horizontal ? cx : cy
    const sorted = [...boxes.entries()].sort(([, a], [, b]) => centre(a) - centre(b))
    if (sorted.length < 3) return out
    const first = centre(sorted[0][1])
    const step = (centre(sorted[sorted.length - 1][1]) - first) / (sorted.length - 1)
    sorted.forEach(([id, box], i) => {
      const shift = first + i * step - centre(box)
      put(id, horizontal ? shift : 0, horizontal ? 0 : shift)
    })
    return out
  }
  const edges: Record<Exclude<typeof mode, 'distributeX' | 'distributeY'>, number> = {
    left: Math.min(...all.map((b) => b.minX)),
    right: Math.max(...all.map((b) => b.maxX)),
    top: Math.min(...all.map((b) => b.minY)),
    bottom: Math.max(...all.map((b) => b.maxY)),
    centerX: all.reduce((s, b) => s + cx(b), 0) / all.length,
    centerY: all.reduce((s, b) => s + cy(b), 0) / all.length,
  }
  const target = edges[mode]
  for (const [id, box] of boxes) {
    if (mode === 'left') put(id, target - box.minX, 0)
    if (mode === 'right') put(id, target - box.maxX, 0)
    if (mode === 'top') put(id, 0, target - box.minY)
    if (mode === 'bottom') put(id, 0, target - box.maxY)
    if (mode === 'centerX') put(id, target - cx(box), 0)
    if (mode === 'centerY') put(id, 0, target - cy(box))
  }
  return out
}

/** Commands aligning the selected parts; empty when nothing moves or too few are selected. */
export function alignCommands(
  sheetName: string,
  sheet: Sheet,
  symbols: Map<string, SymbolDef>,
  selection: Set<string>,
  mode: AlignMode,
): Command[] {
  const boxes = new Map<string, Box>()
  for (const inst of sheet.instances) {
    const symbol = symbols.get(inst.symbol)
    if (selection.has(inst.id) && symbol) boxes.set(inst.id, instanceBox(symbol, inst, 0))
  }
  if (boxes.size < (mode.startsWith('distribute') ? 3 : 2)) return []
  const deltas = alignDeltas(boxes, mode)
  let current = sheet
  const commands: Command[] = []
  for (const [id, [dx, dy]] of deltas) {
    // Labels sitting on the part's pins (how imported netlists connect) go with it.
    const inst = current.instances.find((i) => i.id === id)
    const symbol = inst && symbols.get(inst.symbol)
    const pins = inst && symbol ? pinPositions(symbol, inst).map((p) => p.at) : []
    const labels = current.labels.filter((l) => pins.some((p) => samePoint(p, l.at))).map((l) => l.id)
    current = previewSheet(current, new Set([id, ...labels]), [dx, dy], true, symbols)
    commands.push({ type: 'move_objects', sheet: sheetName, ids: [id, ...labels], dx, dy })
  }
  const gone: string[] = []
  sheet.wires.forEach((wire, i) => {
    const next = current.wires[i]
    const changed =
      wire.points.length !== next.points.length || wire.points.some((p, k) => !samePoint(p, next.points[k]))
    // A short wire between two parts that now touch shrinks to a point: it is not needed.
    if (next.points.length < 2 || next.points.every((p) => samePoint(p, next.points[0]))) gone.push(wire.id)
    else if (changed)
      commands.push({ type: 'set_wire_points', sheet: sheetName, id: wire.id, points: next.points })
  })
  if (gone.length) commands.push({ type: 'remove_objects', sheet: sheetName, ids: gone })
  return commands
}
