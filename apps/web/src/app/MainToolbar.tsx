/** Main toolbar under the menu bar; the right part depends on the workspace. */
import {
  Eye,
  EyeOff,
  FilePlus2,
  FlipHorizontal2,
  FlipVertical2,
  FolderOpen,
  Loader2,
  Maximize,
  Play,
  Redo2,
  RotateCw,
  Save,
  Square,
  Trash2,
  Undo2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { AnalysisKind } from '@/api/types'
import { Button } from '@/components/ui/button'
import { runAction, useKeymap } from '@/keymap/keymap'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'
import { ToolbarButton, ToolbarSeparator } from './ToolbarButton'

const KINDS: AnalysisKind[] = ['op', 'dc', 'ac', 'tran']

function SimulationControls() {
  const project = useProject((s) => s.project)
  const execute = useProject((s) => s.execute)
  const { job, showOp } = useSimulation()
  const runKey = useKeymap((s) => s.bindings)()['sim.run']?.[0]
  const running = job?.status === 'queued' || job?.status === 'running'
  const simulation = project?.simulation
  return (
    <>
      <fieldset className="flex rounded-md border-0 bg-muted p-0.5" aria-label="Analysis">
        {KINDS.map((kind) => (
          <button
            type="button"
            key={kind}
            aria-pressed={simulation?.active === kind}
            disabled={!simulation}
            onClick={() =>
              simulation && execute({ type: 'set_simulation', simulation: { ...simulation, active: kind } })
            }
            className={`rounded px-2 py-0.5 font-mono text-xs ${simulation?.active === kind ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            {kind.toUpperCase()}
          </button>
        ))}
      </fieldset>
      {running ? (
        <Button size="sm" variant="destructive" className="h-8" onClick={() => runAction('sim.cancel')}>
          <Loader2 className="animate-spin" /> Stop
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-8 bg-emerald-600 text-white hover:bg-emerald-500"
          onClick={() => runAction('sim.run')}
          title={`Run simulation (${runKey ?? ''})`}
        >
          <Play /> Run
        </Button>
      )}
      <ToolbarButton action="sim.cancel" icon={<Square />} disabled={!running} />
      <ToolbarButton action="sim.toggleOp" icon={showOp ? <Eye /> : <EyeOff />} active={showOp} />
      <ToolbarButton action="sim.clearTraces" icon={<Trash2 />} />
    </>
  )
}

export function MainToolbar({ workspace }: { workspace: 'schematic' | 'simulate' | 'analysis' }) {
  const info = useProject((s) => s.info)
  const hasSelection = useEditor((s) => s.selection.size > 0)
  return (
    <div
      className="flex h-10 shrink-0 items-center gap-0.5 border-b px-2"
      role="toolbar"
      aria-label="Main toolbar"
    >
      <ToolbarButton action="file.new" icon={<FilePlus2 />} />
      <ToolbarButton action="file.open" icon={<FolderOpen />} />
      <ToolbarButton action="file.save" icon={<Save />} />
      <ToolbarSeparator />
      <ToolbarButton action="edit.undo" icon={<Undo2 />} disabled={!info?.can_undo} />
      <ToolbarButton action="edit.redo" icon={<Redo2 />} disabled={!info?.can_redo} />
      <ToolbarSeparator />
      {workspace === 'schematic' ? (
        <>
          {/* Schematic view only: the other workspaces have their own zoom controls. */}
          <ToolbarButton action="view.zoomIn" icon={<ZoomIn />} />
          <ToolbarButton action="view.zoomOut" icon={<ZoomOut />} />
          <ToolbarButton action="view.fit" icon={<Maximize />} />
          <ToolbarSeparator />
          <ToolbarButton action="edit.rotate" icon={<RotateCw />} disabled={!hasSelection} />
          <ToolbarButton action="edit.mirrorX" icon={<FlipHorizontal2 />} disabled={!hasSelection} />
          <ToolbarButton action="edit.mirrorY" icon={<FlipVertical2 />} disabled={!hasSelection} />
          <ToolbarButton action="edit.delete" icon={<Trash2 />} disabled={!hasSelection} />
        </>
      ) : workspace === 'simulate' ? (
        <SimulationControls />
      ) : null}
    </div>
  )
}
