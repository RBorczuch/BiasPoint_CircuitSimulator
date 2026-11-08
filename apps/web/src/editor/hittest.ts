/** Spatial index of sheet objects for picking and box selection (rbush). */
import RBush from 'rbush'
import type { Point, Sheet, SheetObjectKind, SymbolDef } from '@/api/types'
import { type Box, boxContains, instanceBox, labelBox, segmentDistance, wireBox } from './geometry'

export interface HitItem extends Box {
  id: string
  kind: SheetObjectKind
  points?: Point[]
}

const TEXT_W = 110 * 0.62
const PRIORITY: Record<SheetObjectKind, number> = {
  labels: 0,
  directives: 0,
  junctions: 1,
  instances: 2,
  wires: 3,
}

export class HitIndex {
  private tree = new RBush<HitItem>()
  private byId = new Map<string, HitItem>()

  build(sheet: Sheet, symbols: Map<string, SymbolDef>): void {
    const items: HitItem[] = []
    for (const inst of sheet.instances) {
      const symbol = symbols.get(inst.symbol)
      const box = symbol
        ? instanceBox(symbol, inst)
        : { minX: inst.at[0] - 127, minY: inst.at[1] - 127, maxX: inst.at[0] + 127, maxY: inst.at[1] + 127 }
      items.push({ ...box, id: inst.id, kind: 'instances' })
    }
    for (const wire of sheet.wires)
      items.push({ ...wireBox(wire.points), id: wire.id, kind: 'wires', points: wire.points })
    for (const j of sheet.junctions) {
      items.push({
        minX: j.at[0] - 40,
        minY: j.at[1] - 40,
        maxX: j.at[0] + 40,
        maxY: j.at[1] + 40,
        id: j.id,
        kind: 'junctions',
      })
    }
    for (const label of sheet.labels) {
      items.push({ ...labelBox(label, TEXT_W), id: label.id, kind: 'labels' })
    }
    for (const d of sheet.directives) {
      const lines = d.text.split('\n')
      const w = Math.max(...lines.map((l) => l.length)) * TEXT_W
      const [x, y] = d.at
      items.push({
        minX: x,
        minY: y - 70,
        maxX: x + w,
        maxY: y + lines.length * 143,
        id: d.id,
        kind: 'directives',
      })
    }
    this.tree.clear()
    this.tree.load(items)
    this.byId = new Map(items.map((item) => [item.id, item]))
  }

  /** Bounding box of an indexed object. */
  boxOf(id: string): Box | null {
    return this.byId.get(id) ?? null
  }

  /** Topmost object under `p` (labels and texts before symbols before wires). */
  at(p: Point, tolerance: number): HitItem | null {
    const candidates = this.tree
      .search({
        minX: p[0] - tolerance,
        minY: p[1] - tolerance,
        maxX: p[0] + tolerance,
        maxY: p[1] + tolerance,
      })
      .filter((item) => {
        if (item.kind !== 'wires' || !item.points) return true
        for (let i = 0; i + 1 < item.points.length; i++) {
          if (segmentDistance(p, item.points[i], item.points[i + 1]) <= tolerance) return true
        }
        return false
      })
    candidates.sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || area(a) - area(b))
    return candidates[0] ?? null
  }

  /** Ids of objects entirely inside the box, or touching it when `crossing`. */
  inside(box: Box, crossing = false): string[] {
    return this.tree
      .search(box)
      .filter((item) => crossing || boxContains(box, item))
      .map((item) => item.id)
  }
}

const area = (b: Box) => (b.maxX - b.minX) * (b.maxY - b.minY)
