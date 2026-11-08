/**
 * Template editor (docs/projekt-elementy.md §4.3): a sheet of the project drawn as a parametric
 * equivalent circuit. Pins are added here (port labels placed for you), parameters are listed
 * and dragged onto parts' values ({name}); the form, the symbol and a preview of the curves come
 * next, then the template is saved to a library to make parts from.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GripVertical, Plus, Trash2 } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiGet, apiPost } from '@/api/client'
import type { ComponentKind, Label, PortSide, Sheet, TemplateFieldDef } from '@/api/types'
import { ComponentCard } from '@/components/ComponentCard'
import { openComponentWizard } from '@/components/ComponentWizard'
import { SymbolPreview } from '@/components/SymbolPreview'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useCategories } from '@/lib/categories'
import { newId } from '@/lib/ids'
import { blockUses } from '@/lib/sheets'
import { own, useProject } from '@/store/project'

export const TEMPLATE_PANEL = 'templateEditor'
const GRID = 127
const KINDS: ComponentKind[] = [
  'capacitor',
  'resistor',
  'inductor',
  'transformer',
  'diode',
  'transistor',
  'ic',
  'module',
  'other',
]
const SIDES: PortSide[] = ['left', 'right', 'top', 'bottom']

/** What is being saved: the template's name and where it goes. */
export interface TemplateMeta {
  name: string
  library: string
  kind: ComponentKind
  category: string
  description: string
  /** The template changed in place ("" = a new one is made) and its version now. */
  editing?: string
  version?: number
  /** What a new template starts from (a template's or a part's name). */
  basedOn?: string
  /** Opened from the part editor (the bar offers the way back). */
  fromPart?: boolean
  /** A new model saved here: the part it was opened from can use it. */
  savedNew?: string
  /** The sheets added just for this editing ([] = the user's own sheet, never taken away). */
  sheets?: string[]
  /** Those sheets as last opened or saved: unchanged since, closing them loses nothing. */
  baseline?: string
  /** The sheet to go back to when they go. */
  from?: string
}

const useTemplateEditor = create<{
  sheet: string | null
  meta: TemplateMeta
  changes: string // what changed, for the next version's history
  open: (sheet: string, meta?: Partial<TemplateMeta>) => void
}>((set) => ({
  sheet: null,
  meta: { name: '', library: 'My templates', kind: 'other', category: '', description: '' },
  changes: '',
  open: (sheet, meta) => {
    useLookStore.getState().set('') // another template: its own drawing to choose
    set((s) => ({
      sheet,
      changes: '',
      meta: {
        ...s.meta,
        name: sheet,
        kind: 'other',
        category: '',
        description: '',
        editing: '',
        version: 0,
        basedOn: '',
        fromPart: false,
        savedNew: '',
        sheets: [],
        baseline: '',
        from: '',
        ...meta,
      },
    }))
  },
}))

/** What saving keeps of the sheets being edited: to tell whether they changed since. */
function modelState(sheets: string[]): string {
  const all = useProject.getState().project?.sheets ?? []
  return JSON.stringify([all.filter((s) => sheets.includes(s.name)), useLookStore.getState().look])
}

/**
 * The end of editing a model. Its sheets were only a way to edit it: saved (or never changed)
 * they go, one undo step. With unsaved changes, or used as a block elsewhere, they stay.
 */
async function closeModel(): Promise<void> {
  const { meta } = useTemplateEditor.getState()
  useTemplateEditor.setState({ sheet: null })
  window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: TEMPLATE_PANEL }))
  const { project, execute, setSheet, sheetName } = useProject.getState()
  const opened = meta.sheets ?? []
  if (!project || opened.length === 0) return
  if (modelState(opened) !== meta.baseline) {
    toast.info('The model has unsaved changes: its sheet stays in the project', {
      description: 'Save it later with “Save as model…”, or delete the sheet.',
    })
    return
  }
  const used = opened.flatMap((name) => blockUses(project.sheets, name))
  if (used.some((use) => !opened.includes(use.slice(0, use.lastIndexOf('/'))))) return
  if (opened.includes(sheetName)) {
    const others = project.sheets.filter((s) => !opened.includes(s.name)).map((s) => s.name)
    const back = meta.from && others.includes(meta.from) ? meta.from : others[0]
    if (!back) return // (a project needs a sheet)
    setSheet(back)
  }
  await execute({
    type: 'transaction',
    label: `close model ${meta.name}`,
    commands: opened.map((name) => ({ type: 'remove_sheet', name })),
  })
}

