/**
 * Library panel (FR-LIB-3, docs/projekt-elementy.md §4.1): parts in a tree of categories
 * (Capacitors → Ceramic…), in each the ideal part first, then the standard library, then the
 * user's; the templates of a category as "+ New … from a datasheet" rows in it. One "New" menu
 * for every way to make a part, a filter by origin, filters by the parts' data, and a view by
 * library for those who think in libraries.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BoxSelect,
  ChevronRight,
  Copy,
  FileInput,
  Filter,
  FolderCog,
  FolderTree,
  Import,
  Library,
  Pencil,
  PencilRuler,
  Plus,
  Search,
  Shapes,
  Share,
  Sigma,
  Trash2,
  Wand2,
} from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { apiGet } from '@/api/client'
import type { SymbolDef } from '@/api/types'
import { manageLibraries } from '@/app/LibraryManager'
import { importSpiceModels } from '@/app/SpiceImportDialog'
import { openComponentWizard, type TemplateInfo } from '@/components/ComponentWizard'
import { openEquationDevice } from '@/components/EquationDevice'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { runAction } from '@/keymap/keymap'
import {
  type CategoryInfo,
  type FieldFilter,
  fieldsOf,
  matches,
  subOf,
  topOf,
  useCategories,
} from '@/lib/categories'
import { t } from '@/lib/i18n'
import {
  exportLibrary,
  importKicadSymbols,
  importLibraryPackage,
  removeLibrary,
  removeLibraryItem,
} from '@/lib/library'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'
import { useRecentSymbols } from '@/store/recent'
import { editSymbol } from '@/symbol-editor/SymbolEditor'
import { FilterPanel } from './library/Filters'
import { type Origin, originOf, PartRow } from './library/PartRow'
import { drawNewTemplate, editTemplate } from './TemplatePanel'

/** Rows shown per group: big KiCad libraries have hundreds of symbols. */
const LIMIT = 60
const TOGGLED_KEY = 'bpt.library.toggled'
const SUBCIRCUITS = 'Project subcircuits'
type Source = 'all' | 'ideal' | 'standard' | 'mine'
const SOURCES: [Source, string][] = [
  ['all', 'All'],
  ['ideal', 'Ideal'],
  ['standard', 'Standard'],
  ['mine', 'Mine'],
]
const RANK: Record<Origin, number> = { ideal: 0, standard: 1, user: 2, sheet: 3 }

export function filterSymbols(symbols: SymbolDef[], query: string): SymbolDef[] {
  const q = query.trim().toLowerCase()
  if (!q) return symbols
  return symbols.filter((s) =>
    [
      s.name,
      s.id,
      s.ref_prefix,
      s.category,
      s.group ?? '',
      s.description ?? '',
      ...Object.values(s.metadata ?? {}),
    ].some((field) => field.toLowerCase().includes(q)),
  )
}

const fromSource = (source: Source, origin: Origin) =>
  source === 'all' ||
  (source === 'ideal' && origin === 'ideal') ||
  (source === 'standard' && origin === 'standard') ||
  (source === 'mine' && (origin === 'user' || origin === 'sheet'))

const templateOrigin = (t: TemplateInfo): Origin =>
  !t.library || t.library.startsWith('Standard') ? 'standard' : 'user'

/** Where a part is listed: its category, the project's subcircuits, or nowhere (not simulated). */
function groupOf(symbol: SymbolDef): string | null {
  // A placed library part's sheet is that part, not a subcircuit of the project.
  if (originOf(symbol) === 'sheet') return symbol.kind ? null : SUBCIRCUITS
  return symbol.group ?? null
}

function loadToggled(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(TOGGLED_KEY) ?? '[]'))
  } catch {
    return new Set()
  }
}

interface Node {
  path: string
  title: string
  parts: SymbolDef[]
  templates: TemplateInfo[]
  children: Node[]
  open: boolean // by default: it has an ideal part (the basics are in view)
}

