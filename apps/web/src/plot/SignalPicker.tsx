/** Signal browser: pick run signals by net name or part interface, or type an expression. */
import { useMemo, useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import { useSimulation } from '@/store/simulation'
import { groupSignals } from './format'

export function SignalPicker({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const meta = useSimulation((s) => s.meta)
  const traces = useSimulation((s) => s.traces)
  const addTrace = useSimulation((s) => s.addTrace)
  const [query, setQuery] = useState('')
  const groups = useMemo(() => groupSignals(meta?.signals.map((s) => s.name) ?? [], meta?.scale), [meta])
  const shown = new Set(traces.map((t) => t.expr.toLowerCase()))
  const pick = (expr: string) => {
    addTrace(expr)
    setQuery('')
    onOpenChange(false)
  }
  const typed = query.trim()
  const isExpression = /[()+\-*/]/.test(typed)
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add signal"
      description="Nets by name, part currents, or an expression"
    >
      <CommandInput
        placeholder="Signal or expression, e.g. out, I(R1), V(out)/V(in)…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>{meta ? 'No such signal.' : 'Run an analysis first.'}</CommandEmpty>
        {typed && isExpression && (
          <CommandGroup heading="Expression">
            <CommandItem value={`expression ${typed}`} onSelect={() => pick(typed)}>
              Plot <span className="font-mono">{typed}</span>
            </CommandItem>
          </CommandGroup>
        )}
        {groups.map((group) => (
          <CommandGroup key={group.title} heading={group.title}>
            {group.signals.map((name) => (
              <CommandItem key={name} value={name} onSelect={() => pick(name)} className="font-mono">
                {name}
                {shown.has(name.toLowerCase()) && <CommandShortcut>plotted</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