/** The template editor beside the sheet being edited (the sheet in front, not under the part
 *  editor or another full-window tab). */
function showPanel() {
  window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'schematic' }))
  window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: TEMPLATE_PANEL }))
}

/** "Draw a template": a new sheet with two pins, shown, with the template editor beside it. */
export async function drawNewTemplate(): Promise<void> {
  const { project, execute, setSheet, sheetName } = useProject.getState()
  if (!project) return
  const taken = new Set(project.sheets.map((s) => s.name.toLowerCase()))
  let name = 'Model'
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `Model ${n}`
  const pin = (text: string, x: number): Label => ({ id: newId(), kind: 'port', text, at: [x, 0], rot: 0 })
  const sheet: Sheet = {
    id: newId(),
    name,
    instances: [],
    wires: [],
    junctions: [],
    labels: [pin('1', 0), pin('2', 20 * GRID)],
    directives: [],
    port_sides: { '1': 'left', '2': 'right' },
    port_order: ['1', '2'],
  }
  if (!(await execute({ type: 'add_sheet', sheet }))) return
  setSheet(name)
  useTemplateEditor.getState().open(name, { sheets: [name], from: sheetName })
  useTemplateEditor.setState((s) => ({ meta: { ...s.meta, baseline: modelState([name]) } }))
  showPanel()
}

/**
 * Edit a model's equivalent circuit as a sheet: a user template in place (saved as its next
 * version), or with `asNew` a new template based on it. Built-in and standard templates and
 * parts' circuits (`cmp:`) always start a new one. `form`: values to start from (the part
 * editor's), instead of the defaults.
 */
export async function editTemplate(
  template: string,
  options: { asNew?: boolean; form?: Record<string, string>; fromPart?: boolean } = {},
): Promise<void> {
  const { info, sheetName: from } = useProject.getState()
  if (!info) return
  try {
    const opened = await own(() =>
      apiPost<{
        sheet: string
        sheets: string[]
        name: string
        library: string
        kind: ComponentKind
        category: string
        description: string
        editing: string
        version: number
        based_on: string
      }>(`/api/projects/${info.id}/templates/open`, {
        template,
        as_new: Boolean(options.asNew),
        form: options.form ?? {},
      }),
    )
    await useProject.getState().refresh()
    useProject.getState().setSheet(opened.sheet)
    useTemplateEditor.getState().open(opened.sheet, {
      ...opened,
      basedOn: opened.based_on,
      fromPart: Boolean(options.fromPart),
      from,
    })
    useTemplateEditor.setState((s) => ({ meta: { ...s.meta, baseline: modelState(opened.sheets) } }))
    showPanel()
  } catch (error) {
    toast.error(`Cannot open the model: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** The current sheet as a template (a sheet already drawn: "Save as template…"). */
export function editSheetAsTemplate(sheet: string): void {
  useTemplateEditor.getState().open(sheet)
  showPanel()
}

type Tab = 'symbol' | 'preview'

export function TemplatePanel(): ReactNode {
  const sheetName = useTemplateEditor((s) => s.sheet)
  const meta = useTemplateEditor((s) => s.meta)
  const project = useProject((s) => s.project)
  const info = useProject((s) => s.info)
  const execute = useProject((s) => s.execute)
  const sheet = project?.sheets.find((s) => s.name === sheetName)
  const [tab, setTab] = useState<Tab>('symbol')
  const setMeta = (patch: Partial<TemplateMeta>) =>
    useTemplateEditor.setState((s) => ({ meta: { ...s.meta, ...patch } }))

  if (!sheet || !info)
    return (
      <div className="flex flex-col gap-2 p-3 text-sm">
        <p className="text-muted-foreground">
          Draw a parametric equivalent circuit (a crystal, a capacitor with two resonances…) and save it as a
          model to make parts from.
        </p>
        <Button size="sm" className="self-start" onClick={() => void drawNewTemplate()}>
          <Plus /> Draw a model
        </Button>
      </div>
    )

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3 text-sm"
      data-testid="template-editor"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">Sheet: {sheet.name}</span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() => useProject.getState().setSheet(sheet.name)}
        >
          Show its sheet
        </Button>
      </div>
      <Pins sheet={sheet} execute={execute} />
      <Parameters sheet={sheet} execute={execute} />
      <div className="flex rounded-md border p-0.5" role="tablist" aria-label="Model pages">
        {(
          [
            ['symbol', 'Symbol'],
            ['preview', 'Preview'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            className={`flex-1 rounded px-2 py-0.5 text-xs ${tab === key ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'symbol' && <SymbolChoice projectId={info.id} sheet={sheet} />}
      {tab === 'preview' && <Preview projectId={info.id} sheet={sheet} />}
      <SaveTemplate sheet={sheet} meta={meta} setMeta={setMeta} />
    </div>
  )
}

type Execute = ReturnType<typeof useProject.getState>['execute']

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</span>
        {actions}
      </div>
      {children}
    </div>
  )
}

