/**
 * Filtering parts by their data (owner's request, docs/projekt-elementy.md §8): choose a category,
 * then values of its fields – texts as chips of the values the parts have, numbers as a range
 * (SPICE suffixes accepted: 10u, 4k7).
 */
import { X } from 'lucide-react'
import type { ReactNode } from 'react'
import type { SymbolDef } from '@/api/types'
import { Input } from '@/components/ui/input'
import { type DataField, type FieldFilter, fieldValue } from '@/lib/categories'

export function FilterPanel({
  paths,
  category,
  onCategory,
  fields,
  parts,
  filters,
  onFilters,
}: {
  paths: [string, number][] // categories with parts, and how many
  category: string
  onCategory: (path: string) => void
  fields: DataField[]
  parts: SymbolDef[] // the parts of the chosen category (for the values to offer)
  filters: Record<string, FieldFilter>
  onFilters: (filters: Record<string, FieldFilter>) => void
}): ReactNode {
  const set = (key: string, patch: FieldFilter) =>
    onFilters({ ...filters, [key]: { ...filters[key], ...patch } })
  const used = fields.filter((f) => parts.some((p) => fieldValue(p, f)))
  return (
    <div className="flex flex-col gap-2 rounded-md border p-2" data-testid="library-filters">
      <div className="flex items-center gap-1">
        <select
          aria-label="Filter category"
          className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1 text-xs"
          value={category}
          onChange={(e) => {
            onCategory(e.target.value)
            onFilters({})
          }}
        >
          <option value="">Any category</option>
          {paths.map(([path, n]) => (
            <option key={path} value={path}>
              {path.replace('/', ' / ')} ({n})
            </option>
          ))}
        </select>
        {Object.keys(filters).length > 0 && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="Clear the filters"
            aria-label="Clear the filters"
            onClick={() => onFilters({})}
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      {category && used.length === 0 && (
        <p className="text-[11px] text-muted-foreground">No data to filter by in this category yet.</p>
      )}
      {used.map((field) => {
        const filter = filters[field.key] ?? {}
        if (field.type === 'number')
          return (
            <div key={field.key} className="flex items-center gap-1 text-xs">
              <span className="w-20 shrink-0 truncate text-muted-foreground" title={field.label}>
                {field.label}
              </span>
              <Input
                aria-label={`${field.label} from`}
                className="h-6 w-0 min-w-0 flex-1 px-1 font-mono text-xs"
                placeholder="min"
                value={filter.min ?? ''}
                onChange={(e) => set(field.key, { min: e.target.value })}
              />
              <span className="text-muted-foreground">–</span>
              <Input
                aria-label={`${field.label} to`}
                className="h-6 w-0 min-w-0 flex-1 px-1 font-mono text-xs"
                placeholder="max"
                value={filter.max ?? ''}
                onChange={(e) => set(field.key, { max: e.target.value })}
              />
              <span className="w-8 shrink-0 text-muted-foreground">{field.unit}</span>
            </div>
          )
        const values = [...new Set(parts.map((p) => fieldValue(p, field)).filter(Boolean))].sort()
        return (
          <div key={field.key} className="flex flex-col gap-0.5 text-xs">
            <span className="text-muted-foreground">{field.label}</span>
            <div className="flex flex-wrap gap-1">
              {values.map((v) => {
                const on = filter.values?.includes(v) ?? false
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={on}
                    className={`rounded-full border px-2 py-0.5 text-[11px] ${on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-accent'}`}
                    onClick={() =>
                      set(field.key, {
                        values: on
                          ? (filter.values ?? []).filter((x) => x !== v)
                          : [...(filter.values ?? []), v],
                      })
                    }
                  >
                    {v}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
