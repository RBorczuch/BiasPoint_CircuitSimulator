/** Non-ideal properties of parts (ESR, ESL, DCR...): which ones a part has set. */
import type { Instance, SymbolDef } from '@/api/types'
import { formatValue, parseValue } from './units'

export interface ParasiticValue {
  label: string
  text: string // "10 mΩ" (or the raw text for expressions)
}

/** Parasitics with a value on this instance; empty list = ideal part. */
export function parasiticValues(symbol: SymbolDef, inst: Pick<Instance, 'model'>): ParasiticValue[] {
  return (symbol.parasitics ?? []).flatMap((p) => {
    const raw = inst.model.params[p.key]?.trim()
    if (!raw) return []
    const value = parseValue(raw)
    return [{ label: p.label, text: value === null ? raw : formatValue(value, p.unit, 3) }]
  })
}

/** Does the part offer parasitics at all (ideal vs non-ideal only makes sense then)? */
export const canBeNonIdeal = (symbol: SymbolDef | undefined): boolean => (symbol?.parasitics?.length ?? 0) > 0
