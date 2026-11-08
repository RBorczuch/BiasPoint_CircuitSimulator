/**
 * The card of a parameter (docs/projekt-kreator.md §4.2): hovering its name (or clicking it, or
 * Enter on it) shows what it is, what it does to the curves, where the datasheet gives it, its
 * typical range, where its value came from, the limits for the fit and the nearest E24 value.
 */
import { type ReactNode, useState } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import type { ParamInfo } from '@/lib/paramHelp'

export function ParamHelp({
  fieldKey,
  label,
  unit,
  info,
  description,
  help,
  value,
  origin,
  range,
  limits,
  onLimits,
  e24,
  onOpenChange,
  children,
}: {
  fieldKey: string
  label: string
  unit: string
  info?: ParamInfo
  description?: string
  help?: string // the template author's own words
  value: string
  origin?: string // where the value came from, in words
  range?: string // the template's own range ("≥ 1n, ≤ 10u")
  limits?: [string, string] // the fit's limits
  onLimits?: (limits: [string, string]) => void
  e24?: { text: string; apply: () => void } | null
  onOpenChange?: (open: boolean) => void
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const change = (next: boolean) => {
    setOpen(next)
    onOpenChange?.(next)
  }
  const title = info?.name ?? description
  return (
    <HoverCard open={open} onOpenChange={change}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 truncate text-left text-muted-foreground underline decoration-muted-foreground/40 decoration-dotted underline-offset-2 hover:text-foreground"
          aria-label={`About ${label}`}
          aria-expanded={open}
          onClick={() => change(true)}
        >
          {children}
        </button>
      </HoverCardTrigger>
      <HoverCardContent data-testid={`param-help-${fieldKey}`} onEscapeKeyDown={() => change(false)}>
        <div className="flex items-baseline gap-2">
          <span className="font-mono font-semibold">{label}</span>
          {title && <span className="font-medium">– {title}</span>}
          {unit && <span className="ml-auto text-muted-foreground">{unit}</span>}
        </div>
        {(info?.help ?? (info ? description : undefined)) && (
          <p className="mt-1.5">{info?.help ?? description}</p>
        )}
        {help && <p className="mt-1.5">{help}</p>}
        {!info && !description && !help && (
          <p className="mt-1.5 text-muted-foreground">A parameter of this model.</p>
        )}
        {info?.effect && (
          <p className="mt-1.5">
            <span className="text-muted-foreground">On the curves: </span>
            {info.effect}
            {info.chart && (
              <span className="text-amber-600 dark:text-amber-400"> (highlighted on {info.chart})</span>
            )}
          </p>
        )}
        {info?.datasheet && (
          <p className="mt-1.5">
            <span className="text-muted-foreground">From the datasheet: </span>
            {info.datasheet}
          </p>
        )}
        {info?.typical && (
          <p className="mt-1.5">
            <span className="text-muted-foreground">Typical: </span>
            {info.typical}
          </p>
        )}
        <div className="mt-2 border-t pt-2">
          <p>
            <span className="text-muted-foreground">Value: </span>
            <span className="font-mono">{value.trim() || 'none'}</span>
            {origin && <span className="text-muted-foreground"> · {origin}</span>}
          </p>
          {range && (
            <p>
              <span className="text-muted-foreground">Accepted: </span>
              {range}
            </p>
          )}
          {onLimits && (
            <div className="mt-1 flex items-center gap-1">
              <span className="text-muted-foreground">Fit within</span>
              {(['min', 'max'] as const).map((side, k) => (
                <Input
                  key={side}
                  aria-label={`${side === 'min' ? 'Minimum' : 'Maximum'} of ${label}`}
                  className="h-6 w-20 font-mono text-xs"
                  placeholder={side}
                  value={limits?.[k] ?? ''}
                  onChange={(e) => {
                    const pair: [string, string] = [...(limits ?? ['', ''])] as [string, string]
                    pair[k] = e.target.value
                    onLimits(pair)
                  }}
                />
              ))}
            </div>
          )}
          {e24 && (
            <button
              type="button"
              className="mt-1 rounded border px-1.5 py-0.5 hover:bg-accent"
              onClick={e24.apply}
            >
              Use E24 {e24.text}
            </button>
          )}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
