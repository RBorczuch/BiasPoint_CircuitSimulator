/**
 * Import of manufacturer SPICE models: choose the models of a file, the symbol each one is
 * drawn with and, for subcircuits, which symbol pin goes to which subcircuit pin. The result is
 * a user library with one ready-to-place part per model.
 */
import { AlertTriangle, Lock } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiPost } from '@/api/client'
import type { SymbolDef } from '@/api/types'
import { openComponentWizard } from '@/components/ComponentWizard'
import { SymbolPreview } from '@/components/SymbolPreview'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { pickProjectPath } from '@/store/dialogs'
import { reloadLibrary, useProject } from '@/store/project'

export interface Suggestion {
  name: string
  kind: 'model' | 'subckt'
  type: string
  pins: string[]
  summary: string
  encrypted: boolean
  notes: string[]
  symbol: string
  pin_map: string[]
}

interface Preview {
  dialect: string
  notes: string[]
  items: Suggestion[]
}

interface Row {
  use: boolean
  symbol: string
  pinMap: string[]
}

export const GENERIC = 'generic'

const useSpiceImport = create<{ path: string | null; set: (path: string | null) => void }>((set) => ({
  path: null,
  set: (path) => set({ path }),
}))

export async function importSpiceModels(): Promise<void> {
  const path = await pickProjectPath({ mode: 'spice' })
  if (path) useSpiceImport.getState().set(path)
}

const fileName = (path: string) => path.split(/[\\/]/).pop() ?? path

/** Symbol pins in the order of the subcircuit pins: by name, else in the symbol's order. */
export function defaultMap(symbol: SymbolDef | undefined, pins: string[]): string[] {
  if (!symbol) return [...pins]
  const byName = new Map<string, string>()
  for (const pin of symbol.pins) {
    if (pin.name) byName.set(pin.name.toLowerCase(), pin.number)
    byName.set(pin.number.toLowerCase(), pin.number)
  }
  const named = pins.map((p) => byName.get(p.toLowerCase()))
  if (named.every(Boolean)) return named as string[]
  return pins.map((_p, i) => symbol.pins[i]?.number ?? '')
}

