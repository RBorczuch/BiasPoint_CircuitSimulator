/** Operating point results as a table (the Simulate workspace has no schematic to annotate). */
import { useMemo, useState } from 'react'
import { Input } from '@/components/ui/input'
import { formatValue, signalUnit } from '@/lib/units'
import { groupSignals } from '@/plot/format'

export function OpTable({ values }: { values: Record<string, number> }) {
  const [filter, setFilter] = useState('')
  const groups = useMemo(() => groupSignals(Object.keys(values), null), [values])
  const f = filter.trim().toLowerCase()
  return (
    <div className="flex h-full flex-col gap-2 overflow-hidden p-3 text-sm" data-testid="op-table">
      <div className="flex items-center gap-3">
        <p className="font-medium">Operating point</p>
        <p className="text-xs text-muted-foreground">DC voltages of the nets and currents of the parts</p>
        <Input
          aria-label="Filter operating point values"
          placeholder="Filter (net or part)…"
          className="ml-auto h-7 w-56"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="grid grid-cols-[repeat(auto-fill,minmax(16rem,1fr))] gap-x-6">
          {groups.map((group) => {
            const rows = group.signals.filter((name) => !f || name.toLowerCase().includes(f))
            if (!rows.length) return null
            return (
              <div key={group.title} className="mb-3">
                <p className="pb-1 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                  {group.title}
                </p>
                <table className="w-full font-mono text-xs">
                  <tbody>
                    {rows.map((name) => (
                      <tr key={name} className="border-b border-border/50">
                        <td className="py-0.5 pr-3">{name}</td>
                        <td className="py-0.5 text-right">
                          {formatValue(values[name], signalUnit(name), 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
