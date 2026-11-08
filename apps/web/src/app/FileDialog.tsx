/**
 * Open / Save project dialog, and the picker of KiCad symbol libraries to import. The browser
 * cannot list the disk, so folders come from the backend (/api/fs). Projects are folders
 * ending in .bpt; KiCad libraries are .kicad_sym files or .kicad_symdir folders.
 */
import { ArrowUp, Clock, FileText, Folder, FolderOpen, HardDrive, Home, Library, Zap } from 'lucide-react'
import { useEffect, useState } from 'react'
import { apiGet } from '@/api/client'
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
import { useDialogs } from '@/store/dialogs'

interface Entry {
  name: string
  path: string
  kind: 'dir' | 'project' | 'symbols' | 'file'
}

interface Listing {
  path: string
  parent: string | null
  entries: Entry[]
  roots: string[]
}

const SEP = /[\\/]/

/** Picking a file to import instead of a project. */
const PICK = {
  kicad: {
    kind: 'symbols',
    title: 'Import KiCad symbols',
    description:
      'Choose a symbol library: a .kicad_sym file or a .kicad_symdir folder (KiCad 6 or newer). Its symbols become a library you can use in every project.',
    full: /\.kicad_sym(dir)?[\\/]?$/i,
    empty: 'Select a KiCad symbol library',
    button: 'Import',
  },
  spice: {
    kind: 'file',
    title: 'Import SPICE models',
    description:
      'Choose a model file from a manufacturer (.lib, .mod, .sub, .cir…) written for ngspice, LTspice or PSpice. Next you choose the models and their symbols.',
    full: /\.(lib|mod|sub|cir|txt|model|sp|spi|inc|ckt|lb|mdl|subckt|net)$/i,
    empty: 'Select a SPICE model file',
    button: 'Next',
  },
  kicadSch: {
    kind: 'file',
    title: 'Import KiCad schematic',
    description:
      'Choose a .kicad_sch file (KiCad 6 or newer): the root sheet. Its sub-sheets, parts and wires become a new project; the original stays as it is.',
    full: /\.kicad_sch$/i,
    empty: 'Select a KiCad schematic',
    button: 'Import',
  },
  bptlib: {
    kind: 'file',
    title: 'Import library package',
    description:
      'Choose a .bptlib file: a BiasPoint library (symbols, models, parts) shared by someone or exported earlier.',
    full: /\.bptlib$/i,
    empty: 'Select a library package',
    button: 'Import',
  },
} as const

/** "C:\\a\\b" -> [["C:", "C:\\"], ["a", "C:\\a"], ["b", "C:\\a\\b"]] */
function crumbs(path: string): [string, string][] {
  const windows = /^[A-Za-z]:/.test(path)
  const sep = windows ? '\\' : '/'
  const parts = path.split(SEP).filter(Boolean)
  return parts.map((part, i) => {
    const head = parts.slice(0, i + 1).join(sep)
    return [part, windows ? (i === 0 ? head + sep : head) : `/${head}`]
  })
}

const join = (folder: string, name: string) =>
  `${folder.replace(/[\\/]+$/, '')}${folder.includes('\\') ? '\\' : '/'}${name}`

