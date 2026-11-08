import { describe, expect, it } from 'vitest'
import type { SymbolDef } from '@/api/types'
import { canBeNonIdeal, parasiticValues } from './parasitics'

const capacitor = {
  parasitics: [
    { key: 'esr', label: 'ESR', element: 'R', connection: 'series', unit: 'Ω', description: '' },
    { key: 'esl', label: 'ESL', element: 'L', connection: 'series', unit: 'H', description: '' },
  ],
} as unknown as SymbolDef

describe('parasitics', () => {
  it('lists only the parasitics that have a value', () => {
    expect(parasiticValues(capacitor, { model: { params: { esr: '10m', esl: ' ' } } as never })).toEqual([
      { label: 'ESR', text: '10 mΩ' },
    ])
  })

  it('keeps expressions as written', () => {
    expect(parasiticValues(capacitor, { model: { params: { esl: '{L0}' } } as never })).toEqual([
      { label: 'ESL', text: '{L0}' },
    ])
  })

  it('knows which parts can be non-ideal', () => {
    expect(canBeNonIdeal(capacitor)).toBe(true)
    expect(canBeNonIdeal({ parasitics: [] } as unknown as SymbolDef)).toBe(false)
    expect(canBeNonIdeal(undefined)).toBe(false)
  })
})
