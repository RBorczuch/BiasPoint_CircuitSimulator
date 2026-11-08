import { describe, expect, it } from 'vitest'
import type { Instance, Point, SymbolDef } from '@/api/types'
import {
  labelBox,
  labelFrame,
  onWire,
  orthogonal,
  pointOnWire,
  route,
  simplify,
  transform,
  valueText,
  wireCrossings,
} from './geometry'

describe('transform', () => {
  // Same cases as the backend: R1 at (762,-381) rot 90 puts pin (0,-381) at (1143,-381).
  it('rotates clockwise on screen like the backend', () => {
    expect(transform([0, -381], { at: [762, -381], rot: 90, mirror: false })).toEqual([1143, -381])
    expect(transform([0, 381], { at: [762, -381], rot: 90, mirror: false })).toEqual([381, -381])
  })

  it('mirrors before rotating', () => {
    expect(transform([10, 5], { at: [0, 0], rot: 0, mirror: true })).toEqual([-10, 5])
    expect(transform([10, 5], { at: [0, 0], rot: 180, mirror: true })).toEqual([10, -5])
  })
})

describe('wires', () => {
  it('routes orthogonally and simplifies collinear points', () => {
    const route = orthogonal([0, 0], [254, 127], true)
    expect(route).toEqual([
      [0, 0],
      [254, 0],
      [254, 127],
    ])
    const pts: Point[] = [
      [0, 0],
      [127, 0],
      [254, 0],
      [254, 0],
      [254, 127],
    ]
    expect(simplify(pts)).toEqual([
      [0, 0],
      [254, 0],
      [254, 127],
    ])
    expect(onWire([127, 0], route)).toBe(true)
    expect(onWire([127, 1], route)).toBe(false)
  })
})

describe('wireCrossings', () => {
  const wires = [
    {
      points: [
        [0, 0],
        [1270, 0],
      ] as Point[],
    },
  ]
  it('finds crossings away from wire ends', () => {
    expect(
      wireCrossings(
        [
          [635, -254],
          [635, 254],
        ],
        wires,
      ),
    ).toEqual([[635, 0]])
  })
  it('ignores T connections (an end on the other wire)', () => {
    expect(
      wireCrossings(
        [
          [635, 0],
          [635, 254],
        ],
        wires,
      ),
    ).toEqual([])
    expect(
      wireCrossings(
        [
          [0, -254],
          [0, 254],
        ],
        wires,
      ),
    ).toEqual([])
  })
})

describe('pointOnWire', () => {
  const wires = [
    {
      points: [
        [0, 0],
        [1270, 0],
        [1270, 1270],
      ] as Point[],
    },
  ]
  it('snaps to the nearest grid point of a nearby segment', () => {
    expect(pointOnWire([508, 100], wires, 127)).toEqual([508, 0])
    expect(pointOnWire([1300, 640], wires, 127)).toEqual([1270, 635])
  })
  it('returns null when far away', () => {
    expect(pointOnWire([508, 600], wires, 127)).toBeNull()
  })
})

describe('wire routes', () => {
  it('runs at 90°, 45° or any angle', () => {
    expect(route([0, 0], [500, 200], '90', true)).toEqual([
      [0, 0],
      [500, 0],
      [500, 200],
    ])
    // 45°: straight first, then the diagonal; or the diagonal first.
    expect(route([0, 0], [500, 200], '45', true)).toEqual([
      [0, 0],
      [300, 0],
      [500, 200],
    ])
    expect(route([0, 0], [500, 200], '45', false)).toEqual([
      [0, 0],
      [200, 200],
      [500, 200],
    ])
    expect(route([0, 0], [-200, -500], '45', true)).toEqual([
      [0, 0],
      [0, -300],
      [-200, -500],
    ])
    expect(route([0, 0], [300, 300], '45', true)).toEqual([
      [0, 0],
      [300, 300],
    ])
    expect(route([0, 0], [500, 200], 'free', true)).toEqual([
      [0, 0],
      [500, 200],
    ])
  })
})

describe('valueText', () => {
  const bsource = {
    default_params: { v: '0' },
    power_net: null,
    default_model: null,
    value_param: 'v',
    spice: { element: 'B', nodes: ['+', '-'] },
  } as unknown as SymbolDef
  const inst = (params: Record<string, string>) => ({ model: { model: null, params } }) as unknown as Instance

  it('shows the expression of a behavioural source with its kind', () => {
    expect(valueText(bsource, inst({ v: '2*V(a)' }))).toBe('V=2*V(a)')
    expect(valueText(bsource, inst({ i: '1m*V(a)' }))).toBe('I=1m*V(a)')
  })
})

describe('labels', () => {
  const at: Point = [1000, 1000]
  it('point the way they are rotated, the text upright or read bottom to top', () => {
    expect(labelFrame({ at, rot: 0 }).map([100, 0])).toEqual([1100, 1000])
    expect(labelFrame({ at, rot: 180 }).map([100, 0])).toEqual([900, 1000])
    expect(labelFrame({ at, rot: 90 }).map([100, 0])).toEqual([1000, 1100])
    expect(labelFrame({ at, rot: 270 }).map([100, 0])).toEqual([1000, 900])
    expect(labelFrame({ at, rot: 180 }).textRotation).toBe(0)
    expect(labelFrame({ at, rot: 90 }).textRotation).toBe(-Math.PI / 2)
  })
  it('are found where they are drawn', () => {
    const right = labelBox({ at, rot: 0, text: 'out' }, 70)
    const left = labelBox({ at, rot: 180, text: 'out' }, 70)
    const down = labelBox({ at, rot: 90, text: 'out' }, 70)
    expect(right.maxX).toBeGreaterThan(1200)
    expect(left.minX).toBeLessThan(800)
    expect(down.maxY).toBeGreaterThan(1200)
    expect(down.maxX - down.minX).toBeLessThan(down.maxY - down.minY)
  })
})