export function FileDialog() {
  const request = useDialogs((s) => s.file)
  const [listing, setListing] = useState<Listing | null>(null)
  const [recent, setRecent] = useState<{ name: string; path: string }[]>([])
  const [places, setPlaces] = useState<{ home?: string; default?: string; kicad?: string[] }>({})
  const [selected, setSelected] = useState<Entry | null>(null)
  const [name, setName] = useState('')
  const [typed, setTyped] = useState('')
  const [error, setError] = useState<string | null>(null)

  const browse = async (path?: string) => {
    try {
      const query = new URLSearchParams()
      if (path) query.set('path', path)
      if (request?.mode === 'kicad' || request?.mode === 'spice' || request?.mode === 'bptlib')
        query.set('kind', request.mode)
      if (request?.mode === 'kicadSch') query.set('kind', 'kicad_sch')
      if (request?.mode === 'saveLib') query.set('kind', 'bptlib')
      const result = await apiGet<Listing>(`/api/fs/list?${query}`)
      setListing(result)
      setTyped(result.path)
      setSelected(null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when a new request opens
  useEffect(() => {
    if (!request) return
    setName(request.name ?? 'untitled')
    void browse(request.folder)
    void apiGet<{ name: string; path: string }[]>('/api/fs/recent').then(setRecent, () => setRecent([]))
    void apiGet<{ path: string }>('/api/fs/default').then((d) =>
      setPlaces((p) => ({ ...p, default: d.path })),
    )
    if (request.mode === 'kicad')
      void apiGet<string[]>('/api/fs/kicad').then(
        (kicad) => setPlaces((p) => ({ ...p, kicad })),
        () => undefined,
      )
    void apiGet<Listing>('/api/fs/list?path=~').then(
      (home) => setPlaces((p) => ({ ...p, home: home.path })),
      () => undefined,
    )
  }, [request])

  if (!request) return null
  const save = request.mode === 'save' || request.mode === 'saveLib'
  const extension = request.mode === 'saveLib' ? '.bptlib' : '.bpt'
  const pick =
    request.mode === 'kicad' ||
    request.mode === 'spice' ||
    request.mode === 'bptlib' ||
    request.mode === 'kicadSch'
      ? PICK[request.mode]
      : null
  // Characters Windows does not allow in folder names (a path typed here belongs in the field above).
  const badName = save && /[\\/:*?"<>|]/.test(name)
  const target = save
    ? listing && name.trim() && !badName
      ? join(listing.path, name.trim().endsWith(extension) ? name.trim() : `${name.trim()}${extension}`)
      : null
    : selected?.kind === (pick ? pick.kind : 'project')
      ? selected.path
      : null

  const activate = (entry: Entry) => {
    if (entry.kind === 'symbols' || entry.kind === 'file') request.resolve(entry.path)
    else if (entry.kind === 'project' && !save) request.resolve(entry.path)
    else if (entry.kind === 'project' && save) setName(entry.name.replace(/\.bpt$/, ''))
    else void browse(entry.path)
  }

  return (
    <Dialog open onOpenChange={(open) => !open && request.resolve(null)}>
      <DialogContent className="flex h-[70vh] max-h-[640px] flex-col gap-3 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {request.mode === 'saveLib'
              ? 'Export library package'
              : save
                ? 'Save project as'
                : (pick?.title ?? 'Open project')}
          </DialogTitle>
          <DialogDescription>{pick?.description ?? 'Projects are folders ending in .bpt'}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-8"
            disabled={!listing?.parent}
            onClick={() => listing?.parent && browse(listing.parent)}
            aria-label="Up one folder"
          >
            <ArrowUp />
          </Button>
          <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto rounded-md border px-2 py-1 text-sm">
            {listing &&
              crumbs(listing.path).map(([label, path], i) => (
                <span key={path} className="flex items-center gap-0.5 whitespace-nowrap">
                  {i > 0 && <span className="text-muted-foreground">/</span>}
                  <button type="button" className="rounded px-1 hover:bg-accent" onClick={() => browse(path)}>
                    {label}
                  </button>
                </span>
              ))}
          </div>
        </div>
        <Input
          value={typed}
          className="h-8 font-mono text-xs"
          aria-label="Folder path"
          title="Folder to browse; Enter on a full path ending in .bpt opens or saves it directly"
          onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return
            // A full project path (pasted by someone who knows where it goes): use it as is.
            const full = pick?.full ?? (request.mode === 'saveLib' ? /\.bptlib$/i : /\.bpt[\\/]?$/i)
            if (full.test(typed.trim())) request.resolve(typed.trim().replace(/[\\/]$/, ''))
            else void browse(typed)
          }}
        />
        {error && <p className="text-xs text-destructive">{error}</p>}

        <div className="grid min-h-0 flex-1 grid-cols-[12rem_1fr] gap-3">
          <nav className="min-h-0 overflow-auto text-sm" aria-label="Places">
            <p className="px-2 pb-1 text-xs font-medium text-muted-foreground uppercase">Places</p>
            {places.default && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                onClick={() => browse(places.default)}
              >
                <Zap className="size-4" /> BiasPoint
              </button>
            )}
            {places.home && (
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                onClick={() => browse(places.home)}
              >
                <Home className="size-4" /> Home
              </button>
            )}
            {places.kicad?.map((folder) => (
              <button
                type="button"
                key={folder}
                title={folder}
                className="flex w-full items-center gap-2 truncate rounded px-2 py-1 hover:bg-accent"
                onClick={() => browse(folder)}
              >
                <Library className="size-4 shrink-0" /> <span className="truncate">KiCad symbols</span>
              </button>
            ))}
            {listing?.roots.map((root) => (
              <button
                type="button"
                key={root}
                className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-accent"
                onClick={() => browse(root)}
              >
                <HardDrive className="size-4" /> {root}
              </button>
            ))}
            {request.mode === 'open' && recent.length > 0 && (
              <>
                <p className="mt-3 px-2 pb-1 text-xs font-medium text-muted-foreground uppercase">Recent</p>
                {recent.map((r) => (
                  <button
                    type="button"
                    key={r.path}
                    title={r.path}
                    className="flex w-full items-center gap-2 truncate rounded px-2 py-1 hover:bg-accent"
                    onClick={() => request.resolve(r.path)}
                  >
                    <Clock className="size-4 shrink-0" /> <span className="truncate">{r.name}</span>
                  </button>
                ))}
              </>
            )}
          </nav>
          <ul className="min-h-0 overflow-auto rounded-md border p-1 text-sm" aria-label="Folder contents">
            {listing?.entries.length === 0 && <li className="p-3 text-muted-foreground">Empty folder</li>}
            {listing?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left ${selected?.path === entry.path ? 'bg-accent' : 'hover:bg-accent/60'}`}
                  onClick={() => {
                    setSelected(entry)
                    if (save && entry.kind === 'project') setName(entry.name.replace(/\.bpt$/, ''))
                  }}
                  onDoubleClick={() => activate(entry)}
                >
                  {entry.kind === 'project' ? (
                    <FolderOpen className="size-4 text-emerald-500" />
                  ) : entry.kind === 'symbols' ? (
                    <Library className="size-4 text-sky-500" />
                  ) : entry.kind === 'file' ? (
                    <FileText className="size-4 text-sky-500" />
                  ) : (
                    <Folder className="size-4 text-muted-foreground" />
                  )}
                  <span className={entry.kind === 'dir' ? '' : 'font-medium'}>{entry.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <DialogFooter className="items-center gap-2 sm:justify-between">
          {save ? (
            <div className="flex flex-1 items-center gap-2 text-sm">
              {request.mode === 'saveLib' ? 'File name' : 'Project name'}
              <Input
                aria-label={request.mode === 'saveLib' ? 'File name' : 'Project name'}
                value={name}
                autoFocus
                className="h-8 flex-1 font-mono"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={badName || undefined}
                onKeyDown={(e) => e.key === 'Enter' && target && request.resolve(target)}
              />
              {badName && (
                <span className="text-xs text-destructive">
                  no \ / : * ? " &lt; &gt; | – choose the folder above
                </span>
              )}
            </div>
          ) : (
            <span className="truncate font-mono text-xs text-muted-foreground">
              {target ?? pick?.empty ?? 'Select a .bpt project'}
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => request.resolve(null)}>
              Cancel
            </Button>
            <Button disabled={!target} onClick={() => target && request.resolve(target)}>
              {save ? 'Save' : (pick?.button ?? 'Open')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
