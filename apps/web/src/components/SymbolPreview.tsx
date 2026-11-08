/** Small SVG drawing of a library symbol (same graphics data as the schematic renderer). */
import type { Point, SymbolDef } from '@/api/types'
import { symbolBox } from '@/editor/geometry'
import { drawn } from '@/lib/looks'
import { useProject } from '@/store/project'
import { useSettings } from '@/store/settings'

const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] } as const

/** Points along the circle through start, mid and end (for SVG polylines). */
export function arcPoints(start: Point, mid: Point, end: Point, steps = 16): Point[] {
  const [ax, ay] = start
  const [bx, by] = mid
  const [cx, cy] = end
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-9) return [start, end]
  const ux =
    ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d
  const uy =
    ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d
  const r = Math.hypot(ax - ux, ay - uy)
  const norm = (a: number) => (a + 4 * Math.PI) % (2 * Math.PI)
  const a0 = Math.atan2(ay - uy, ax - ux)
  const am = norm(Math.atan2(by - uy, bx - ux) - a0)
  let sweep = norm(Math.atan2(cy - uy, cx - ux) - a0)
  if (am > sweep) sweep -= 2 * Math.PI // go the other way round so the arc passes through mid
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = a0 + (sweep * i) / steps
    return [ux + r * Math.cos(a), uy + r * Math.sin(a)] as Point
  })
}

export function SymbolPreview({
  symbol: own,
  size = 28,
  look,
}: {
  symbol: SymbolDef
  size?: number
  look?: string | null
}) {
  useSettings((s) => s.symbolStandard) // redraw when the standard changes
  useProject((s) => s.project?.symbol_standard)
  const symbol = drawn(own, look)
  const box = symbolBox(symbol)
  const pad = 40
  const w = box.maxX - box.minX + 2 * pad
  const h = box.maxY - box.minY + 2 * pad
  const stroke = Math.max(w, h) / 22
  const pts = (points: Point[]) => points.map((p) => p.join(',')).join(' ')
  return (
    <svg
      viewBox={`${box.minX - pad} ${box.minY - pad} ${w} ${h}`}
      width={size}
      height={size}
      aria-hidden="true"
      className="shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {symbol.pins.map((pin) => {
        if (pin.length <= 0) return null
        const [dx, dy] = DIRS[pin.orientation]
        const [x, y] = pin.at
        return <line key={pin.number} x1={x} y1={y} x2={x - dx * pin.length} y2={y - dy * pin.length} />
      })}
      {symbol.graphics.map((g, i) => {
        const key = `${g.kind}-${i}`
        switch (g.kind) {
          case 'polyline':
            return g.fill ? (
              <polygon key={key} points={pts(g.points)} fill="currentColor" stroke="none" />
            ) : (
              <polyline key={key} points={pts(g.points)} />
            )
          case 'rect':
            return (
              <rect
                key={key}
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
                cx={g.center[0]}
                cy={g.center[1]}
                r={g.radius}
                fill={g.fill ? 'currentColor' : 'none'}
              />
            )
          case 'arc':
            return <polyline key={key} points={pts(arcPoints(g.start, g.mid, g.end))} />
          default:
            return null
        }
      })}
    </svg>
  )
}
