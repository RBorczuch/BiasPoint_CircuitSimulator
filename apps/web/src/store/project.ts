import { toast } from 'sonner'
import { create } from 'zustand'
import { ApiError, apiDelete, apiGet, apiPost } from '@/api/client'
import { events } from '@/api/events'
import type {
  Command,
  ErcIssue,
  LibraryPart,
  ModelCard,
  Project,
  ProjectInfo,
  RecoveryInfo,
  Sheet,
  SubcktModel,
  SymbolDef,
} from '@/api/types'
import { choose, pickProjectPath } from './dialogs'
import { flashObjects } from './editor'

interface ProjectState {
  info: ProjectInfo | null
  project: Project | null
  revision: number
  symbols: Map<string, SymbolDef>
  /** Models of the user's libraries (and built-in ones), to copy into the project with a part. */
  libraryModels: LibraryModels
  issues: ErcIssue[]
  connected: boolean
  sheetName: string
  ready: boolean
  init: () => Promise<void>
  refresh: () => Promise<void>
  execute: (command: Command) => Promise<boolean>
  undo: () => Promise<void>
  redo: () => Promise<void>
  /** Undo or redo until `done` steps are applied (a click in the history panel). */
  goTo: (done: number) => Promise<void>
  save: (path?: string) => Promise<void>
  /** Instance path through which a block sheet is seen ("X2", "X2.X1"); null = first use. */
  viewPath: string[] | null
  /** Show another sheet of the project in the schematic editor (through a block path). */
  setSheet: (name: string, path?: string[] | null) => void
  /** Unsaved changes: ask to save or discard; false = the user wants to stay. */
  confirmLeave: () => Promise<boolean>
  newProject: (name: string) => Promise<void>
  openProject: (path: string) => Promise<void>
  /** A KiCad schematic (.kicad_sch) opened as a new, unsaved project. */
  importKicadSchematic: (path: string) => Promise<void>
  openExample: (name: string) => Promise<void>
  importNetlist: (text: string) => Promise<void>
}

let history: Promise<void> = Promise.resolve()

/** Commands sent but not answered yet: undo waits for them (a fast Ctrl+Z after an edit). */
let inFlight: Promise<unknown> = Promise.resolve()

/** Edits sent but not answered yet (a run started right after typing a value waits for it). */
export const pendingEdits = (): Promise<unknown> => inFlight

/** One undo or redo step; nothing (and no message) when the history is exhausted. */
async function step(kind: 'undo' | 'redo' | number): Promise<void> {
  await inFlight
  const { info, refresh } = useProject.getState()
  // The backend decides whether there is anything to undo: the state here may lag behind.
  if (!info) return
  // A number: undo or redo until that many steps are applied (history panel).
  const path = typeof kind === 'number' ? `undo?to=${kind}` : kind
  try {
    await own(() => apiPost(`/api/projects/${info?.id}/${path}`))
    await refresh()
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) return // another client got there first
    fail(error)
  }
}

/** Project the user chose not to save: closed in the backend when another one is shown, so
 * its autosave copy is not offered again after a restart. */
let discarded: string | null = null

let recovering: Promise<ProjectInfo | null> | null = null

/** Unsaved projects left by a crash or a backend restart: offer to restore them (once at a time). */
function offerRecovery(): Promise<ProjectInfo | null> {
  recovering ??= (async () => {
    const entries = await apiGet<RecoveryInfo[]>('/api/recovery').catch(() => [] as RecoveryInfo[])
    if (!entries.length) return null
    const names = entries
      .map((e) => `“${e.name}” (${new Date(e.saved_at * 1000).toLocaleString()})`)
      .join(', ')
    const answer = await choose({
      title: 'Restore unsaved projects',
      description: `BiasPoint stopped while these projects had unsaved changes: ${names}. Restore them as they were at the last autosave?`,
      choices: [
        { label: 'Discard changes', value: 'discard', variant: 'outline' },
        { label: 'Not now', value: 'later', variant: 'outline' },
        { label: 'Restore', value: 'restore' },
      ],
    })
    if (answer === 'discard') {
      await Promise.all(entries.map((e) => apiDelete(`/api/recovery/${e.id}`).catch(() => null)))
      return null
    }
    if (answer !== 'restore') return null
    const restored: ProjectInfo[] = []
    for (const e of entries) restored.push(await apiPost<ProjectInfo>(`/api/recovery/${e.id}/restore`))
    toast.success(`Restored ${restored.map((p) => p.name).join(', ')}`, {
      description: 'They are not saved yet: save them to keep the changes.',
    })
    return restored[0] ?? null
  })().finally(() => {
    recovering = null
  })
  return recovering
}

