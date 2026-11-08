/**
 * A manufacturer's model pasted for a part (FR-MOD-7, Interfejs.md §8): the text (any dialect)
 * is converted for ngspice and each model in it tried in the simulator, so a model that does not
 * read says why and on which line, before the part uses it.
 */
import { AlertTriangle, Check, X } from 'lucide-react'
import { useState } from 'react'
import { apiPost } from '@/api/client'
import type { ModelCard, SubcktModel } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

export interface CheckedModel {
  name: string
  kind: 'model' | 'subckt'
  type: string
  pins: string[]
  summary: string
  encrypted: boolean
  notes: string[]
  card: ModelCard | null
  subckt: SubcktModel | null
  check: string // what ngspice said ("" = it simulates)
  checked: boolean
}

export function PasteModel({
  open,
  onOpenChange,
  fits,
  taken,
  onUse,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Why a model cannot be this part's ("" = it can). */
  fits: (item: CheckedModel) => string
  /** Models of the project already: the pasted one of that name replaces it. */
  taken: (name: string) => boolean
  onUse: (item: CheckedModel) => void
}) {
  const [text, setText] = useState('')
  const [items, setItems] = useState<CheckedModel[] | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [chosen, setChosen] = useState('')
  const check = async () => {
    setBusy(true)
    setError('')
    try {
      const result = await apiPost<{ dialect: string; notes: string[]; items: CheckedModel[] }>(
        '/api/components/models/check',
        { text },
      )
      setItems(result.items)
      setNotes([`${result.dialect} syntax, converted for ngspice`, ...result.notes])
      const usable = result.items.find((i) => !i.encrypted && !i.check && !fits(i))
      setChosen(usable?.name ?? result.items[0]?.name ?? '')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const item = items?.find((i) => i.name === chosen)
  const why = item ? (item.encrypted ? 'encrypted: ngspice cannot read it' : item.check || fits(item)) : ''
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="paste-model">
        <DialogHeader>
          <DialogTitle>Paste a model</DialogTitle>
          <DialogDescription>
            A .model or .subckt from the manufacturer (PSpice and LTspice syntax are converted). Each model is
            tried in the simulator first.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="Model text"
          className="h-44 font-mono text-xs"
          placeholder={'.model D1N4148 D(IS=2.52n N=1.752 RS=0.568 ...)'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            setItems(null)
          }}
        />
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!text.trim() || busy} onClick={() => void check()}>
            {busy ? 'Checking…' : 'Check'}
          </Button>
          {error && <span className="text-xs text-destructive">{error}</span>}
        </div>
        {items && (
          <div className="flex flex-col gap-1 text-xs" data-testid="paste-model-items">
            {notes.map((note) => (
              <p key={note} className="flex items-center gap-1 text-muted-foreground">
                <AlertTriangle className="size-3 shrink-0" /> {note}
              </p>
            ))}
            {items.map((i) => {
              const problem = i.encrypted ? 'encrypted' : i.check
              return (
                <label
                  key={i.name}
                  className={`flex items-start gap-2 rounded border px-2 py-1 ${chosen === i.name ? 'border-primary bg-accent/40' : ''}`}
                >
                  <input
                    type="radio"
                    name="pasted-model"
                    className="mt-0.5"
                    checked={chosen === i.name}
                    onChange={() => setChosen(i.name)}
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="flex items-center gap-1 font-medium">
                      {problem ? (
                        <X className="size-3 text-destructive" />
                      ) : i.checked ? (
                        <Check className="size-3 text-emerald-600" />
                      ) : null}
                      {i.summary}
                      {taken(i.name) && (
                        <span className="font-normal text-amber-600"> – replaces the project’s {i.name}</span>
                      )}
                    </span>
                    {problem && <span className="text-destructive">{problem}</span>}
                    {!problem && !i.checked && (
                      <span className="text-muted-foreground">Not tried: no test circuit for a {i.type}</span>
                    )}
                    {i.notes.map((n) => (
                      <span key={n} className="text-muted-foreground">
                        {n}
                      </span>
                    ))}
                  </span>
                </label>
              )
            })}
          </div>
        )}
        <div className="flex items-center justify-end gap-2">
          {item && why && <span className="text-xs text-destructive">{why}</span>}
          <Button
            size="sm"
            disabled={!item || Boolean(why)}
            onClick={() => {
              if (!item) return
              onUse(item)
              onOpenChange(false)
            }}
          >
            Use for this part
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
