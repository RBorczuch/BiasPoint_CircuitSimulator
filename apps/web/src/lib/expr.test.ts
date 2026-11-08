import { describe, expect, it } from 'vitest'
import type { Project } from '@/api/types'
import { evaluate, numberOf, sheetScope } from './expr'

describe('evaluate', () => {
  it('computes parameter expressions like ngspice', () => {
    expect(evaluate('1k*(vout/1.23-1)', { vout: 5 })).toBeCloseTo(3065.04, 1)
    expect(evaluate('10u*tss/vref', { tss: 1e-3, vref: 1.23 })).toBeCloseTo(8.13e-9, 11)
    expect(evaluate('2^3 + -1', {})).toBe(7)
    expect(evaluate('sqrt(4)*pi', {})).toBeCloseTo(2 * Math.PI)
    expect(evaluate('1meg/1k', {})).toBe(1000)
  })

  it('gives null for what it cannot know', () => {
    expect(evaluate('V(out)*2', {})).toBeNull()
    expect(evaluate('nope*2', {})).toBeNull()
    expect(evaluate('(1+2', {})).toBeNull()
  })

  it('reads plain values and expressions', () => {
    expect(numberOf('4k7', {})).toBe(4700)
    expect(numberOf('{R*2}', { r: 5 })).toBe(10)
  })
})

describe('sheetScope', () => {
  const block = (name: string, parameters: Record<string, string>, instances = []) => ({
    name,
    parameters,
    instances,
  })
  const project = {
    parameters: { vin: '12' },
    sheets: [
      block('root', {}, [
        { ref: 'U1', symbol: 'sheet:mod', model: { params: { vout: '{vin/4}' } } },
      ] as never),
      block('mod', { vout: '5', gain: '{vout*2}' }),
    ],
  } as unknown as Project

  it('follows the block path: overrides read in the outer scope', () => {
    expect(sheetScope(project, 'mod', ['U1']).vout).toBe(3)
  })

  it('uses the defaults without a path', () => {
    const scope = sheetScope(project, 'mod', null)
    expect(scope.vout).toBe(5)
    expect(scope.gain).toBe(10)
  })
})