/** The part's pins: port labels of the sheet, their side on the symbol. */
function Pins({ sheet, execute }: { sheet: Sheet; execute: Execute }) {
  const ports = sheet.labels.filter((l) => l.kind === 'port')
  const names = [...new Set(ports.map((p) => p.text))]
  const sideOf = (name: string): PortSide => {
    const own = sheet.port_sides?.[name]
    if (own) return own
    const xs = ports.map((p) => p.at[0])
    const at = ports.find((p) => p.text === name)?.at[0] ?? 0
    return at <= (Math.min(...xs) + Math.max(...xs)) / 2 ? 'left' : 'right'
  }
  const layout = (sides: Record<string, PortSide>, order: string[]) =>
    execute({ type: 'set_port_layout', sheet: sheet.name, sides, order })
  const addPin = async () => {
    let n = names.length + 1
    while (names.includes(String(n))) n++
    const name = String(n)
    const sides = Object.fromEntries(names.map((p) => [p, sideOf(p)]))
    const side: PortSide =
      names.filter((p) => sides[p] === 'left').length > names.filter((p) => sides[p] === 'right').length
        ? 'right'
        : 'left'
    const same = ports.filter((p) => sideOf(p.text) === side)
    const xs = ports.map((p) => p.at[0])
    const x = same.length ? same[0].at[0] : side === 'left' ? Math.min(0, ...xs) : Math.max(20 * GRID, ...xs)
    const y = same.length ? Math.max(...same.map((p) => p.at[1])) + 4 * GRID : 0
    await execute({
      type: 'transaction',
      label: `add pin ${name}`,
      commands: [
        {
          type: 'add_objects',
          sheet: sheet.name,
          labels: [{ id: newId(), kind: 'port', text: name, at: [x, y], rot: side === 'right' ? 180 : 0 }],
        },
        {
          type: 'set_port_layout',
          sheet: sheet.name,
          sides: { ...sides, [name]: side },
          order: [...names, name],
        },
      ],
    })
  }
  return (
    <Section
      title="Pins"
      actions={
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void addPin()}>
          <Plus className="size-3" /> Pin
        </Button>
      }
    >
      {names.length === 0 && <p className="text-xs text-destructive">No pins yet: add the part's pins.</p>}
      {names.map((name) => {
        const labels = ports.filter((p) => p.text === name)
        return (
          <div key={name} className="flex items-center gap-1">
            <Input
              aria-label={`Pin ${name}`}
              className="h-7 w-20 font-mono text-xs"
              defaultValue={name}
              onBlur={(e) => {
                const text = e.target.value.trim()
                if (!text || text === name) return
                void execute({
                  type: 'transaction',
                  label: `rename pin ${name}`,
                  commands: labels.map((l) => ({
                    type: 'update_label' as const,
                    sheet: sheet.name,
                    id: l.id,
                    text,
                  })),
                })
              }}
            />
            <select
              aria-label={`Side of pin ${name}`}
              className="h-7 rounded-md border bg-background px-1 text-xs"
              value={sideOf(name)}
              onChange={(e) =>
                void layout(
                  {
                    ...Object.fromEntries(names.map((p) => [p, sideOf(p)])),
                    [name]: e.target.value as PortSide,
                  },
                  names,
                )
              }
            >
              {SIDES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="rounded p-1 text-muted-foreground hover:text-destructive"
              aria-label={`Remove pin ${name}`}
              onClick={() =>
                void execute({ type: 'remove_objects', sheet: sheet.name, ids: labels.map((l) => l.id) })
              }
            >
              <Trash2 className="size-3" />
            </button>
          </div>
        )
      })}
      <p className="text-[11px] text-muted-foreground">Wire the circuit to the pins' labels on the sheet.</p>
    </Section>
  )
}

/** Parts whose values use parameter `name`: {name} anywhere in a value, or the bare name in an
 *  expression of the circuit's own voltages or currents (C(V) of an MLCC: Cnom/(1+…)). */
function usersOf(sheet: Sheet, name: string): string[] {
  const braced = new RegExp(`\\{[^}]*\\b${name}\\b[^}]*\\}`)
  const bare = new RegExp(`\\b${name}\\b`)
  const behavioural = /\b[vi]\s*\(/i
  return sheet.instances
    .filter((i) =>
      Object.values(i.model.params).some((v) => braced.test(v) || (behavioural.test(v) && bare.test(v))),
    )
    .map((i) => i.ref)
}

/**
 * The model's parameters, one list: each one's default value, unit and label in the part editor's
 * form, the parts using it and, under More, what else the form says of it. Dragged onto a part,
 * its value becomes {name}.
 */
function Parameters({ sheet, execute }: { sheet: Sheet; execute: Execute }) {
  const [name, setName] = useState('')
  const [value, setValue] = useState('')
  const [more, setMore] = useState<Set<string>>(new Set())
  const params = Object.entries(sheet.parameters ?? {})
  // A local copy: edits in a row build on each other before the project answers.
  const [draft, setDraft] = useState<TemplateFieldDef[]>(sheet.form ?? [])
  const saved = JSON.stringify(sheet.form ?? [])
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the project's form when it changes
  useEffect(() => setDraft(sheet.form ?? []), [saved])
  const defaultOf = (k: string) => sheet.parameters?.[k] ?? ''
  const fieldOf = (key: string): TemplateFieldDef =>
    draft.find((f) => f.key === key) ?? {
      key,
      label: key,
      unit: '',
      default: defaultOf(key),
      description: '',
      required: false,
    }
  // The form's order: as arranged (up / down), then parameters added since.
  const keys = [
    ...draft.map((f) => f.key).filter((k) => k in (sheet.parameters ?? {})),
    ...params.map(([k]) => k).filter((k) => !draft.some((f) => f.key === k)),
  ]
  const commit = (form: TemplateFieldDef[]) => {
    setDraft(form)
    void execute({ type: 'set_sheet_form', sheet: sheet.name, form })
  }
  const setField = (key: string, patch: Partial<TemplateFieldDef>) =>
    commit(keys.map((k) => (k === key ? { ...fieldOf(k), ...patch } : fieldOf(k))))
  const move = (key: string, step: -1 | 1) => {
    const order = [...keys]
    const at = order.indexOf(key)
    if (at + step < 0 || at + step >= order.length) return
    ;[order[at], order[at + step]] = [order[at + step], order[at]]
    commit(order.map(fieldOf))
  }
  const add = async () => {
    const [n, v] = [name, value]
    if (!n.trim() || !v.trim()) return
    if (await execute({ type: 'set_parameter', sheet: sheet.name, name: n.trim(), value: v.trim() })) {
      // Cleared only if not typed in again meanwhile (the next parameter).
      setName((now) => (now === n ? '' : now))
      setValue((now) => (now === v ? '' : now))
    }
  }
  return (
    <Section title="Parameters">
      {keys.map((key, index) => {
        const f = fieldOf(key)
        const v = defaultOf(key)
        const users = usersOf(sheet, key)
        const open = more.has(key)
        return (
          <div key={key} className="flex flex-col gap-1 rounded border p-1.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                draggable
                aria-label={`Drag parameter ${key} onto a part`}
                title="Drag onto a part on the sheet: its value becomes {name}"
                className="flex shrink-0 cursor-grab items-center gap-0.5 rounded border px-1 py-0.5 font-mono text-xs hover:bg-accent"
                onDragStart={(e) => e.dataTransfer.setData('application/x-bpt-param', key)}
              >
                <GripVertical className="size-3 text-muted-foreground" />
                {key}
              </button>
              <Input
                aria-label={`Default of ${key}`}
                className="h-7 min-w-0 font-mono text-xs"
                defaultValue={v}
                key={`${key}=${v}`}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                onBlur={(e) => {
                  const next = e.target.value.trim()
                  if (next && next !== v)
                    void execute({ type: 'set_parameter', sheet: sheet.name, name: key, value: next })
                }}
              />
              <Input
                aria-label={`Unit of ${key}`}
                className="h-7 w-14 shrink-0 text-xs"
                placeholder="unit"
                defaultValue={f.unit}
                key={`u-${f.unit}`}
                onBlur={(e) => e.target.value !== f.unit && setField(key, { unit: e.target.value })}
              />
              <button
                type="button"
                className="rounded p-1 text-muted-foreground hover:text-destructive"
                aria-label={`Remove parameter ${key}`}
                onClick={() =>
                  void execute({ type: 'set_parameter', sheet: sheet.name, name: key, value: null })
                }
              >
                <Trash2 className="size-3" />
              </button>
            </div>
            <div className="flex items-center gap-1">
              <Input
                aria-label={`Label of ${key}`}
                title="Its name in the part editor's form"
                className="h-7 min-w-0 text-xs"
                placeholder="label in the form"
                defaultValue={f.label}
                key={`l-${f.label}`}
                onBlur={(e) => e.target.value !== f.label && setField(key, { label: e.target.value })}
              />
              <button
                type="button"
                className="rounded px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label={`Move ${key} up`}
                disabled={index === 0}
                onClick={() => move(key, -1)}
              >
                ↑
              </button>
              <button
                type="button"
                className="rounded px-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30"
                aria-label={`Move ${key} down`}
                disabled={index === keys.length - 1}
                onClick={() => move(key, 1)}
              >
                ↓
              </button>
              <button
                type="button"
                className="shrink-0 rounded px-1 text-[11px] text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                aria-label={`More of ${key}`}
                onClick={() => {
                  const next = new Set(more)
                  if (open) next.delete(key)
                  else next.add(key)
                  setMore(next)
                }}
              >
                {open ? 'Less' : 'More'}
              </button>
            </div>
            <span
              className={`text-[10px] ${users.length ? 'text-muted-foreground' : 'text-amber-600 dark:text-amber-400'}`}
            >
              {users.length ? `used by ${users.join(', ')}` : 'not used yet: drag it onto a part'}
            </span>
            {open && (
              <div className="grid grid-cols-2 gap-1">
                <Input
                  aria-label={`Description of ${key}`}
                  className="col-span-2 h-7 text-xs"
                  placeholder="what it is (shown in the form)"
                  defaultValue={f.description}
                  key={`d-${f.description}`}
                  onBlur={(e) =>
                    e.target.value !== f.description && setField(key, { description: e.target.value })
                  }
                />
                <Input
                  aria-label={`Help of ${key}`}
                  className="col-span-2 h-7 text-xs"
                  placeholder="what it does, where a datasheet gives it (its card in the form)"
                  defaultValue={f.help ?? ''}
                  key={`h-${f.help ?? ''}`}
                  onBlur={(e) => e.target.value !== (f.help ?? '') && setField(key, { help: e.target.value })}
                />
                <Input
                  aria-label={`Minimum of ${key}`}
                  className="h-7 font-mono text-xs"
                  placeholder="min"
                  defaultValue={f.minimum ?? ''}
                  key={`n-${f.minimum}`}
                  onBlur={(e) =>
                    e.target.value !== (f.minimum ?? '') && setField(key, { minimum: e.target.value })
                  }
                />
                <Input
                  aria-label={`Maximum of ${key}`}
                  className="h-7 font-mono text-xs"
                  placeholder="max"
                  defaultValue={f.maximum ?? ''}
                  key={`x-${f.maximum}`}
                  onBlur={(e) =>
                    e.target.value !== (f.maximum ?? '') && setField(key, { maximum: e.target.value })
                  }
                />
                <Input
                  aria-label={`Group of ${key}`}
                  className="h-7 text-xs"
                  placeholder="group"
                  defaultValue={f.group ?? ''}
                  key={`g-${f.group}`}
                  onBlur={(e) =>
                    e.target.value !== (f.group ?? '') && setField(key, { group: e.target.value })
                  }
                />
                <label className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <input
                    type="checkbox"
                    aria-label={`${key} required`}
                    checked={f.required}
                    onChange={(e) => setField(key, { required: e.target.checked })}
                  />
                  required
                </label>
              </div>
            )}
          </div>
        )
      })}
      <div className="flex items-center gap-1">
        <Input
          aria-label="New parameter name"
          className="h-7 font-mono text-xs"
          placeholder="name (Lm)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Input
          aria-label="New parameter value"
          className="h-7 font-mono text-xs"
          placeholder="default (10m)"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void add()}
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2"
          aria-label="Add parameter"
          onClick={() => void add()}
        >
          <Plus className="size-3" />
        </Button>
      </div>
    </Section>
  )
}

/** Which drawing the part gets: a built-in symbol with the same pins, or a box. */
function SymbolChoice({ projectId, sheet }: { projectId: string; sheet: Sheet }) {
  const symbols = useProject((s) => s.symbols)
  const [chosen, setChosen] = useLook()
  const { data: ids = [] } = useQuery({
    queryKey: ['template-symbols', projectId, sheet.name, sheet.labels.length],
    queryFn: () =>
      apiGet<string[]>(
        `/api/components/templates/symbols?project_id=${projectId}&sheet=${encodeURIComponent(sheet.name)}`,
      ),
  })
  const box = symbols.get(`sheet:${sheet.name}`)
  return (
    <div className="flex flex-wrap gap-2" data-testid="template-symbol">
      {box && (
        <button
          type="button"
          aria-pressed={chosen === ''}
          className={`flex w-24 flex-col items-center gap-1 rounded-md border p-1.5 text-[11px] ${chosen === '' ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent'}`}
          onClick={() => setChosen('')}
        >
          <SymbolPreview symbol={box} size={48} />
          {sheet.symbol ? 'drawn block symbol' : 'box with the pins'}
        </button>
      )}
      {ids.map((id) => {
        const s = symbols.get(id)
        if (!s) return null
        return (
          <button
            key={id}
            type="button"
            aria-pressed={chosen === id}
            aria-label={`Like the ${s.name}`}
            className={`flex w-24 flex-col items-center gap-1 rounded-md border p-1.5 text-[11px] ${chosen === id ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent'}`}
            onClick={() => setChosen(id)}
          >
            <SymbolPreview symbol={s} size={48} />
            like the {s.name}
          </button>
        )
      })}
      {ids.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          No built-in symbol has these pins: the part is drawn as a box.
        </p>
      )}
    </div>
  )
}

