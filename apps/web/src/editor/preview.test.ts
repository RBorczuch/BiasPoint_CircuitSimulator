import { describe, expect, it } from 'vitest'
import type { Point } from '@/api/types'
import { transform } from './geometry'
import { mirroredRotation, moveWireEnd, moveWireSegment, transformCommands } from './preview'

const P = (...pts: Point[]) => pts

describe('wire editing', () => {
  it('drags a single segment into a U, keeping both ends', () => {
    expect(moveWireSegment(P([0, 0], [500, 0]), 0, [40, 127])).toEqual(
      P([0, 0], [0, 127], [500, 127], [500, 0]),
    )
  })

  it('drags a middle segment without extra corners', () => {
    const wire = P([0, 0], [0, 254], [500, 254], [500, 508])
    expect(moveWireSegment(wire, 1, [0, 127])).toEqual(P([0, 0], [0, 381], [500, 381], [500, 508]))
  })

  it('moves an end with a corner that keeps the last direction', () => {
    expect(moveWireEnd(P([0, 0], [500, 0]), 'end', [127, 254])).toEqual(P([0, 0], [627, 0], [627, 254]))
    expect(moveWireEnd(P([0, 0], [500, 0]), 'start', [-127, 0])).toEqual(P([-127, 0], [500, 0]))
  })
})

describe('transformCommands', () => {
  const inst = (id: string, at: Point, rot: 0 | 90 | 180 | 270 = 0) => ({
    id,
    ref: id,
    symbol: 'bpt:resistor',
    model: { kind: 'builtin' as const, model: null, params: {} },
    at,
    rot,
    mirror: false,
  })
  const sheet = (instances: ReturnType<typeof inst>[]) => ({
    id: 's',
    name: 'root',
    instances,
    wires: [],
    junctions: [],
    labels: [],
    directives: [],
  })

  it('rotates a group around its centre', () => {
    const s = sheet([inst('a', [0, 0]), inst('b', [254, 0])])
    const cmds = transformCommands('root', s, new Set(['a', 'b']), 'rotate')
    expect(cmds).toEqual([
      { type: 'update_instance', sheet: 'root', id: 'a', at: [127, -127], rot: 90 },
      { type: 'update_instance', sheet: 'root', id: 'b', at: [127, 127], rot: 90 },
    ])
  })

  it('mirrors a rotated part consistently with transform()', () => {
    const part = inst('a', [0, 0], 90)
    const [cmd] = transformCommands('root', sheet([part]), new Set(['a']), 'mirrorX')
    expect(cmd).toMatchObject({ rot: 270, mirror: true })
    // A pin at (0,-381) must land mirrored in x: compare world positions before / after.
    const before = transform([0, -381], part)
    const after = transform([0, -381], { at: [0, 0], rot: 270, mirror: true })
    expect(after).toEqual([-before[0], before[1]])
  })
})

describe('mirroring a rotated part', () => {
  it('flips about the screen axis at every rotation', () => {
    const p: Point = [3, 1]
    for (const rot of [0, 90, 180, 270] as const)
      for (const mirror of [false, true]) {
        const [x, y] = transform(p, { at: [0, 0], rot, mirror })
        const flipX = transform(p, { at: [0, 0], rot: mirroredRotation(rot, 'mirrorX'), mirror: !mirror })
        const flipY = transform(p, { at: [0, 0], rot: mirroredRotation(rot, 'mirrorY'), mirror: !mirror })
        expect(flipX).toEqual([-x, y])
        expect(flipY).toEqual([x, -y])
      }
  })
})