const fail = (error: unknown) => toast.error(error instanceof Error ? error.message : String(error))

let issuesTimer: ReturnType<typeof setTimeout> | undefined

/** Own document requests in flight: doc.changed events arriving outside them come from elsewhere. */
let ownPending = 0
/** A request of this window that changes the document (not a command): its change is no news. */
export async function own<T>(request: () => Promise<T>): Promise<T> {
  ownPending++
  try {
    return await request()
  } finally {
    // The event of our own change can arrive just after the response.
    setTimeout(() => {
      ownPending--
    }, 300)
  }
}

/** Ids touched by a command (for highlighting changes made by an agent or another window). */
export function commandIds(command: unknown): string[] {
  if (!command || typeof command !== 'object') return []
  const c = command as Record<string, unknown>
  if (c.type === 'transaction' && Array.isArray(c.commands)) return c.commands.flatMap(commandIds)
  const ids: string[] = []
  if (typeof c.id === 'string') ids.push(c.id)
  if (Array.isArray(c.ids)) ids.push(...c.ids.filter((x): x is string => typeof x === 'string'))
  for (const kind of ['instances', 'wires', 'junctions', 'labels', 'directives']) {
    const items = c[kind]
    if (Array.isArray(items))
      ids.push(...items.map((i) => (i as { id?: string }).id).filter((x): x is string => !!x))
  }
  return ids
}