const useLookStore = create<{ look: string; set: (look: string) => void }>((set) => ({
  look: '',
  set: (look) => set({ look }),
}))
const useLook = (): [string, (look: string) => void] => [
  useLookStore((s) => s.look),
  useLookStore((s) => s.set),
]

/** The circuit's characteristics with the defaults, or with values to try. */
function Preview({ projectId, sheet }: { projectId: string; sheet: Sheet }) {
  const [tryValues, setTryValues] = useState<Record<string, string>>({})
  const params = Object.entries(sheet.parameters ?? {})
  const ports = new Set(sheet.labels.filter((l) => l.kind === 'port').map((l) => l.text))
  if (ports.size !== 2)
    return (
      <p className="text-xs text-muted-foreground">
        The preview measures parts with two pins (impedance); this one has {ports.size}.
      </p>
    )
  const values = Object.fromEntries(params.map(([k, v]) => [k, tryValues[k]?.trim() || v]))
  return (
    <div className="flex flex-col gap-2" data-testid="template-preview">
      <div className="flex flex-wrap gap-1">
        {params.map(([k, v]) => (
          <div key={k} className="flex items-center gap-1 text-xs">
            <span className="font-mono">{k}</span>
            <Input
              aria-label={`Try ${k}`}
              className="h-6 w-20 font-mono text-xs"
              placeholder={v}
              value={tryValues[k] ?? ''}
              onChange={(e) => setTryValues({ ...tryValues, [k]: e.target.value })}
            />
          </div>
        ))}
      </div>
      <ComponentCard
        subject={{ project_id: projectId, sheet: sheet.name, params: values }}
        kind="other"
        compact
      />
    </div>
  )
}

