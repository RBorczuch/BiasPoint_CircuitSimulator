/** Project tree: sheets, analysis graphs, snapshots and the pictures sent to the AI agent. */
import {
  Bot,
  Camera,
  FileText,
  Link,
  Link2Off,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Workflow,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost } from '@/api/client'
import type { LibraryPart, SnapshotInfo } from '@/api/types'
import { Button } from '@/components/ui/button'
import { addSheet, removeSheet, renameSheet } from '@/lib/sheets'
import { cn } from '@/lib/utils'
import { prompt } from '@/store/dialogs'
import { useGraph } from '@/store/graph'
import { followLinkedParts, useProject } from '@/store/project'

interface CaptureInfo {
  id: string
  created: string
  source: 'agent' | 'user'
  comment: string
  read: boolean
}

function Heading({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between px-2 pt-3 pb-1">
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</p>
      {action}
    </div>
  )
}

const go = (workspace: string) =>
  window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: workspace }))

export function ProjectPanel() {
  const project = useProject((s) => s.project)
  const info = useProject((s) => s.info)
  const current = useProject((s) => s.sheetName)
  const setSheet = useProject((s) => s.setSheet)
  const revision = useProject((s) => s.revision)
  const [captures, setCaptures] = useState<CaptureInfo[]>([])
  const [snapshots, setSnapshots] = useState<SnapshotInfo[]>([])
  const [listed, setListed] = useState(0) // bumped to reload the snapshots
  const [parts, setParts] = useState<LibraryPart[]>([])
  const symbols = useProject((s) => s.symbols)

  // biome-ignore lint/correctness/useExhaustiveDependencies: copies change with the document, versions with the library
  useEffect(() => {
    if (!info) return
    apiGet<LibraryPart[]>(`/api/projects/${info.id}/library-parts`)
      .then(setParts)
      .catch(() => setParts([]))
  }, [info?.id, revision, symbols])

  const updateParts = async (ids: string[]) => {
    if (!info || !ids.length) return
    try {
      await apiPost(`/api/projects/${info.id}/library-parts/update`, { ids })
      await useProject.getState().refresh()
      toast.success(
        `Updated ${ids.length === 1 ? parts.find((p) => p.id === ids[0])?.name : `${ids.length} parts`}`,
        {
          action: { label: 'Undo', onClick: () => void useProject.getState().undo() },
        },
      )
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }
  const newer = (p: LibraryPart) => p.library_version !== null && p.library_version > p.version

  // biome-ignore lint/correctness/useExhaustiveDependencies: agent snapshots appear with its changes
  useEffect(() => {
    if (!info) return
    apiGet<SnapshotInfo[]>(`/api/projects/${info.id}/snapshots`)
      .then(setSnapshots)
      .catch(() => setSnapshots([]))
  }, [info?.id, revision, listed])

  const takeSnapshot = async () => {
    if (!info) return
    const label = await prompt({ title: 'Take snapshot', label: 'Name', initial: 'Snapshot' })
    if (label === null) return
    await apiPost(`/api/projects/${info.id}/snapshots`, { label })
    setListed((n) => n + 1)
  }

  const restoreSnapshot = async (shot: SnapshotInfo) => {
    if (!info) return
    try {
      await apiPost(`/api/projects/${info.id}/snapshots/${shot.id}/restore`)
      await useProject.getState().refresh()
      toast.success(`Back to “${shot.label}”`, {
        description: new Date(shot.created * 1000).toLocaleString(),
        action: { label: 'Undo', onClick: () => void useProject.getState().undo() },
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh the inbox when the project changes
  useEffect(() => {
    if (!info) return
    apiGet<CaptureInfo[]>(`/api/projects/${info.id}/captures`)
      .then((list) =>
        setCaptures(
          list
            .filter((c) => c.source === 'user')
            .slice(-20)
            .reverse(),
        ),
      )
      .catch(() => setCaptures([]))
  }, [info?.id, revision])

  if (!project) return null
  return (
    <div className="h-full overflow-auto p-1 text-sm" data-testid="project-panel">
      <div className="px-2 pt-2">
        <p className="font-medium">{project.name}</p>
        <p className="truncate text-xs text-muted-foreground" title={info?.path ?? undefined}>
          {info?.path ?? 'not saved yet'}
        </p>
      </div>

      <Heading
        title="Sheets"
        action={
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Add sheet"
            onClick={() => void addSheet()}
          >
            <Plus />
          </Button>
        }
      />
      <ul>
        {project.sheets
          .filter((sheet) => !sheet.owner)
          .map((sheet) => (
            <li key={sheet.id} className="group flex items-center">
              <button
                type="button"
                onClick={() => {
                  setSheet(sheet.name)
                  go('schematic')
                }}
                className={cn(
                  'flex min-w-0 flex-1 items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent',
                  sheet.name === current && 'bg-muted font-medium',
                )}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{sheet.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{sheet.instances.length} parts</span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                title={`Rename ${sheet.name}`}
                aria-label={`Rename ${sheet.name}`}
                onClick={() => void renameSheet(sheet.name)}
              >
                <Pencil />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                title={`Delete ${sheet.name}`}
                aria-label={`Delete ${sheet.name}`}
                disabled={project.sheets.length === 1}
                onClick={() => void removeSheet(sheet.name)}
              >
                <Trash2 />
              </Button>
            </li>
          ))}
      </ul>
      {project.sheets.length > 1 && (
        <p className="px-2 pt-1 text-[11px] text-muted-foreground">
          Sheets connect through global labels and power symbols; local labels stay on their sheet.
        </p>
      )}

      <Heading title="Analysis graphs" />
      {project.graphs.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">None yet – create one in the Analysis workspace.</p>
      ) : (
        <ul>
          {project.graphs.map((graph) => (
            <li key={graph.name}>
              <button
                type="button"
                onClick={() => {
                  useGraph.getState().setActive(graph.name)
                  go('analysis')
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-accent"
              >
                <Workflow className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{graph.name}</span>
                <span className="ml-auto text-xs text-muted-foreground">{graph.nodes.length} nodes</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <Heading
        title="Library parts"
        action={
          parts.some(newer) ? (
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => void updateParts(parts.filter(newer).map((p) => p.id))}
            >
              Update all
            </Button>
          ) : undefined
        }
      />
      {parts.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          None – parts from your libraries are copied here when placed.
        </p>
      ) : (
        <ul aria-label="Library parts">
          {parts.map((part) => (
            <li key={part.id} className="group flex items-center gap-2 px-2 py-1 text-xs">
              <div
                className="min-w-0 flex-1"
                title={part.changes ? `What changed: ${part.changes}` : undefined}
              >
                <p className="truncate">
                  {part.name} <span className="text-muted-foreground">· {part.library}</span>
                </p>
                <p className="text-muted-foreground">
                  v{part.version}
                  {newer(part) && (
                    <span className="text-primary"> → v{part.library_version} in the library</span>
                  )}
                  {part.library_version === null && ' · not in a library any more'}
                  {` · ${part.used} placed`}
                </p>
              </div>
              {newer(part) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  title={`Update to v${part.library_version}${part.changes ? `: ${part.changes}` : ''}`}
                  aria-label={`Update ${part.name}`}
                  onClick={() => void updateParts([part.id])}
                >
                  <RefreshCw />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  'size-6',
                  !part.linked && 'opacity-0 group-hover:opacity-100 focus:opacity-100',
                )}
                title={
                  part.linked
                    ? 'Follows the library (reference): updated when it changes. Click to keep a fixed copy.'
                    : 'A fixed copy: updated only on request. Click to follow the library.'
                }
                aria-label={`${part.linked ? 'Unlink' : 'Link'} ${part.name}`}
                aria-pressed={part.linked}
                onClick={() =>
                  void apiPost(`/api/projects/${info?.id}/library-parts/link`, {
                    id: part.id,
                    linked: !part.linked,
                  })
                    .then(async () => {
                      await useProject.getState().refresh()
                      if (!part.linked) await followLinkedParts()
                    })
                    .catch((error) => toast.error(`Cannot change the link: ${String(error)}`))
                }
              >
                {part.linked ? <Link /> : <Link2Off />}
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Heading
        title="Snapshots"
        action={
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            title="Take a snapshot of the project now"
            aria-label="Take snapshot"
            onClick={() => void takeSnapshot()}
          >
            <Camera />
          </Button>
        }
      />
      {snapshots.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          None yet – one is taken before each series of AI agent changes.
        </p>
      ) : (
        <ul aria-label="Snapshots">
          {snapshots.map((shot) => (
            <li key={shot.id} className="group flex items-center gap-2 px-2 py-1 text-xs">
              {shot.origin === 'agent' ? (
                <Bot className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Camera className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate">{shot.label}</p>
                <p className="text-muted-foreground">{new Date(shot.created * 1000).toLocaleString()}</p>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                title="Go back to this snapshot (Undo returns)"
                aria-label={`Restore ${shot.label}`}
                onClick={() => void restoreSnapshot(shot)}
              >
                <RotateCcw />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-6 opacity-0 group-hover:opacity-100 focus:opacity-100"
                title="Delete this snapshot"
                aria-label={`Delete snapshot ${shot.label}`}
                onClick={() =>
                  void apiDelete(`/api/projects/${info?.id}/snapshots/${shot.id}`)
                    .then(() => setListed((n) => n + 1))
                    .catch((error) => toast.error(`Cannot delete the snapshot: ${String(error)}`))
                }
              >
                <Trash2 />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <Heading title="Sent to the agent" />
      {captures.length === 0 ? (
        <p className="px-2 text-xs text-muted-foreground">
          Nothing yet – press F9 to send a picture and a question.
        </p>
      ) : (
        <ul>
          {captures.map((c) => (
            <li key={c.id} className="flex items-start gap-2 px-2 py-1 text-xs">
              <Send
                className={cn('mt-0.5 size-3.5 shrink-0', c.read ? 'text-muted-foreground' : 'text-primary')}
              />
              <div className="min-w-0">
                <p className="truncate">{c.comment || '(no comment)'}</p>
                <p className="text-muted-foreground">
                  {new Date(c.created).toLocaleString()} · {c.read ? 'read by the agent' : 'not read yet'}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