export function SpiceImportDialog() {
  const path = useSpiceImport((s) => s.path)
  const close = () => useSpiceImport.getState().set(null)
  const symbols = useProject((s) => s.symbols)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [rows, setRows] = useState<Record<string, Row>>({})
  const [library, setLibrary] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const choices = useMemo(
    () => [...symbols.values()].filter((s) => s.id.startsWith('bpt:') && s.spice && s.pins.length > 1),
    [symbols],
  )

  useEffect(() => {
    if (!path) return
    setPreview(null)
    setError(null)
    setLibrary(fileName(path).replace(/\.[^.]+$/, ''))
    apiPost<Preview>('/api/library/import/spice/preview', { path }).then(
      (result) => {
        setPreview(result)
        setRows(
          Object.fromEntries(
            result.items.map((item) => [
              item.name,
              { use: !item.encrypted, symbol: item.symbol, pinMap: item.pin_map },
            ]),
          ),
        )
      },
      (e) => setError(e instanceof Error ? e.message : String(e)),
    )
  }, [path])

  if (!path) return null
  const chosen = preview?.items.filter((item) => rows[item.name]?.use) ?? []
  const incomplete = chosen.filter(
    (item) =>
      item.kind === 'subckt' &&
      rows[item.name].symbol !== GENERIC &&
      rows[item.name].pinMap.some((pin) => !pin),
  )
  const update = (name: string, row: Partial<Row>) =>
    setRows((r) => ({ ...r, [name]: { ...r[name], ...row } }))

  const run = async () => {
    setBusy(true)
    try {
      const report = await apiPost<{
        library: string
        imported: number
        skipped: string[]
        parts?: string[]
      }>('/api/library/import/spice', {
        path,
        library,
        items: chosen.map((item) => ({
          name: item.name,
          symbol: rows[item.name].symbol,
          pin_map: rows[item.name].symbol === GENERIC ? item.pins : rows[item.name].pinMap,
        })),
      })
      await reloadLibrary()
      toast.success(
        `Library “${report.library}”: ${report.imported} parts – find them in the Library panel` +
          (report.skipped.length ? ` (${report.skipped.length} skipped)` : ''),
        {
          duration: 10000,
          description:
            'Each one is a real part in its category, with a card; add its data in the part editor.',
          action: report.parts?.length
            ? {
                label: 'Add its data',
                onClick: () => openComponentWizard({ edit: report.parts?.[0], page: 'data' }),
              }
            : undefined,
        },
      )
      close()
    } catch (e) {
      toast.error(`Import failed: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import SPICE models – {fileName(path)}</DialogTitle>
          <DialogDescription>
            {preview
              ? `${preview.items.length} models (${preview.dialect} syntax, converted for ngspice). Each becomes a part in the library: the symbol drawn on the schematic with this model.`
              : error
                ? 'The file could not be read.'
                : 'Reading the file…'}
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {preview?.notes.map((note) => (
          <p key={note} className="flex items-center gap-1 text-xs text-amber-500">
            <AlertTriangle className="size-3" /> {note}
          </p>
        ))}
        {preview && (
          <div className="min-h-0 flex-1 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 p-2" />
                  <th className="p-2">Model</th>
                  <th className="p-2">Symbol</th>
                  <th className="p-2">Pins (subcircuit → symbol)</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((item) => {
                  const row = rows[item.name]
                  if (!row) return null
                  const symbol = symbols.get(row.symbol)
                  return (
                    <tr key={item.name} className="border-t align-top">
                      <td className="p-2">
                        <input
                          type="checkbox"
                          aria-label={`Import ${item.name}`}
                          checked={row.use}
                          disabled={item.encrypted}
                          onChange={(e) => update(item.name, { use: e.target.checked })}
                        />
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-1 font-medium">
                          {item.encrypted && <Lock className="size-3" />}
                          {item.name}
                        </div>
                        <div className="font-mono text-[11px] text-muted-foreground">{item.summary}</div>
                        {item.notes.slice(0, 3).map((note) => (
                          <div key={note} className="text-[11px] text-amber-500">
                            {note}
                          </div>
                        ))}
                      </td>
                      <td className="p-2">
                        <div className="flex items-center gap-2">
                          {symbol && <SymbolPreview symbol={symbol} size={24} />}
                          <select
                            aria-label={`Symbol for ${item.name}`}
                            className="h-8 rounded-md border bg-background px-2 text-sm"
                            value={row.symbol}
                            disabled={!row.use}
                            onChange={(e) =>
                              update(item.name, {
                                symbol: e.target.value,
                                pinMap:
                                  e.target.value === item.symbol
                                    ? item.pin_map
                                    : defaultMap(symbols.get(e.target.value), item.pins),
                              })
                            }
                          >
                            {item.kind === 'subckt' && (
                              <option value={GENERIC}>Box with the model's pins</option>
                            )}
                            {choices.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </div>
                      </td>
                      <td className="p-2">
                        {item.kind === 'subckt' && row.symbol !== GENERIC && symbol ? (
                          <div className="flex flex-wrap gap-1">
                            {item.pins.map((pin, i) => (
                              <label key={pin} className="flex items-center gap-1 font-mono text-xs">
                                {pin}→
                                <select
                                  aria-label={`${item.name} pin ${pin}`}
                                  className={`h-7 rounded border bg-background px-1 ${row.pinMap[i] ? '' : 'border-destructive'}`}
                                  value={row.pinMap[i] ?? ''}
                                  onChange={(e) =>
                                    update(item.name, {
                                      pinMap: row.pinMap.map((p, j) => (j === i ? e.target.value : p)),
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
                        ) : (
                          <span className="text-xs text-muted-foreground">
                            {item.kind === 'model' ? `.model (${item.type})` : 'pins as in the model'}
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <DialogFooter className="items-center gap-2 sm:justify-between">
          <div className="flex items-center gap-2 text-sm">
            Library
            <Input
              aria-label="Library name"
              value={library}
              className="h-8 w-56"
              onChange={(e) => setLibrary(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-2">
            {incomplete.length > 0 && (
              <span className="text-xs text-destructive">
                Choose every pin of {incomplete.map((i) => i.name).join(', ')}
              </span>
            )}
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={!preview || busy || chosen.length === 0 || incomplete.length > 0 || !library.trim()}
              onClick={() => void run()}
            >
              Import {chosen.length} {chosen.length === 1 ? 'model' : 'models'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