export const useProject = create<ProjectState>((set, get) => {
  const projectPath = (suffix: string) => `/api/projects/${get().info?.id}${suffix}`

  const loadIssues = () => {
    clearTimeout(issuesTimer)
    issuesTimer = setTimeout(async () => {
      if (!get().info) return
      try {
        const netlist = await apiGet<{ issues: ErcIssue[] }>(projectPath('/circuit/netlist'))
        set({ issues: netlist.issues })
      } catch {
        // ERC is advisory; keep the previous list
      }
    }, 250)
  }

  const activate = async (info: ProjectInfo) => {
    const dropped = discarded
    discarded = null
    if (dropped && dropped !== info.id) void apiDelete(`/api/projects/${dropped}`).catch(() => null)
    set({ info, project: null, revision: -1 })
    await get().refresh()
    await followLinkedParts()
  }

  /** Back online: if the backend restarted without our project, restore or reopen it. */
  const reconnect = async () => {
    const info = get().info
    if (!info) return
    try {
      if ((await apiGet<ProjectInfo[]>('/api/projects')).some((p) => p.id === info.id))
        return await get().refresh()
      const recovered = await offerRecovery()
      const projects = await apiGet<ProjectInfo[]>('/api/projects')
      const same = projects.find((p) => p.id === info.id)
      if (same) return await get().refresh() // restored under the same id: carry on
      if (info.path && !info.dirty)
        return await activate(await apiPost<ProjectInfo>('/api/projects/open', { path: info.path }))
      await activate(
        recovered ?? projects[0] ?? (await apiPost<ProjectInfo>('/api/projects', { name: 'untitled' })),
      )
    } catch (error) {
      fail(error)
    }
  }

  return {
    info: null,
    project: null,
    revision: -1,
    symbols: new Map(),
    libraryModels: { models: {}, subcircuits: {} },
    issues: [],
    connected: false,
    sheetName: 'root',
    viewPath: null,
    ready: false,

    init: async () => {
      // The backend keeps (and autosaves) the work, but closing the tab should not surprise anyone.
      window.addEventListener('beforeunload', (e) => {
        if (get().info?.dirty) e.preventDefault()
      })
      events.onStatus((connected) => {
        set({ connected })
        if (connected) void reconnect()
      })
      events.on((event) => {
        if (
          event.type === 'doc.changed' &&
          event.project_id === get().info?.id &&
          event.revision !== get().revision
        ) {
          void get().refresh()
          if (ownPending === 0) {
            const ids = commandIds(event.command)
            if (ids.length) flashObjects(ids)
            toast('Changed by another client', {
              description: 'An AI agent or another window edited this project.',
              action: { label: 'Undo', onClick: () => void get().undo() },
              duration: 4000,
            })
          }
        }
      })
      events.connect()
      try {
        const [symbols, libraryModels] = await Promise.all([
          apiGet<SymbolDef[]>('/api/library/symbols'),
          apiGet<LibraryModels>('/api/library/models'),
        ])
        set({ symbols: new Map(symbols.map((s) => [s.id, s])), libraryModels })
        const [recovered, listed] = await Promise.all([
          offerRecovery(),
          apiGet<ProjectInfo[]>('/api/projects'),
        ])
        const projects = recovered ? await apiGet<ProjectInfo[]>('/api/projects') : listed
        const wanted = new URLSearchParams(location.search).get('project')
        const info =
          projects.find((p) => p.id === wanted) ??
          recovered ??
          projects[0] ??
          (await apiPost<ProjectInfo>('/api/projects', { name: 'untitled' }))
        await activate(info)
        set({ ready: true })
      } catch (error) {
        fail(error)
      }
    },

    refresh: async () => {
      const { info, revision } = get()
      if (!info) return
      try {
        const [doc, infos] = await Promise.all([
          apiGet<{ revision: number; project: Project | null }>(projectPath(`/document?since=${revision}`)),
          apiGet<ProjectInfo[]>('/api/projects'),
        ])
        const fresh = infos.find((p) => p.id === info.id) ?? info
        // Another project opened meanwhile, or a later refresh already brought a newer
        // revision: this answer is stale (it used to overwrite the newer document).
        if (get().info?.id !== info.id) return
        if (doc.project && doc.revision >= get().revision) {
          const sheetName = doc.project.sheets.some((s) => s.name === get().sheetName)
            ? get().sheetName
            : (doc.project.sheets[0]?.name ?? 'root')
          set({ project: doc.project, revision: doc.revision, info: fresh, sheetName })
          loadIssues()
          void loadBlocks()
        } else {
          set({ info: fresh })
        }
      } catch (error) {
        fail(error)
      }
    },

    execute: (command) => {
      discarded = null // edited again: no longer abandoned
      const run = (async () => {
        try {
          const owned = ownedSheetOf(command)
          if (owned) {
            toast.info(`“${owned.sheet}” belongs to the library part ${owned.owner.split('/').pop()}`, {
              description: 'It is read-only here. “Make a copy” on the sheet makes it editable.',
            })
            return false
          }
          const prepared = await withComponents(command)
          await own(() => apiPost(projectPath('/commands'), { command: withLibrarySymbols(prepared) }))
          await get().refresh()
          return true
        } catch (error) {
          fail(error)
          return false
        }
      })()
      inFlight = Promise.all([inFlight, run])
      return run
    },

    // Undo/redo run one after another: holding Ctrl+Z must not race past the end of history.
    undo: () => (history = history.then(() => step('undo'))),
    redo: () => (history = history.then(() => step('redo'))),
    goTo: (done) => (history = history.then(() => step(done))),

    save: async (path) => {
      try {
        const info = await apiPost<ProjectInfo>(projectPath('/save'), { path: path ?? null })
        set({ info })
        toast.success(`Saved to ${info.path}`)
      } catch (error) {
        fail(error)
      }
    },

    setSheet: (name, path = null) => {
      if (get().project?.sheets.some((s) => s.name === name)) set({ sheetName: name, viewPath: path })
    },

    confirmLeave: async () => {
      const info = get().info
      if (!info?.dirty) return true
      const answer = await choose({
        title: 'Unsaved changes',
        description: `“${info.name}” has changes that are not saved. Don't save drops them.`,
        choices: [
          { label: 'Cancel', value: 'cancel', variant: 'outline' },
          { label: "Don't save", value: 'discard', variant: 'outline' },
          { label: info.path ? 'Save' : 'Save as…', value: 'save' },
        ],
      })
      if (answer === 'discard') {
        discarded = info.id // closed once another project is shown (the user may still cancel)
        return true
      }
      if (answer !== 'save') return false
      const path = info.path ?? (await pickProjectPath({ mode: 'save', name: info.name }))
      if (!path) return false
      await get().save(info.path ? undefined : path)
      return !get().info?.dirty
    },

    newProject: async (name) => {
      try {
        await activate(await apiPost<ProjectInfo>('/api/projects', { name }))
      } catch (error) {
        fail(error)
      }
    },

    openProject: async (path) => {
      try {
        await activate(await apiPost<ProjectInfo>('/api/projects/open', { path }))
      } catch (error) {
        fail(error)
      }
    },

    importKicadSchematic: async (path) => {
      try {
        const result = await apiPost<{ project: ProjectInfo; skipped: string[] }>(
          '/api/projects/import/kicad',
          {
            path,
          },
        )
        await activate(result.project)
        get().setSheet('root')
        toast.success(`Imported ${result.project.name}`, {
          description: result.skipped.length
            ? `Not brought over: ${result.skipped.slice(0, 4).join('; ')}${result.skipped.length > 4 ? '…' : ''}`
            : 'Save it to keep it as a BiasPoint project.',
          duration: 8000,
        })
      } catch (error) {
        fail(error)
      }
    },

    openExample: async (name) => {
      if (!(await get().confirmLeave())) return
      try {
        await activate(await apiPost<ProjectInfo>(`/api/library/examples/${name}/open`))
      } catch (error) {
        fail(error)
      }
    },

    importNetlist: async (text) => {
      try {
        const result = await own(() =>
          apiPost<{ refs: string[] }>(projectPath('/circuit/import'), {
            text,
            sheet: get().sheetName,
          }),
        )
        await get().refresh()
        toast.success(`Added ${result.refs.join(', ')}`)
      } catch (error) {
        fail(error)
      }
    },
  }
})

