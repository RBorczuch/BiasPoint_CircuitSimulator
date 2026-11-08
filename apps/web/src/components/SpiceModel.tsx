/**
 * The part editor's "SPICE model" kind: a manufacturer's .model / .subckt pasted as text, checked,
 * drawn as a symbol with its pins mapped – the same steps as importing a model file, for one part.
 */
import { AlertTriangle } from 'lucide-react'
import { useState } from 'react'
import { apiPost } from '@/api/client'
import { defaultMap, GENERIC, type Suggestion } from '@/app/SpiceImportDialog'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useProject } from '@/store/project'
import { SymbolPreview } from './SymbolPreview'

export interface SpiceChoice {
  item: Suggestion
  symbol: string // a symbol id or GENERIC (a box with the model's pins)
  pinMap: string[] // symbol pins in the order of the subcircuit pins
}

/** The choice as the import endpoint takes it; null while a pin is not chosen. */
export function spiceItem(
  choice: SpiceChoice | null,
): { name: string; symbol: string; pin_map: string[] } | null {
  if (!choice || choice.item.encrypted) return null
  const generic = choice.symbol === GENERIC
  if (choice.item.kind === 'subckt' && !generic && choice.pinMap.some((p) => !p)) return null
  return {
    name: choice.item.name,
    symbol: choice.symbol,
    pin_map: generic ? choice.item.pins : choice.pinMap,
  }
}

export function SpiceModelPage({
  text,
  onText,
  choice,
  onChoice,
}: {
  text: string
  onText: (text: string) => void
  choice: SpiceChoice | null
  onChoice: (choice: SpiceChoice | null) => void
}) {
  const symbols = useProject((s) => s.symbols)
  const [items, setItems] = useState<Suggestion[] | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const choices = [...symbols.values()].filter((s) => s.id.startsWith('bpt:') && s.spice && s.pins.length > 1)
  const check = async () => {
    setError(null)
    try {
      const preview = await apiPost<{ dialect: string; notes: string[]; items: Suggestion[] }>(
        '/api/library/import/spice/preview',
        { text },
      )
      setItems(preview.items)
      setNotes([`${preview.dialect} syntax, converted for ngspice`, ...preview.notes])
      const first = preview.items.find((i) => !i.encrypted)
      onChoice(first ? { item: first, symbol: first.symbol, pinMap: first.pin_map } : null)
      if (!preview.items.length) setError('No .model or .subckt found in the text')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const symbol = choice && choice.symbol !== GENERIC ? symbols.get(choice.symbol) : undefined
  return (
    <div
      className="grid min-h-0 flex-1 grid-cols-[minmax(20rem,1fr)_minmax(18rem,1fr)] gap-4 overflow-hidden p-4"
      data-testid="spice-model"
    >
      <div className="flex min-h-0 flex-col gap-2">
        <p className="text-xs text-muted-foreground">
          Paste the manufacturer's model (.model or .subckt, PSpice and LTspice syntax are converted).
        </p>
        <Textarea
          aria-label="SPICE model text"
          className="min-h-0 flex-1 font-mono text-xs"
          placeholder={'.SUBCKT OPA1 IN+ IN- VCC VEE OUT\n…\n.ENDS'}
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
        <Button size="sm" className="self-start" disabled={!text.trim()} onClick={() => void check()}>
          Check the model
        </Button>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>
      <div className="flex min-h-0 flex-col gap-2 overflow-y-auto text-sm">
        {notes.map((note) => (
          <p key={note} className="flex items-center gap-1 text-xs text-muted-foreground">
            <AlertTriangle className="size-3" /> {note}
          </p>
        ))}
        {items && items.length > 1 && (
          <select
            aria-label="Model of the part"
            className="h-8 rounded-md border bg-background px-2"
            value={choice?.item.name ?? ''}
            onChange={(e) => {
              const item = items.find((i) => i.name === e.target.value)
              if (item) onChoice({ item, symbol: item.symbol, pinMap: item.pin_map })
            }}
          >
            {items.map((i) => (
              <option key={i.name} value={i.name} disabled={i.encrypted}>
                {i.name} {i.encrypted ? '(encrypted)' : `– ${i.summary}`}
              </option>
            ))}
          </select>
        )}
        {choice && (
          <>
            <p>
              <span className="font-medium">{choice.item.name}</span>{' '}
              <span className="font-mono text-xs text-muted-foreground">{choice.item.summary}</span>
            </p>
            <div className="flex items-center gap-2">
              {symbol && <SymbolPreview symbol={symbol} size={40} />}
              <select
                aria-label="Symbol of the part"
                className="h-8 rounded-md border bg-background px-2"
                value={choice.symbol}
                onChange={(e) =>
                  onChoice({
                    ...choice,
                    symbol: e.target.value,
                    pinMap:
                      e.target.value === choice.item.symbol
                        ? choice.item.pin_map
                        : defaultMap(symbols.get(e.target.value), choice.item.pins),
                  })
                }
              >
                {choice.item.kind === 'subckt' && <option value={GENERIC}>Box with the model's pins</option>}
                {choices.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </div>
            {choice.item.kind === 'subckt' && symbol && (
              <div className="flex flex-col gap-1">
                <p className="text-xs text-muted-foreground">Each pin of the model on a pin of the symbol:</p>
                {choice.item.pins.map((pin, i) => (
                  <label key={pin} className="flex items-center gap-2 font-mono text-xs">
                    <span className="w-24">{pin}</span>→
                    <select
                      aria-label={`Model pin ${pin}`}
                      className={`h-7 rounded border bg-background px-1 ${choice.pinMap[i] ? '' : 'border-destructive'}`}
                      value={choice.pinMap[i] ?? ''}
                      onChange={(e) =>
                        onChoice({
                          ...choice,
                          pinMap: choice.pinMap.map((p, j) => (j === i ? e.target.value : p)),
                        })
                      }
                    >
                      <option value="">?</option>
                      {symbol.pins.map((p) => (
                        <option key={p.number} value={p.number}>
                          {p.name || p.number}
                        </option>
                      ))}
                      <option value="=0">ground</option>
                    </select>
                  </label>
                ))}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              Saving adds the model and the part to the library named above; its data (Data page) go with it.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