/** Saving the model being edited: from the bar over the sheet. */
function useSaveModel() {
  const sheetName = useTemplateEditor((s) => s.sheet)
  const meta = useTemplateEditor((s) => s.meta)
  const changes = useTemplateEditor((s) => s.changes)
  const project = useProject((s) => s.project)
  const info = useProject((s) => s.info)
  const queries = useQueryClient()
  const [look] = useLook()
  const [busy, setBusy] = useState(false)
  const sheet = project?.sheets.find((s) => s.name === sheetName)
  const setMeta = (patch: Partial<TemplateMeta>) =>
    useTemplateEditor.setState((s) => ({ meta: { ...s.meta, ...patch } }))
  const editedId = meta.editing ?? ''
  const id = `tpl:${meta.library.trim()}/${meta.name.trim()}`
  // In place: the same name and library as the model opened; otherwise a new model.
  const inPlace = Boolean(editedId) && id === editedId
  const save = async (replace: boolean) => {
    if (!sheet || !info) return
    setBusy(true)
    try {
      // The form's order (as arranged), then parameters it does not describe yet.
      const params = sheet.parameters ?? {}
      const keys = [
        ...(sheet.form ?? []).map((f) => f.key).filter((k) => k in params),
        ...Object.keys(params).filter((k) => !sheet.form?.some((f) => f.key === k)),
      ]
      const fields = keys.map(
        (key) =>
          sheet.form?.find((f) => f.key === key) ?? {
            key,
            label: key,
            unit: '',
            default: params[key],
            description: '',
            required: false,
          },
      )
      const saved = await apiPost<{ id: string; name: string; version: number }>(
        '/api/components/templates',
        {
          project_id: info.id,
          sheet: sheet.name,
          library: meta.library.trim(),
          name: meta.name.trim(),
          kind: meta.kind,
          description: meta.description.trim(),
          category: meta.category,
          fields: fields.map((f) => ({ ...f, default: sheet.parameters?.[f.key] ?? f.default })),
          symbol: look || null,
          changes: changes.trim(),
          replace,
        },
      )
      void queries.invalidateQueries({ queryKey: ['templates'] })
      const unchanged = inPlace && saved.version === meta.version
      // From now on this sheet edits the saved model (its next save is the next version).
      setMeta({
        editing: saved.id,
        version: saved.version,
        basedOn: '',
        savedNew: inPlace ? meta.savedNew : saved.id,
        baseline: modelState(meta.sheets ?? []),
      })
      useTemplateEditor.setState({ changes: '' })
      if (unchanged) {
        toast.info(`Nothing changed since version ${saved.version}`, {
          description: 'Change the circuit, its form or its symbol first; the version stays.',
        })
        return
      }
      toast.success(`Model ${saved.name} saved in “${meta.library.trim()}” (version ${saved.version})`, {
        description: 'The library offers it in its category; make a part from it with a datasheet.',
        action: { label: 'Make a part', onClick: () => openComponentWizard({ template: saved.id }) },
      })
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      if (!replace && /already/.test(text))
        toast.error(`“${meta.library.trim()}” has a model ${meta.name.trim()} already`, {
          description: 'Give the new model another name, or replace that one.',
          action: { label: 'Replace it', onClick: () => void save(true) },
        })
      else toast.error(`Cannot save: ${text}`)
    } finally {
      setBusy(false)
    }
  }
  const pins = Boolean(sheet?.labels.some((l) => l.kind === 'port'))
  const ready = !busy && pins && Boolean(meta.name.trim()) && Boolean(meta.library.trim())
  return { sheet, meta, setMeta, inPlace, editedId, save, ready, pins }
}