export function LibraryPanel() {
  const symbols = useProject((s) => s.symbols)
  const recent = useRecentSymbols((s) => s.ids)
  const categories = useCategories()
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => apiGet<TemplateInfo[]>('/api/components/templates'),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<Source>('all')
  const [view, setView] = useState<'categories' | 'libraries'>('categories')
  const [filtering, setFiltering] = useState(false)
  const [filterCategory, setFilterCategory] = useState('')
  const [filters, setFilters] = useState<Record<string, FieldFilter>>({})
  const [toggled, setToggled] = useState<Set<string>>(loadToggled)

  const shown = useMemo(
    () => filterSymbols([...symbols.values()], query).filter((s) => fromSource(source, originOf(s))),
    [symbols, query, source],
  )
  const shownTemplates = useMemo(() => {
    const q = query.trim().toLowerCase()
    return templates.filter(
      (tp) =>
        source !== 'ideal' &&
        fromSource(source, templateOrigin(tp)) &&
        (!q || [tp.label, tp.kind, tp.library, tp.category ?? ''].some((f) => f.toLowerCase().includes(q))),
    )
  }, [templates, query, source])

  const tree = useMemo(
    () => buildTree(categories, shown, shownTemplates),
    [categories, shown, shownTemplates],
  )

  // Filters by data: the chosen category (and its subcategories) and its fields.
  const filterPaths = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of shown) {
      const g = groupOf(s)
      if (!g || g === SUBCIRCUITS) continue
      counts.set(topOf(g), (counts.get(topOf(g)) ?? 0) + 1)
      if (subOf(g)) counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    const order = categories.map((c) => c.path)
    return [...counts.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
  }, [shown, categories])
  const inFilterCategory = shown.filter((s) => {
    const g = groupOf(s)
    return !!g && (!filterCategory || g === filterCategory || g.startsWith(`${filterCategory}/`))
  })
  const filterFields = filterCategory ? fieldsOf(categories, filterCategory) : []
  const filtered = filtering && (filterCategory || Object.keys(filters).length > 0)
  const results = filtered ? inFilterCategory.filter((s) => matches(s, filterFields, filters)) : []

  const place = (symbol: SymbolDef) => {
    useEditor.getState().clearSelection()
    useEditor.getState().setTool({ kind: 'place', symbolId: symbol.id, rot: 0, mirror: false })
  }
  const toggle = (key: string) =>
    setToggled((s) => {
      const next = new Set(s)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      try {
        localStorage.setItem(TOGGLED_KEY, JSON.stringify([...next]))
      } catch {
        // not remembered in private mode
      }
      return next
    })
  // A search opens everything; otherwise the default, flipped by the user.
  const isOpen = (key: string, byDefault: boolean) => Boolean(query) || byDefault !== toggled.has(key)
  const fieldsFor = (s: SymbolDef) => fieldsOf(categories, groupOf(s) ?? '')
  const recentSymbols = query ? [] : recent.map((id) => symbols.get(id)).filter((s) => s !== undefined)
  const unlisted = shown.filter((s) => !groupOf(s) && originOf(s) !== 'ideal' && s.power_net === null).length

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <div className="flex gap-1">
        <div className="relative flex-1">
          <Search className="absolute top-2.5 left-2 size-4 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('library.search')}
            aria-label="Search parts"
            className="h-9 pl-8"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const first = firstPart(tree) ?? shown[0]
              if (first) place(first)
            }}
          />
        </div>
        <NewMenu />
      </div>
      <div className="flex items-center gap-1">
        <fieldset className="flex flex-1 gap-0.5" aria-label="Parts from">
          {SOURCES.map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={source === key}
              className={`rounded-full px-2 py-0.5 text-[11px] ${source === key ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent'}`}
              onClick={() => setSource(key)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        <button
          type="button"
          className={`rounded p-1 ${filtering ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          title="Filter by the parts' data (dielectric, voltage, package…)"
          aria-label="Filter by data"
          aria-pressed={filtering}
          onClick={() => setFiltering(!filtering)}
        >
          <Filter className="size-3.5" />
        </button>
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title={view === 'categories' ? 'Show by library' : 'Show by category'}
          aria-label={view === 'categories' ? 'Show by library' : 'Show by category'}
          onClick={() => setView(view === 'categories' ? 'libraries' : 'categories')}
        >
          {view === 'categories' ? <Library className="size-3.5" /> : <FolderTree className="size-3.5" />}
        </button>
      </div>
      {filtering && (
        <FilterPanel
          paths={filterPaths}
          category={filterCategory}
          onCategory={setFilterCategory}
          fields={filterFields}
          parts={inFilterCategory}
          filters={filters}
          onFilters={setFilters}
        />
      )}
      <ScrollArea className="min-h-0 flex-1">
        {filtered ? (
          <div data-testid="library-results">
            <p className="px-1 pb-1 text-[11px] text-muted-foreground">
              {results.length} part{results.length === 1 ? '' : 's'} match
            </p>
            {sortParts(results)
              .slice(0, LIMIT * 2)
              .map((s) => (
                <PartRow key={s.id} symbol={s} fields={fieldsFor(s)} onPlace={place} />
              ))}
          </div>
        ) : view === 'categories' ? (
          <>
            {recentSymbols.length > 0 && (
              <Group
                title="Recent"
                testid="Recent"
                open={isOpen('recent', true)}
                onToggle={() => toggle('recent')}
              >
                {recentSymbols.map((s) => (
                  <PartRow key={s.id} symbol={s} fields={fieldsFor(s)} onPlace={place} />
                ))}
              </Group>
            )}
            {tree.map((node) => (
              <CategoryGroup
                key={node.path}
                node={node}
                isOpen={isOpen}
                toggle={toggle}
                place={place}
                fieldsOf={(path) => fieldsOf(categories, path)}
              />
            ))}
            {unlisted > 0 && (
              <p className="px-1 pt-2 text-[11px] text-muted-foreground">
                {unlisted} more part{unlisted === 1 ? '' : 's'} (not simulated) only in the view by library.
              </p>
            )}
          </>
        ) : (
          <LibraryGroups parts={shown} isOpen={isOpen} toggle={toggle} place={place} fieldsFor={fieldsFor} />
        )}
      </ScrollArea>
    </div>
  )
}

/** The category tree with the parts and templates in it (only categories that have some). */
function buildTree(categories: CategoryInfo[], parts: SymbolDef[], templates: TemplateInfo[]): Node[] {
  const tops = new Map<string, Node>()
  const order = [...categories.map((c) => c.path), SUBCIRCUITS]
  const nodeOf = (path: string): Node => {
    const top = topOf(path)
    let node = tops.get(top)
    if (!node) {
      node = { path: top, title: top, parts: [], templates: [], children: [], open: false }
      tops.set(top, node)
    }
    const sub = subOf(path)
    if (!sub) return node
    let child = node.children.find((c) => c.path === path)
    if (!child) {
      child = { path, title: sub, parts: [], templates: [], children: [], open: false }
      node.children.push(child)
    }
    return child
  }
  for (const s of parts) {
    const g = groupOf(s)
    if (g) nodeOf(g).parts.push(s)
  }
  for (const tp of templates) nodeOf(tp.category || 'Other').templates.push(tp)
  const rank = (path: string) => {
    const i = order.indexOf(path)
    return i < 0 ? order.length : i
  }
  const out = [...tops.values()].sort((a, b) => rank(a.path) - rank(b.path))
  for (const node of out) {
    node.parts = sortParts(node.parts)
    node.children.sort((a, b) => rank(a.path) - rank(b.path))
    for (const child of node.children) {
      child.parts = sortParts(child.parts)
      child.open = child.parts.some((p) => originOf(p) === 'ideal')
    }
    node.open =
      node.path === SUBCIRCUITS ||
      node.parts.some((p) => originOf(p) === 'ideal') ||
      node.children.some((c) => c.open)
  }
  // Templates alone do not make a category worth showing at the top (it has no parts yet),
  // but they stay offered where parts are.
  return out.filter((n) => n.parts.length || n.children.some((c) => c.parts.length) || n.templates.length)
}

function sortParts(parts: SymbolDef[]): SymbolDef[] {
  return [...parts].sort(
    (a, b) =>
      RANK[originOf(a)] - RANK[originOf(b)] || a.name.localeCompare(b.name, undefined, { numeric: true }),
  )
}

function firstPart(tree: Node[]): SymbolDef | undefined {
  for (const node of tree) {
    if (node.parts[0]) return node.parts[0]
    for (const child of node.children) if (child.parts[0]) return child.parts[0]
  }
  return undefined
}

function Group({
  title,
  testid,
  count,
  open,
  onToggle,
  level = 0,
  actions,
  children,
}: {
  title: string
  testid: string
  count?: number
  open: boolean
  onToggle: () => void
  level?: 0 | 1
  actions?: ReactNode
  children: ReactNode
}) {
  return (
    <div className={`group/lib ${level ? 'ml-2' : 'mb-1.5'}`} data-testid={`library-group-${testid}`}>
      <div className="flex items-center gap-1 px-1 pb-0.5">
        <button
          type="button"
          className={`flex flex-1 items-center gap-1 text-left hover:text-foreground ${level ? 'pt-0.5 text-[11px] text-muted-foreground' : 'text-xs font-medium tracking-wide text-muted-foreground uppercase'}`}
          aria-expanded={open}
          onClick={onToggle}
        >
          <ChevronRight className={`size-3 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
          {title}
          {count !== undefined && count > 0 && (
            <span className="font-normal normal-case text-muted-foreground/70">({count})</span>
          )}
        </button>
        {actions}
      </div>
      {open && children}
    </div>
  )
}

function CategoryGroup({
  node,
  isOpen,
  toggle,
  place,
  fieldsOf,
}: {
  node: Node
  isOpen: (key: string, byDefault: boolean) => boolean
  toggle: (key: string) => void
  place: (s: SymbolDef) => void
  fieldsOf: (path: string) => ReturnType<typeof import('@/lib/categories').fieldsOf>
}) {
  const count = node.parts.length + node.children.reduce((n, c) => n + c.parts.length, 0)
  const key = `cat:${node.path}`
  return (
    <Group
      title={node.title}
      testid={node.path}
      count={count}
      open={isOpen(key, node.open)}
      onToggle={() => toggle(key)}
    >
      {node.parts.slice(0, LIMIT).map((s) => (
        <PartRow key={s.id} symbol={s} fields={fieldsOf(s.group ?? node.path)} onPlace={place} />
      ))}
      <TemplateRows templates={node.templates} />
      {node.children.map((child) => {
        const childKey = `cat:${child.path}`
        return (
          <Group
            key={child.path}
            title={child.title}
            testid={child.path}
            count={child.parts.length}
            level={1}
            open={isOpen(childKey, child.open)}
            onToggle={() => toggle(childKey)}
          >
            {child.parts.slice(0, LIMIT).map((s) => (
              <PartRow key={s.id} symbol={s} fields={fieldsOf(child.path)} onPlace={place} />
            ))}
            {child.parts.length > LIMIT && (
              <p className="px-2 text-[11px] text-muted-foreground">
                {child.parts.length - LIMIT} more – type to search
              </p>
            )}
            <TemplateRows templates={child.templates} />
          </Group>
        )
      })}
    </Group>
  )
}

/** "+ New … from a datasheet" for the templates of a category: opens the part maker with one. */
function TemplateRows({ templates }: { templates: TemplateInfo[] }) {
  const queries = useQueryClient()
  return templates.map((tp) => (
    <div key={tp.name} className="group/tpl relative" data-testid={`template-${tp.label}`}>
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
        title={`${tp.description}\nPins: ${tp.ports.join(', ')}. Make a real part from its datasheet with this equivalent circuit.`}
        onClick={() => openComponentWizard({ template: tp.name })}
      >
        <Plus className="size-3.5 shrink-0" />
        <span className="truncate">New: {tp.label}…</span>
      </button>
      <span className="absolute top-1/2 right-1 hidden -translate-y-1/2 gap-0.5 group-hover/tpl:flex">
        <button
          type="button"
          className="rounded p-1 text-muted-foreground hover:text-foreground"
          title={
            tp.library && !tp.library.startsWith('Standard')
              ? 'Edit this model (its circuit, form and symbol)'
              : 'A new model from this one (it opens as a sheet to change)'
          }
          aria-label={`Edit model ${tp.label}`}
          onClick={() => void editTemplate(tp.name)}
        >
          <Pencil className="size-3" />
        </button>
        {tp.library && !tp.library.startsWith('Standard') && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            title="A new model based on this one: its circuit opens as a sheet to change, this one stays"
            aria-label={`New model based on ${tp.label}`}
            onClick={() => void editTemplate(tp.name, { asNew: true })}
          >
            <Copy className="size-3" />
          </button>
        )}
        {tp.library && !tp.library.startsWith('Standard') && (
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-destructive"
            title="Remove this model from its library"
            aria-label={`Remove model ${tp.label}`}
            onClick={async () => {
              if (await removeLibraryItem('template', tp.name, tp.label))
                void queries.invalidateQueries({ queryKey: ['templates'] })
            }}
          >
            <Trash2 className="size-3" />
          </button>
        )}
      </span>
    </div>
  ))
}