/** Symbols of this project's sheets with ports (blocks), merged into the library. */
/** Symbols of this project (copies of library parts, sheets as blocks), merged into the library. */
async function loadBlocks(): Promise<void> {
  const { info, symbols } = useProject.getState()
  if (!info) return
  try {
    // The project's own list wins, but drawings offered by the libraries stay on the menu.
    const own = (await apiGet<SymbolDef[]>(`/api/projects/${info.id}/symbols`)).map((s) => {
      const library = symbols.get(s.id)?.looks ?? []
      const names = new Set((s.looks ?? []).map((l) => l.name))
      const extra = library.filter((l) => !names.has(l.name))
      return extra.length ? { ...s, looks: [...(s.looks ?? []), ...extra] } : s
    })
    const ids = new Set(own.map((s) => s.id))
    const changed =
      own.some((s) => JSON.stringify(symbols.get(s.id)) !== JSON.stringify(s)) ||
      [...symbols.keys()].some((id) => id.startsWith('sheet:') && !ids.has(id))
    if (!changed) return
    const next = new Map([...symbols].filter(([id]) => !id.startsWith('sheet:')))
    for (const symbol of own) next.set(symbol.id, symbol)
    useProject.setState({ symbols: next })
  } catch {
    // keep the library as it is
  }
}

/** Parts used by reference follow the library: update their copies (one undo step). */
export async function followLinkedParts(): Promise<void> {
  const info = useProject.getState().info
  if (!info) return
  try {
    const parts = await apiGet<LibraryPart[]>(`/api/projects/${info.id}/library-parts`)
    const stale = parts.filter((p) => p.linked && p.library_version !== null && p.library_version > p.version)
    if (!stale.length) return
    await apiPost(`/api/projects/${info.id}/library-parts/update`, { ids: stale.map((p) => p.id) })
    await useProject.getState().refresh()
    toast(`Updated linked parts: ${stale.map((p) => p.name).join(', ')}`, {
      description: 'They follow their library. Undo keeps the old versions.',
      action: { label: 'Undo', onClick: () => void useProject.getState().undo() },
    })
  } catch {
    // the copies stay as they are
  }
}

/** A command that would edit a component's read-only sheet: which one. */
function ownedSheetOf(command: Command): { sheet: string; owner: string } | null {
  if (command.type === 'detach_component') return null
  const sheets = useProject.getState().project?.sheets ?? []
  const parts = command.type === 'transaction' ? command.commands : [command]
  for (const part of parts) {
    const name = 'sheet' in part && typeof part.sheet === 'string' ? part.sheet : null
    const sheet = name ? sheets.find((s) => s.name === name) : undefined
    if (sheet?.owner) return { sheet: sheet.name, owner: sheet.owner }
  }
  return null
}

