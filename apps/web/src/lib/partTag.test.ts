import { describe, expect, it } from 'vitest'
import type { Instance, SymbolDef } from '@/api/types'
import { partTag } from './partTag'

const capacitor = {
  id: 'bpt:capacitor',
  name: 'Capacitor',
  category: 'Passive',
  parasitics: [
    { key: 'esr', label: 'ESR', element: 'R', connection: 'series', unit: 'Ω', description: '' },
    { key: 'esl', label: 'ESL', element: 'L', connection: 'series', unit: 'H', description: '' },
  ],
} as unknown as SymbolDef
const part = (params: Record<string, string>) => ({ model: { params } }) as unknown as Instance

describe('part tags', () => {
  it('says ideal, real (with what is set) or the library part', () => {
    expect(partTag(capacitor, part({ C: '1u' }))).toEqual({ text: 'ideal', real: false })
    expect(partTag(capacitor, part({ C: '1u', esr: '50m' }))).toEqual({ text: 'real · ESR', real: true })
    const component = { ...capacitor, name: 'GRM188', category: 'Components', parasitics: [] }
    expect(partTag(component as SymbolDef, part({}))).toEqual({ text: 'GRM188', real: true })
    expect(partTag({ ...capacitor, parasitics: [] } as SymbolDef, part({}))).toBeNull()
  })
})
