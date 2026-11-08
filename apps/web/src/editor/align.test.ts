import { describe, expect, it } from 'vitest'
import type { Sheet, SymbolDef } from '@/api/types'
import { alignCommands, alignDeltas } from './align'
import { pinPositions } from './geometry'
import { previewSheet } from './preview'

const resistor = {
  id: 'r',
  graphics: [{ kind: 'rect', start: [-102, -254], end: [102, 254], fill: false }],
  pins: [
    { number: '1', name: '', at: [0, -381], length: 127, orientation: 'up', type: 'passive' },
    { number: '2', name: '', at: [0, 381], length: 127, orientation: 'down', type: 'passive' },
  ],
} as unknown as SymbolDef
const symbols = new Map([['r', resistor]])
const part = (id: string, at: [number, number]) => ({
  id,
  ref: id,
  symbol: 'r',
  at,
  rot: 0,
  mirror: false,
  model: { params: {} },
})

describe('align', () => {
  it('moves parts by whole grid steps', () => {
    const boxes = new Map([
      ['a', { minX: 0, minY: 0, maxX: 100, maxY: 100 }],
      ['b', { minX: 500, minY: 254, maxX: 600, maxY: 354 }],
    ])
    expect(alignDeltas(boxes, 'top')).toEqual(new Map([['b', [0, -254]]]))
    expect([...alignDeltas(boxes, 'left').keys()]).toEqual(['b'])
  })

  it('keeps wires on the pins of moved parts', () => {
    const sheet = {
      name: 'root',
      instances: [part('R1', [0, 0]), part('R2', [1270, 254])],
      wires: [
        {
          id: 'w',
          points: [
            [0, 381],
            [1270, -127],
          ],
        },
      ],
      labels: [],
      junctions: [],
      directives: [],
    } as unknown as Sheet
    const commands = alignCommands('root', sheet, symbols, new Set(['R1', 'R2']), 'top')
    expect(commands[0]).toEqual({ type: 'move_objects', sheet: 'root', ids: ['R2'], dx: 0, dy: -254 })
    const after = previewSheet(sheet, new Set(['R2']), [0, -254], true, symbols)
    const r2 = after.instances.find((i) => i.id === 'R2')
    const wire = commands.find((c) => c.type === 'set_wire_points')
    expect(r2).toBeDefined()
    if (r2) expect(wire && 'points' in wire && wire.points.at(-1)).toEqual(pinPositions(resistor, r2)[0].at)
    expect(alignCommands('root', sheet, symbols, new Set(['R1']), 'top')).toEqual([]) // one part
  })
})