/** Placing a library component brings its equivalent-circuit sheets: one undo step. */
async function withComponents(command: Command): Promise<Command> {
  const all = command.type === 'transaction' ? command.commands : [command]
  // Library parts placed (add_objects) or put in place of another part (update_instance).
  const ids = new Set(
    all
      .flatMap((c) =>
        c.type === 'add_objects'
          ? (c.instances ?? []).map((i) => i.symbol)
          : c.type === 'update_instance' && c.symbol
            ? [c.symbol]
            : [],
      )
      .filter((s) => s.startsWith('cmp:')),
  )
  if (!ids.size) return command
  const info = useProject.getState().info
  const sheets: Command[] = []
  const tops = new Map<string, string>()
  for (const id of ids) {
    const placement = await apiPost<{ top: string; sheets: Sheet[] }>(
      `/api/projects/${info?.id}/components/prepare`,
      { id },
    )
    tops.set(id, placement.top)
    for (const sheet of placement.sheets) sheets.push({ type: 'add_sheet', sheet })
  }
  const remap = (c: Command): Command =>
    c.type === 'add_objects'
      ? {
          ...c,
          instances: c.instances?.map((i) =>
            tops.has(i.symbol) ? { ...i, symbol: `sheet:${tops.get(i.symbol)}` } : i,
          ),
        }
      : c.type === 'update_instance' && c.symbol && tops.has(c.symbol)
        ? { ...c, symbol: `sheet:${tops.get(c.symbol)}` }
        : c
  const label = command.type === 'transaction' && command.label ? command.label : 'place library part'
  return { type: 'transaction', label, commands: [...sheets, ...all.map(remap)] }
}

/** Reload the symbol library (after importing or removing a user library). */
export async function reloadLibrary(): Promise<void> {
  const [library, libraryModels] = await Promise.all([
    apiGet<SymbolDef[]>('/api/library/symbols'),
    apiGet<LibraryModels>('/api/library/models'),
  ])
  useProject.setState({ libraryModels })
  const next = new Map(library.map((s) => [s.id, s]))
  for (const [id, symbol] of useProject.getState().symbols) {
    if (id.startsWith('sheet:') || !next.has(id)) next.set(id, symbol) // project copies, blocks
  }
  useProject.setState({ symbols: next })
  await loadBlocks()
  await followLinkedParts()
}

const BUILT_IN = /^(bpt|sheet):/

export interface LibraryModels {
  models: Record<string, ModelCard>
  subcircuits: Record<string, SubcktModel>
}

/**
 * Placing a part from a user library (KiCad import, imported SPICE models) also stores a copy
 * of its symbol and of its model in the project, in the same undo step, so the project opens
 * and simulates without the library.
 */
function withLibrarySymbols(command: Command): Command {
  const { project, symbols, libraryModels } = useProject.getState()
  const owned = project?.symbols ?? {}
  const adds = command.type === 'add_objects' ? [command] : []
  if (command.type === 'transaction') adds.push(...command.commands.filter((c) => c.type === 'add_objects'))
  const missing = new Set<string>()
  // A placed library part brings sheets whose parts may be library symbols too (an imported
  // SPICE model inside its part).
  const sheets = command.type === 'add_sheet' ? [command.sheet] : []
  if (command.type === 'transaction')
    for (const c of command.commands) if (c.type === 'add_sheet') sheets.push(c.sheet)
  const placed = [...adds.flatMap((add) => add.instances ?? []), ...sheets.flatMap((sh) => sh.instances)]
  for (const inst of placed)
    if (!BUILT_IN.test(inst.symbol) && !owned[inst.symbol] && symbols.has(inst.symbol))
      missing.add(inst.symbol)
  if (missing.size === 0) return command
  const copies: Command[] = [...missing].map((id) => ({
    type: 'set_symbol',
    id,
    symbol: symbols.get(id) ?? null,
  }))
  for (const id of missing) {
    const model = symbols.get(id)?.default_model
    if (!model) continue
    const sub = libraryModels.subcircuits[model]
    const card = libraryModels.models[model]
    if (sub && !project?.subcircuits?.[model])
      copies.push({ type: 'set_subcircuit', name: model, subckt: sub })
    else if (card && !project?.models[model]) copies.push({ type: 'set_model', name: model, card })
  }
  return {
    type: 'transaction',
    label: command.type === 'transaction' ? command.label : 'add parts',
    commands: [...copies, ...(command.type === 'transaction' ? command.commands : [command])],
  }
}

export function currentSheet(state: Pick<ProjectState, 'project' | 'sheetName'>): Sheet | null {
  return state.project?.sheets.find((s) => s.name === state.sheetName) ?? null
}
