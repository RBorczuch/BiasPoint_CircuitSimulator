import { describe, expect, it } from 'vitest'
import type { Instance, Project } from '@/api/types'
import { axisValue, traceColor } from '@/components/Digitizer'
import { parsePoints } from './points'
import { quickForm, toIdealPart, toRealPart } from './realParts'

const inst = (symbol: string, params: Record<string, string>): Instance => ({
  id: 'i1',
  ref: 'C1',
  symbol,
  model: { kind: 'builtin', model: null, params },
  at: [0, 0],
  rot: 0,
  mirror: false,
})

describe('points', () => {
  it('reads spaces, semicolons with decimal commas, CSV and SI suffixes', () => {
    expect(parsePoints('10k 0.5\n# note\n100 1,5')).toEqual([
      [100, 1.5],
      [10000, 0.5],
    ])
    expect(parsePoints('f;Z\n1,5;2,25\n2;3')).toEqual([
      [1.5, 2.25],
      [2, 3],
    ])
    expect(parsePoints('1e3,2u')).toEqual([[1000, 2e-6]])
    expect(parsePoints('1M 0.5\n10m 2')).toEqual([
      [0.01, 2],
      [1e6, 0.5],
    ])
  })
})

describe('digitizer', () => {
  it('maps pixels on linear and log axes', () => {
    expect(axisValue({ p1: 100, p2: 300, v1: '0', v2: '10', log: false }, 200)).toBe(5)
    expect(axisValue({ p1: 0, p2: 200, v1: '10', v2: '1k', log: true }, 100)).toBeCloseTo(100)
    expect(axisValue({ p1: 0, p2: null, v1: '1', v2: '2', log: false }, 5)).toBeNull()
  })

  it('traces a coloured curve column by column', () => {
    const w = 4
    const h = 5
    const data = new Uint8ClampedArray(w * h * 4).fill(255)
    const red = (x: number, y: number) => data.set([255, 0, 0, 255], (y * w + x) * 4)
    red(0, 4)
    red(1, 3)
    red(2, 2)
    red(3, 1)
    expect(traceColor(data, w, h, [255, 0, 0], 30, [0, 3], 1)).toEqual([
      [0, 4],
      [1, 3],
      [2, 2],
      [3, 1],
    ])
  })
})

describe('ideal and real parts', () => {
  it('turns the quick model into the template form', () => {
    expect(quickForm('bpt:capacitor', { C: '10u', esr: '5m', other: 'x' }, ['esr', 'esl'])).toEqual({
      Cnom: '10u',
      esr: '5m',
    })
  })

  it('replaces a part with a component, dropping its own parameters', () => {
    const commands = toRealPart('root', inst('bpt:capacitor', { C: '10u', esr: '5m' }), 'cmp:Parts/C10U')
    expect(commands[0]).toMatchObject({ type: 'update_instance', symbol: 'cmp:Parts/C10U' })
    expect(commands[1]).toMatchObject({ type: 'set_params', params: { C: null, esr: null } })
  })

  it('goes back to an ideal part with the values it can keep', () => {
    const project = {
      sheets: [
        {
          name: 'C10U',
          parameters: { Cnom: '10u', vhalf: '6.3', esr: '5m' },
          component: { kind: 'capacitor', template: { name: 'mlcc', values: {} } },
        },
      ],
    } as unknown as Project
    const out = toIdealPart('root', inst('sheet:C10U', { Cnom: '22u' }), project, () => [
      'esr',
      'esl',
      'rleak',
    ])
    expect(out?.dropped).toEqual(['vhalf'])
    expect(out?.commands[0]).toMatchObject({ symbol: 'bpt:capacitor' })
    expect(out?.commands[1]).toMatchObject({ params: { Cnom: null, C: '22u', esr: '5m' } })
  })
})
