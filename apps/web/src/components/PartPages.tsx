/**
 * Pages of the part editor (docs/projekt-elementy.md §4.2) besides the model: the part's data
 * (category and the data that category is described by), its symbol (which drawing) and where
 * it is used (versions, updating the placed parts).
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost } from '@/api/client'
import type { SymbolDef } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { type DataField, fieldsOf, useCategories } from '@/lib/categories'
import { RATINGS } from '@/lib/ratings'
import { reloadLibrary, useProject } from '@/store/project'
import { SymbolPreview } from './SymbolPreview'

/** Data every part may have whatever its category. */
const COMMON: DataField[] = [
  { key: 'manufacturer', label: 'Manufacturer', type: 'text', unit: '', options: [], source: 'metadata' },
  { key: 'part_number', label: 'Part number', type: 'text', unit: '', options: [], source: 'metadata' },
  { key: 'package', label: 'Package', type: 'text', unit: '', options: [], source: 'metadata' },
  { key: 'technology', label: 'Technology', type: 'text', unit: '', options: [], source: 'metadata' },
  {
    key: 'datasheet',
    label: 'Datasheet (link or file)',
    type: 'text',
    unit: '',
    options: [],
    source: 'metadata',
  },
]

/** The fields of the part's data: common ones, its category's, the ratings (each key once). */
export function dataFields(categoryFields: DataField[]): DataField[] {
  const out: DataField[] = []
  const add = (f: DataField) => {
    if (!out.some((o) => o.key === f.key)) out.push(f)
  }
  for (const f of COMMON.slice(0, 3)) add(f)
  for (const f of categoryFields) add(f)
  for (const f of COMMON.slice(3)) add(f)
  for (const [key, label] of RATINGS) {
    const unit = label.match(/\[(.*)\]/)?.[1] ?? ''
    add({ key, label: label.replace(/ \[.*\]$/, ''), type: 'number', unit, options: [], source: 'ratings' })
  }
  return out
}

/** The form's data split as the component stores it: metadata texts and rated values. */
export function splitData(data: Record<string, string>, fields: DataField[]) {
  const ratings: Record<string, string> = {}
  const metadata: Record<string, string> = {}
  for (const [key, value] of Object.entries(data)) {
    if (!value.trim()) continue
    const field = fields.find((f) => f.key === key)
    if (field?.source === 'ratings' || RATINGS.some(([k]) => k === key)) ratings[key] = value.trim()
    else metadata[key] = value.trim()
  }
  return { metadata, ratings }
}

/** Where the library lists the part ("" = automatic, from its template or kind). */
export function CategorySelect({
  category,
  automatic,
  onCategory,
  className = '',
}: {
  category: string
  automatic: string
  onCategory: (path: string) => void
  className?: string
}): ReactNode {
  const categories = useCategories()
  return (
    <select
      aria-label="Category"
      title="Where the library lists the part"
      className={`h-7 rounded-md border bg-background px-2 text-xs ${className}`}
      value={category}
      onChange={(e) => onCategory(e.target.value)}
    >
      <option value="">Automatic: {automatic || '—'}</option>
      {categories.map((c) => (
        <option key={c.path} value={c.path}>
          {c.path.includes('/') ? ` ${c.path.split('/')[1]}` : c.path}
        </option>
      ))}
    </select>
  )
}