/**
 * Over the sheet while a model is edited: what is being edited, saving it and the way back to
 * the part it was opened from.
 */
export function ModelBar(): ReactNode {
  const { sheet, meta, setMeta, inPlace, editedId, save, ready, pins } = useSaveModel()
  if (!sheet) return null
  const back = (use?: string) => {
    window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'componentWizard' }))
    if (use) window.dispatchEvent(new CustomEvent('bpt:use-model', { detail: use }))
  }
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b bg-accent/40 px-3 py-1 text-xs"
      data-testid="model-bar"
    >
      <span className="font-medium" data-testid="model-editing">
        {inPlace
          ? `Editing model: ${meta.name} (version ${meta.version})`
          : meta.basedOn
            ? `New model based on ${meta.basedOn}`
            : `New model: ${meta.name || sheet.name}`}
      </span>
      <Button
        size="sm"
        variant="ghost"
        className="h-6 px-2 text-xs"
        title="The model's name, parameters, symbol and preview"
        onClick={showPanel}
      >
        Its form
      </Button>
      {!pins && <span className="text-destructive">A model needs pins.</span>}
      <span className="ml-auto flex flex-wrap items-center gap-1">
        {inPlace ? (
          <>
            <Button size="sm" className="h-6 px-2 text-xs" disabled={!ready} onClick={() => void save(true)}>
              Save as version {(meta.version ?? 0) + 1}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              disabled={!ready}
              title="Keep the model as it is and save this circuit as a new one (give it a name in its form)"
              onClick={() => {
                setMeta({ name: `${meta.name.trim()} (copy)`, editing: '', basedOn: meta.name })
                showPanel()
              }}
            >
              Save as a new model…
            </Button>
          </>
        ) : (
          <Button size="sm" className="h-6 px-2 text-xs" disabled={!ready} onClick={() => void save(false)}>
            {editedId ? 'Save as a new model' : 'Save model'}
          </Button>
        )}
        {meta.fromPart && meta.savedNew && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            title={`The part you were making uses ${meta.savedNew.slice(4)} from now on; its points stay`}
            onClick={() => back(meta.savedNew)}
          >
            Use it in the part
          </Button>
        )}
        {meta.fromPart && (
          <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => back()}>
            Back to the part
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          title="Stop editing the model. A saved model's sheet leaves the project (Undo brings it back); unsaved changes stay on it."
          onClick={() => void closeModel()}
        >
          Close
        </Button>
      </span>
    </div>
  )
}

