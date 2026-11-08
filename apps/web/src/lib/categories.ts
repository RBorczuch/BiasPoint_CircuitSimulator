/**
 * Categories of parts (docs/projekt-elementy.md §3): the library tree, the data a part of a
 * category is described by, its key parameters (hover card) and the parametric filter.
 */
import { useQuery } from '@tanstack/react-query'
import { apiGet } from '@/api/client'
import type { SymbolDef } from '@/api/types'
import { parseValue } from './units'

export interface DataField {
  key: string
  label: string
  type: 'text' | 'enum' | 'number'
  unit: string
  options: string[]
  source: 'metadata' | 'ratings'
}

export interface CategoryInfo {
  path: string
  fields: DataField[]
}

export function useCategories(): CategoryInfo[] {
  const { data = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: () => apiGet<CategoryInfo[]>('/api/library/categories'),
    staleTime: Number.POSITIVE_INFINITY,
  })
  return data
}

export const topOf = (path: string): string => path.split('/')[0]
export const subOf = (path: string): string | null => path.split('/')[1] ?? null

/** Fields of a category; a top category without its own takes those of its first child. */
export function fieldsOf(categories: CategoryInfo[], path: string): DataField[] {
  return categories.find((c) => c.path === path)?.fields ?? []
}

/** A part's value of a data field ("" = not given). */
export function fieldValue(symbol: SymbolDef, field: Pick<DataField, 'key' | 'source'>): string {
  const from = field.source === 'ratings' ? symbol.ratings : symbol.metadata
  return (from?.[field.key] ?? '').trim()
}

/** The part's main value as it is placed (10k, 100n, LM358). */
export function mainValue(symbol: SymbolDef): string {
  if (symbol.value_param) return symbol.default_params[symbol.value_param] ?? ''
  return symbol.default_model ?? ''
}

/** The parameters shown on a part's hover card and under its name: value, then its category's. */
export function keyParams(symbol: SymbolDef, fields: DataField[]): [string, string][] {
  const out: [string, string][] = []
  const value = mainValue(symbol)
  if (value) out.push(['Value', value])
  for (const field of fields) {
    if (field.key === 'part_number') continue // the name says it
    const v = fieldValue(symbol, field)
    if (v) out.push([field.label, field.unit && /[0-9]$/.test(v) ? `${v} ${field.unit}` : v])
  }
  const technology = symbol.metadata?.technology
  if (technology && !out.some(([label]) => label === 'Technology')) out.push(['Technology', technology])
  return out
}

/** Short line under a part's name in the list: value and two key data. */
export function subtitle(symbol: SymbolDef, fields: DataField[]): string {
  return keyParams(symbol, fields)
    .filter(([label]) => label !== 'Technology')
    .slice(0, 3)
    .map(([, v]) => v)
    .join(' · ')
}

/** A filter on one field: chosen texts, or a numeric range (both ends optional). */
export interface FieldFilter {
  values?: string[]
  min?: string
  max?: string
}

/** Numbers in a value: "200-450" -> [200, 450], "16" -> [16, 16], "4.7u" -> [4.7e-6, ...]. */
function range(text: string): [number, number] | null {
  const parts = text
    .split(/\s*(?:-|to|…|\.\.)\s*(?=[0-9.])/)
    .map((t) => parseValue(t.trim()))
    .filter((v): v is number => v !== null)
  if (!parts.length) return null
  return [Math.min(...parts), Math.max(...parts)]
}

export function matches(
  symbol: SymbolDef,
  fields: DataField[],
  filters: Record<string, FieldFilter>,
): boolean {
  for (const [key, filter] of Object.entries(filters)) {
    const field = fields.find((f) => f.key === key)
    if (!field) continue
    const value = fieldValue(symbol, field)
    if (filter.values?.length && !filter.values.includes(value)) return false
    const lo = filter.min?.trim() ? parseValue(filter.min) : null
    const hi = filter.max?.trim() ? parseValue(filter.max) : null
    if (lo !== null || hi !== null) {
      const r = range(value)
      if (!r) return false
      if (lo !== null && r[1] < lo) return false
      if (hi !== null && r[0] > hi) return false
    }
  }
  return true
}
