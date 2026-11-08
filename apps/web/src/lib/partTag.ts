/**
 * The small tag under a part's value (FR-CMP-5): "ideal", "real · ESR, ESL" (an ideal part
 * given a simple model in the inspector) or the name of a library part. Null: no tag.
 */
import type { Instance, SymbolDef } from '@/api/types'
import { canBeNonIdeal, parasiticValues } from './parasitics'

export function partTag(symbol: SymbolDef, inst: Instance): { text: string; real: boolean } | null {
  if (symbol.category === 'Components') return { text: symbol.name, real: true } // a library part
  if (!canBeNonIdeal(symbol)) return null
  const values = parasiticValues(symbol, inst)
  return values.length
    ? { text: `real · ${values.map((v) => v.label).join(', ')}`, real: true }
    : { text: 'ideal', real: false }
}