/** The model's name, where it goes and what changed. */
function SaveTemplate({
  sheet,
  meta,
  setMeta,
}: {
  sheet: Sheet
  meta: TemplateMeta
  setMeta: (patch: Partial<TemplateMeta>) => void
}) {
  const categories = useCategories()
  const changes = useTemplateEditor((s) => s.changes)
  // A new sheet: the model takes its name.
  useEffect(() => {
    if (!meta.name) setMeta({ name: sheet.name })
  }, [meta.name, sheet.name, setMeta])
  const editedId = meta.editing ?? ''
  const inPlace = Boolean(editedId) && `tpl:${meta.library.trim()}/${meta.name.trim()}` === editedId
  return (
    <Section title="Model">
      <div className="grid grid-cols-[5rem_1fr] items-center gap-1 text-xs">
        <span className="text-muted-foreground">Name</span>
        <Input
          aria-label="Model name"
          className="h-7 text-xs"
          value={meta.name}
          onChange={(e) => setMeta({ name: e.target.value })}
        />
        <span className="text-muted-foreground">Library</span>
        <Input
          aria-label="Model library"
          className="h-7 text-xs"
          value={meta.library}
          onChange={(e) => setMeta({ library: e.target.value })}
        />
        <span className="text-muted-foreground">Kind</span>
        <select
          aria-label="Model kind"
          className="h-7 rounded-md border bg-background px-1"
          value={meta.kind}
          onChange={(e) => setMeta({ kind: e.target.value as ComponentKind })}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">Category</span>
        <select
          aria-label="Model category"
          className="h-7 rounded-md border bg-background px-1"
          value={meta.category}
          onChange={(e) => setMeta({ category: e.target.value })}
        >
          <option value="">from its kind</option>
          {categories.map((c) => (
            <option key={c.path} value={c.path}>
              {c.path.includes('/') ? ` ${c.path.split('/')[1]}` : c.path}
            </option>
          ))}
        </select>
        <span className="text-muted-foreground">Description</span>
        <Input
          aria-label="Model description"
          className="h-7 text-xs"
          value={meta.description}
          onChange={(e) => setMeta({ description: e.target.value })}
        />
      </div>
      {inPlace && (
        <div className="grid grid-cols-[5rem_1fr] items-center gap-1 text-xs">
          <span className="text-muted-foreground">What changed</span>
          <Input
            aria-label="What changed"
            className="h-7 text-xs"
            placeholder="e.g. ESR from the 100 kHz point"
            value={changes}
            onChange={(e) => useTemplateEditor.setState({ changes: e.target.value })}
          />
        </div>
      )}
      {editedId && !inPlace && (
        <p className="text-[11px] text-muted-foreground">
          Another name or library than {editedId.slice(4)}: a new model; the one opened stays as it is.
        </p>
      )}
    </Section>
  )
}