export function DataPage({
  category,
  automatic,
  description,
  onDescription,
  data,
  onData,
}: {
  category: string
  automatic: string // the category it gets without one of its own
  description: string
  onDescription: (text: string) => void
  data: Record<string, string>
  onData: (data: Record<string, string>) => void
}): ReactNode {
  const categories = useCategories()
  const fields = dataFields(fieldsOf(categories, category || automatic))
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 overflow-y-auto p-4" data-testid="part-data">
      <p className="text-xs text-muted-foreground">
        Category: <span className="text-foreground">{category || `${automatic || '—'} (automatic)`}</span> –
        chosen at the top; the data below are the ones that category describes parts by.
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Description</span>
        <textarea
          aria-label="Description"
          className="min-h-16 rounded-md border bg-background px-2 py-1 text-sm"
          value={description}
          onChange={(e) => onDescription(e.target.value)}
        />
      </label>
      <div className="grid grid-cols-[12rem_1fr] items-center gap-x-3 gap-y-1.5">
        {fields.map((field) => (
          <DataRow
            key={field.key}
            field={field}
            value={data[field.key] ?? ''}
            onChange={(v) => onData({ ...data, [field.key]: v })}
          />
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        The data appear on the part's card and when hovering it in the library, and the library filters by
        them.
      </p>
    </div>
  )
}

function DataRow({
  field,
  value,
  onChange,
}: {
  field: DataField
  value: string
  onChange: (v: string) => void
}) {
  const id = `data-${field.key}`
  return (
    <>
      <label htmlFor={id} className="truncate text-muted-foreground" title={field.label}>
        {field.label}
        {field.unit && <span className="text-muted-foreground/60"> [{field.unit}]</span>}
      </label>
      <div className="flex items-center gap-1">
        <Input
          id={id}
          aria-label={field.label}
          className={`h-7 ${field.type === 'number' ? 'font-mono' : ''}`}
          list={field.options.length ? `${id}-options` : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {field.options.length > 0 && (
          <datalist id={`${id}-options`}>
            {field.options.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        )}
      </div>
    </>
  )
}

/** Which drawing the part has: the template's symbol or one of its other looks; a saved part of
 *  the user's library can also be drawn as a box or as another symbol with as many pins. */
export function SymbolPage({
  symbol,
  look,
  onLook,
  partId,
  onRedrawn,
}: {
  symbol: SymbolDef | undefined
  look: string
  onLook: (look: string) => void
  partId?: string | null // a saved part of the user's library
  onRedrawn?: (id: string) => void
}): ReactNode {
  const choices: [string, string][] = symbol
    ? [['', symbol.name], ...(symbol.looks ?? []).map((l): [string, string] => [l.name, l.label])]
    : []
  return (
    <div className="flex flex-col gap-3 p-4" data-testid="part-symbol">
      {symbol ? (
        <>
          <p className="text-xs text-muted-foreground">
            How the part is drawn on the schematic (its pins stay the same).
          </p>
          <div className="flex flex-wrap gap-2">
            {choices.map(([name, label]) => (
              <button
                key={name || 'base'}
                type="button"
                aria-pressed={look === name}
                aria-label={`Drawing ${label}`}
                className={`flex w-32 flex-col items-center gap-1 rounded-md border p-2 text-xs ${look === name ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent'}`}
                onClick={() => onLook(name)}
              >
                <SymbolPreview symbol={symbol} look={name || 'base'} size={56} />
                <span className="text-center">{label}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        !partId && (
          <p className="text-muted-foreground">
            This part is drawn as a box with its pins (or a symbol drawn for its sheet). Draw another one from
            its block in the inspector: “Draw block symbol…”.
          </p>
        )
      )}
      {partId && <Redraw partId={partId} onRedrawn={onRedrawn} />}
    </div>
  )
}

/** A saved part drawn as a box with its pins, or like a built-in symbol with as many pins. */
function Redraw({ partId, onRedrawn }: { partId: string; onRedrawn?: (id: string) => void }): ReactNode {
  const symbols = useProject((s) => s.symbols)
  const part = symbols.get(partId)
  const ports = part?.pins.map((p) => p.number) ?? []
  const [like, setLike] = useState('')
  const [pins, setPins] = useState<Record<string, string>>({})
  const candidates = [...symbols.values()].filter(
    (s) => s.id.startsWith('bpt:') && !s.power_net && s.pins.length === ports.length && ports.length > 0,
  )
  const chosen = like && like !== 'box' ? symbols.get(like) : undefined
  const mapping = chosen
    ? Object.fromEntries(chosen.pins.map((p, k) => [p.number, pins[p.number] ?? ports[k]]))
    : {}
  const complete = !chosen || new Set(Object.values(mapping)).size === ports.length
  const apply = async () => {
    try {
      await apiPost('/api/library/components/drawing', {
        id: partId,
        like: chosen ? chosen.id : null,
        pins: mapping,
      })
      await reloadLibrary()
      toast.success(
        `${part?.name ?? 'The part'} is drawn ${chosen ? `like the ${chosen.name}` : 'as a box'} now`,
      )
      onRedrawn?.(partId)
    } catch (error) {
      toast.error(`Cannot change the drawing: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <div className="flex flex-col gap-2 border-t pt-3" data-testid="part-redraw">
      <p className="text-xs font-medium text-muted-foreground uppercase">Another drawing</p>
      <select
        aria-label="Draw the part as"
        className="h-8 w-72 rounded-md border bg-background px-2 text-sm"
        value={like}
        onChange={(e) => {
          setLike(e.target.value)
          setPins({})
        }}
      >
        <option value="">choose…</option>
        <option value="box">A box with its pins</option>
        {candidates.map((s) => (
          <option key={s.id} value={s.id}>
            Like the {s.name}
          </option>
        ))}
      </select>
      {chosen && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-3">
            <SymbolPreview symbol={chosen} size={48} />
            <p className="text-xs text-muted-foreground">
              Which of the part's pins each pin of the drawing is:
            </p>
          </div>
          {chosen.pins.map((p) => (
            <label key={p.number} className="flex items-center gap-2 text-xs">
              <span className="w-28">
                {p.name && p.name !== p.number ? `${p.name} (${p.number})` : p.number}
              </span>
              <select
                aria-label={`Drawing pin ${p.name || p.number}`}
                className="h-7 rounded-md border bg-background px-1"
                value={mapping[p.number]}
                onChange={(e) => setPins({ ...mapping, [p.number]: e.target.value })}
              >
                {ports.map((port) => (
                  <option key={port} value={port}>
                    {port}
                  </option>
                ))}
              </select>
            </label>
          ))}
          {!complete && <p className="text-xs text-destructive">Each of the part's pins once.</p>}
        </div>
      )}
      <Button size="sm" className="self-start" disabled={!like || !complete} onClick={() => void apply()}>
        Apply (a new version)
      </Button>
    </div>
  )
}

interface Placed {
  id: string
  name: string
  sheet: string
  version: number
  library_version: number | null
  changes: string
  used: number
}

interface LibraryPart {
  version: number
  updated?: string
  changes?: string
  history?: { version: number; updated: string; changes: string }[]
  sheets: {
    name: string
    component?: { id: string; name: string; version: number } | null
    instances: { symbol: string }[]
  }[]
}

interface Usage {
  project: string
  path: string | null
  parts: number
  version: number
}

/** Parts placed inside a part (a module's IC, capacitors...): name, version, how many. */
export function partsInside(
  part: LibraryPart,
  id: string,
): { id: string; name: string; version: number; count: number }[] {
  return part.sheets
    .filter((s) => s.component && s.component.id !== id)
    .map((s) => ({
      id: s.component?.id ?? '',
      name: s.component?.name ?? s.name,
      version: s.component?.version ?? 1,
      count: part.sheets.reduce(
        (n, other) => n + other.instances.filter((i) => i.symbol === `sheet:${s.name}`).length,
        0,
      ),
    }))
}

/** Versions and where the part is used in this project, with the update of placed parts. */
export function UsagePage({
  id,
  version,
  changes,
  onChanges,
}: {
  id: string | null // the saved part (null: not saved yet)
  version: number | null
  changes: string
  onChanges: (text: string) => void
}): ReactNode {
  const info = useProject((s) => s.info)
  const queries = useQueryClient()
  const { data: placed = [] } = useQuery({
    queryKey: ['placed-components', info?.id],
    queryFn: () => apiGet<Placed[]>(`/api/projects/${info?.id}/components`),
    enabled: Boolean(info),
  })
  const { data: part } = useQuery({
    queryKey: ['library-part', id, version],
    queryFn: async () =>
      (await apiGet<Record<string, LibraryPart>>('/api/library/components'))[id ?? ''] ?? null,
    enabled: Boolean(id),
  })
  const { data: usage = [] } = useQuery({
    queryKey: ['part-usage', id],
    queryFn: () => apiGet<Usage[]>(`/api/library/symbols/usage?id=${encodeURIComponent(id ?? '')}`),
    enabled: Boolean(id),
  })
  const inside = part && id ? partsInside(part, id) : []
  const elsewhere = usage.filter((u) => u.project !== useProject.getState().project?.name)
  const here = placed.filter((p) => p.id === id)
  const stale = here.filter((p) => p.library_version !== null && p.library_version > p.version)
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-3 p-4" data-testid="part-usage">
      <p>
        {id ? (
          <>
            Library part <span className="font-mono">{id.replace(/^cmp:/, '')}</span>, version {version ?? 1}.
            Saving makes the next version; projects keep the version they placed until they update.
          </>
        ) : (
          'Not saved yet: it gets version 1.'
        )}
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">What changes in this version</span>
        <Input aria-label="What changes" value={changes} onChange={(e) => onChanges(e.target.value)} />
      </div>
      {id && !id.startsWith('cmp:Standard ') && <VariantsSection id={id} />}
      <div>
        <p className="text-xs font-medium text-muted-foreground uppercase">In this project</p>
        {here.length === 0 ? (
          <p className="text-muted-foreground">Not placed in this project.</p>
        ) : (
          here.map((p) => (
            <p key={p.sheet}>
              {p.used} placed · version {p.version}
              {p.library_version !== null &&
                p.library_version > p.version &&
                ` (library: version ${p.library_version})`}
            </p>
          ))
        )}
        {stale.length > 0 && info && (
          <Button
            size="sm"
            className="mt-2"
            onClick={async () => {
              await updatePlaced(info.id, [stale[0].id])
              void queries.invalidateQueries({ queryKey: ['placed-components'] })
            }}
          >
            Update the placed parts to version {stale[0].library_version}
          </Button>
        )}
      </div>
      {id && (
        <div data-testid="part-elsewhere">
          <p className="text-xs font-medium text-muted-foreground uppercase">In other projects</p>
          {elsewhere.length === 0 ? (
            <p className="text-muted-foreground">Not in the other open or recent projects.</p>
          ) : (
            elsewhere.map((u) => (
              <p key={`${u.project}:${u.path}`} title={u.path ?? 'open, not saved'}>
                {u.project}: {u.parts} placed · version {u.version}
              </p>
            ))
          )}
        </div>
      )}
      {inside.length > 0 && (
        <div data-testid="part-inside">
          <p className="text-xs font-medium text-muted-foreground uppercase">Parts inside it</p>
          {inside.map((p) => (
            <p key={p.id}>
              {p.name} · version {p.version}
              {p.count > 1 ? ` · ${p.count}×` : ''}
            </p>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Copies of library parts, as they were when placed in its circuit.
          </p>
        </div>
      )}
      {part && (part.history?.length ?? 0) > 0 && (
        <div data-testid="part-history">
          <p className="text-xs font-medium text-muted-foreground uppercase">History</p>
          {[
            { version: part.version, updated: part.updated ?? '', changes: part.changes ?? '' },
            ...(part.history ?? []),
          ].map((h) => (
            <p key={h.version}>
              <span className="font-mono">v{h.version}</span>
              {h.updated && <span className="text-muted-foreground"> · {h.updated}</span>}
              {h.changes && ` · ${h.changes}`}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** Put the library version of components in place of the project's copies (one undo step). */
export async function updatePlaced(projectId: string, ids: string[]): Promise<void> {
  try {
    await apiPost(`/api/projects/${projectId}/components/update`, { ids })
    await useProject.getState().refresh()
    toast.success('Placed parts updated', {
      description: 'They keep their place, references and values. Undo brings the old version back.',
      action: { label: 'Undo', onClick: () => void useProject.getState().undo() },
    })
  } catch (error) {
    toast.error(`Cannot update: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** How many parts of an older version of `id` the open project has. */
export async function stalePlaced(projectId: string, id: string): Promise<number> {
  try {
    const placed = await apiGet<Placed[]>(`/api/projects/${projectId}/components`)
    return placed
      .filter((p) => p.id === id && p.library_version !== null && p.library_version > p.version)
      .reduce((n, p) => n + p.used, 0)
  } catch {
    return 0
  }
}

interface VariantInfo {
  name: string
  label: string
  description: string
  sheet: string
  faster: boolean
}

/** Other models of the part (Ś11): a sheet of this project with the part's pins, simulated
 * instead when a placed part chooses it ("Simulate as"); a faster one is offered for long runs. */
export function VariantsSection({ id }: { id: string }): ReactNode {
  const project = useProject((s) => s.project)
  const info = useProject((s) => s.info)
  const queries = useQueryClient()
  const { data: part } = useQuery({
    queryKey: ['library-part', id],
    queryFn: async () =>
      (await apiGet<Record<string, { sheets: { variants?: VariantInfo[] }[] }>>('/api/library/components'))[
        id
      ],
  })
  const [sheet, setSheet] = useState('')
  const [label, setLabel] = useState('')
  const [faster, setFaster] = useState(true)
  const variants = part?.sheets[0]?.variants ?? []
  const candidates = (project?.sheets ?? []).filter(
    (s) => !s.owner && s.labels.some((l) => l.kind === 'port'),
  )
  const reload = async () => {
    await reloadLibrary()
    void queries.invalidateQueries({ queryKey: ['library-part', id] })
  }
  const add = async () => {
    try {
      await apiPost('/api/library/components/variants', { id, project_id: info?.id, sheet, label, faster })
      setLabel('')
      await reload()
      toast.success(`Variant “${label}” added`, {
        description: 'Placed parts choose it in the inspector: Simulate as.',
      })
    } catch (error) {
      toast.error(`Cannot add the variant: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return (
    <div className="flex flex-col gap-1" data-testid="part-variants">
      <p className="text-xs font-medium text-muted-foreground uppercase">Models (Simulate as)</p>
      {variants.length === 0 && <p className="text-muted-foreground">Only its own model.</p>}
      {variants.map((v) => (
        <div key={v.name} className="flex items-center gap-2">
          <span>{v.label}</span>
          {v.faster && (
            <span className="rounded bg-emerald-500/15 px-1 text-[10px] text-emerald-700 dark:text-emerald-400">
              faster
            </span>
          )}
          <span className="text-xs text-muted-foreground">sheet {v.sheet}</span>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={async () => {
              await apiDelete(
                `/api/library/components/variants?id=${encodeURIComponent(id)}&name=${encodeURIComponent(v.name)}`,
              )
              await reload()
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      <div className="mt-1 flex flex-wrap items-center gap-1">
        <select
          aria-label="Variant sheet"
          className="h-7 rounded-md border bg-background px-1 text-xs"
          value={sheet}
          onChange={(e) => setSheet(e.target.value)}
        >
          <option value="">a sheet of this project with the same pins…</option>
          {candidates.map((s) => (
            <option key={s.name} value={s.name}>
              {s.name}
            </option>
          ))}
        </select>
        <Input
          aria-label="Variant label"
          className="h-7 w-48 text-xs"
          placeholder="label (Averaged)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <label className="flex items-center gap-1 text-xs">
          <input type="checkbox" checked={faster} onChange={(e) => setFaster(e.target.checked)} />
          faster (offered for long runs)
        </label>
        <Button size="sm" className="h-7" disabled={!sheet || !label.trim()} onClick={() => void add()}>
          Add variant
        </Button>
      </div>
    </div>
  )
}