/** View by library: every library as a whole (standard ones first, read-only). */
function LibraryGroups({
  parts,
  isOpen,
  toggle,
  place,
  fieldsFor,
}: {
  parts: SymbolDef[]
  isOpen: (key: string, byDefault: boolean) => boolean
  toggle: (key: string) => void
  place: (s: SymbolDef) => void
  fieldsFor: (s: SymbolDef) => ReturnType<typeof import('@/lib/categories').fieldsOf>
}) {
  const libraries = new Map<string, SymbolDef[]>()
  for (const s of parts) {
    const origin = originOf(s)
    const name = origin === 'ideal' ? 'Built-in (ideal)' : origin === 'sheet' ? SUBCIRCUITS : s.category
    libraries.set(name, [...(libraries.get(name) ?? []), s])
  }
  const entries = [...libraries.entries()].sort(
    ([a, x], [b, y]) => RANK[originOf(x[0])] - RANK[originOf(y[0])] || a.localeCompare(b),
  )
  return entries.map(([name, items]) => {
    const origin = originOf(items[0])
    const library = origin === 'standard' || origin === 'user'
    return (
      <Group
        key={name}
        title={name}
        testid={`lib:${name}`}
        count={items.length}
        open={isOpen(`lib:${name}`, false)}
        onToggle={() => toggle(`lib:${name}`)}
        actions={
          library && (
            <span className="flex gap-0.5 opacity-0 group-hover/lib:opacity-100 focus-within:opacity-100">
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                title={`Manage ${name}: rename, move or copy its items, change categories`}
                aria-label={`Manage library ${name}`}
                onClick={() => manageLibraries(name)}
              >
                <FolderCog className="size-3" />
              </button>
              <button
                type="button"
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                title={`Export ${name} as a .bptlib package (to share it)`}
                aria-label={`Export library ${name}`}
                onClick={() => void exportLibrary(name)}
              >
                <Share className="size-3" />
              </button>
              {origin === 'user' && (
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                  title={`Remove library ${name} (projects keep their copies)`}
                  aria-label={`Remove library ${name}`}
                  onClick={() => void removeLibrary(name)}
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </span>
          )
        }
      >
        {sortParts(items)
          .slice(0, LIMIT)
          .map((s) => (
            <PartRow key={s.id} symbol={s} fields={fieldsFor(s)} onPlace={place} />
          ))}
        {items.length > LIMIT && (
          <p className="px-2 text-[11px] text-muted-foreground">
            {items.length - LIMIT} more – type to search
          </p>
        )}
      </Group>
    )
  })
}

/** Every way to make a part, in one place. */
function NewMenu() {
  const selected = useEditor((s) => s.selection.size > 0)
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-9 gap-1 px-2" aria-label="New part">
          <Plus className="size-4" /> New
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuItem onSelect={() => openComponentWizard()}>
          <Wand2 /> Part from a datasheet (ready model)…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void importSpiceModels()}>
          <FileInput /> Part from a SPICE model…
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!selected}
          title={selected ? undefined : 'Select parts on the schematic first'}
          onSelect={() => runAction('edit.makePart')}
        >
          <BoxSelect /> Part from the selection…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void drawNewTemplate()}>
          <Shapes /> Draw a model (parametric circuit)…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openEquationDevice()}>
          <Sigma /> Device from equations…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => editSymbol(null)}>
          <PencilRuler /> Draw a symbol…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void importKicadSymbols()}>
          <Import /> Import KiCad symbols…
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void importLibraryPackage()}>
          <Library /> Import a library package (.bptlib)…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => manageLibraries()}>
          <FolderCog /> Manage libraries…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
