import {
  type DockviewApi,
  DockviewReact,
  type DockviewReadyEvent,
  type IDockviewPanelProps,
  themeDark,
  themeLight,
} from 'dockview-react'
import 'dockview-react/dist/styles/dockview.css'
import { Activity, Moon, Send, Sun } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ComponentWizard, openComponentWizard } from '@/components/ComponentWizard'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { SchematicView } from '@/editor/SchematicView'
import { GraphPanel } from '@/graph/GraphPanel'
import { ACTIONS, type ActionId, registerActions, runAction, useKeymap } from '@/keymap/keymap'
import { t } from '@/lib/i18n'
import { importKicadSymbols, importLibraryPackage } from '@/lib/library'
import { useTheme } from '@/lib/theme'
import { ConsolePanel } from '@/panels/ConsolePanel'
import { HistoryPanel } from '@/panels/HistoryPanel'
import { LibraryPanel } from '@/panels/LibraryPanel'
import { LogPanel } from '@/panels/LogPanel'
import { ProblemsPanel } from '@/panels/ProblemsPanel'
import { ProjectPanel } from '@/panels/ProjectPanel'
import { PropertiesPanel } from '@/panels/PropertiesPanel'
import { SimulationPanel } from '@/panels/SimulationPanel'
import { ModelBar, TemplatePanel } from '@/panels/TemplatePanel'
import { WaveformPanel } from '@/panels/WaveformPanel'
import { pickProjectPath, prompt, useDialogs } from '@/store/dialogs'
import { useEditor } from '@/store/editor'
import { useGraph } from '@/store/graph'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'
import { useWorkspace, type Workspace } from '@/store/workspace'
import { editSymbol, SymbolEditor } from '@/symbol-editor/SymbolEditor'
import { Dialogs } from './Dialogs'
import { MainToolbar } from './MainToolbar'
import { openSendToAgent } from './SendToAgentDialog'
import { importSpiceModels } from './SpiceImportDialog'

const components: Record<string, React.FunctionComponent<IDockviewPanelProps>> = {
  schematic: () => <SchematicView />,
  library: () => <LibraryPanel />,
  properties: () => <PropertiesPanel />,
  problems: () => <ProblemsPanel />,
  console: () => <ConsolePanel />,
  simulation: () => <SimulationPanel />,
  waveforms: () => <WaveformPanel />,
  log: () => <LogPanel />,
  graph: () => <GraphPanel />,
  project: () => <ProjectPanel />,
  history: () => <HistoryPanel />,
  symbolEditor: () => <SymbolEditor />,
  componentWizard: () => <ComponentWizard />,
  templateEditor: () => <TemplatePanel />,
}

const PANEL_TITLES: Record<string, string> = {
  schematic: t('panel.schematic'),
  library: t('panel.library'),
  properties: t('panel.properties'),
  problems: t('panel.problems'),
  console: t('panel.console'),
  simulation: 'Simulation',
  waveforms: 'Waveforms',
  log: 'Log',
  graph: 'Analysis graph',
  project: 'Project',
  history: 'History',
  symbolEditor: 'Symbol editor',
  componentWizard: 'Part editor',
  templateEditor: 'Model editor',
}

let dock: DockviewApi | null = null
/** Editors that open as a tab on the whole window (the schematic stays a tab beside them). */
const FULL_WINDOW = new Set(['symbolEditor', 'componentWizard'])

/** Show a panel; if it was closed, add it back at its usual place. */
function openPanel(id: string): void {
  if (!dock) return
  const existing = dock.getPanel(id)
  if (existing) {
    existing.api.setActive()
    if (FULL_WINDOW.has(id) && !existing.api.isMaximized()) existing.api.maximize()
    return
  }
  const schematic = dock.getPanel('schematic') ? 'schematic' : undefined
  const bottom = ['waveforms', 'log', 'problems', 'console'].find((p) => p !== id && dock?.getPanel(p))
  let position: Parameters<DockviewApi['addPanel']>[0]['position']
  const left = dock.getPanel('project') ?? dock.getPanel('library')
  const main = dock.getPanel('schematic') ?? dock.getPanel('waveforms') ?? dock.getPanel('graph')
  if (FULL_WINDOW.has(id) && main)
    position = { referencePanel: main.id } // a full-size tab
  else if (id === 'history' && left) position = { referencePanel: left.id }
  else if (id === 'library' || id === 'simulation') position = { direction: 'left' }
  else if (id === 'properties')
    position = schematic ? { direction: 'right', referencePanel: schematic } : undefined
  else if (id === 'templateEditor')
    position = dock.getPanel('properties')
      ? { referencePanel: 'properties' } // beside the inspector
      : schematic
        ? { direction: 'right', referencePanel: schematic }
        : undefined
  else if (id !== 'schematic') {
    position = bottom
      ? { referencePanel: bottom }
      : schematic
        ? { direction: 'below', referencePanel: schematic }
        : undefined
  }
  dock.addPanel({ id, component: id, title: PANEL_TITLES[id], position })
  // The symbol editor opens on the whole window (the schematic stays a tab beside it).
  if (FULL_WINDOW.has(id)) dock.getPanel(id)?.api.maximize()
}

const LAYOUT_VERSION = 7

function defaultLayout(api: DockviewApi, workspace: Workspace): void {
  if (workspace === 'schematic') {
    api.addPanel({ id: 'schematic', component: 'schematic', title: t('panel.schematic') })
    api.addPanel({
      id: 'library',
      component: 'library',
      title: t('panel.library'),
      position: { direction: 'left' },
      initialWidth: 230,
      minimumWidth: 180,
    })
    api.addPanel({
      id: 'project',
      component: 'project',
      title: 'Project',
      position: { referencePanel: 'library' },
    })
    api.addPanel({
      id: 'history',
      component: 'history',
      title: 'History',
      position: { referencePanel: 'library' },
    })
    api.getPanel('library')?.api.setActive()
    api.addPanel({
      id: 'properties',
      component: 'properties',
      title: t('panel.properties'),
      position: { direction: 'right', referencePanel: 'schematic' },
      initialWidth: 280,
      minimumWidth: 220,
    })
    api.addPanel({
      id: 'problems',
      component: 'problems',
      title: t('panel.problems'),
      position: { direction: 'below', referencePanel: 'schematic' },
      initialHeight: 170,
    })
    api.addPanel({
      id: 'console',
      component: 'console',
      title: t('panel.console'),
      position: { referencePanel: 'problems' },
    })
  } else if (workspace === 'analysis') {
    api.addPanel({ id: 'graph', component: 'graph', title: 'Analysis graph' })
    api.addPanel({
      id: 'log',
      component: 'log',
      title: 'Log',
      position: { direction: 'below', referencePanel: 'graph' },
      initialHeight: 140,
    })
    api.getPanel('graph')?.api.setActive()
  } else {
    // No schematic here: signals are picked by net and part names (Add signal).
    api.addPanel({ id: 'waveforms', component: 'waveforms', title: 'Waveforms' })
    api.addPanel({
      id: 'simulation',
      component: 'simulation',
      title: 'Simulation',
      position: { direction: 'left', referencePanel: 'waveforms' },
      initialWidth: 290,
      minimumWidth: 240,
    })
    api.addPanel({
      id: 'log',
      component: 'log',
      title: 'Log',
      position: { direction: 'below', referencePanel: 'waveforms' },
      initialHeight: 170,
    })
    api.addPanel({
      id: 'problems',
      component: 'problems',
      title: t('panel.problems'),
      position: { referencePanel: 'log' },
    })
    api.addPanel({
      id: 'console',
      component: 'console',
      title: t('panel.console'),
      position: { referencePanel: 'log' },
    })
    api.getPanel('log')?.api.setActive()
    api.getPanel('waveforms')?.api.setActive()
  }
  api.getPanel('schematic')?.api.setActive()
}

/** Download a backend export of the open project (the browser keeps the file name). */
function exportFile(what: string): void {
  const { info, sheetName } = useProject.getState()
  if (!info) return
  const sep = what.includes('?') ? '&' : '?'
  const sheet = what.startsWith('schematic') ? `${sep}sheet=${encodeURIComponent(sheetName)}` : ''
  const a = document.createElement('a')
  a.href = `/api/projects/${info.id}/export/${what}${sheet}`
  a.download = ''
  a.click()
}

const WORKSPACE_LABEL = {
  schematic: 'workspace.schematic',
  simulate: 'workspace.simulate',
  analysis: 'workspace.analysis',
} as const

const layoutKey = (workspace: Workspace) => `bpt.layout.${LAYOUT_VERSION}.${workspace}`

function MenuItem({ action }: { action: ActionId }) {
  const keys = useKeymap((s) => s.bindings)()[action]
  const run = () => {
    if (runAction(action)) return
    // Schematic actions (place, rotate…) chosen in another workspace: go there and do it.
    window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: 'schematic' }))
    setTimeout(() => runAction(action), 400)
  }
  return (
    <DropdownMenuItem onSelect={() => setTimeout(run, 0)}>
      {ACTIONS[action].label}
      {keys?.[0] && <DropdownMenuShortcut>{keys[0]}</DropdownMenuShortcut>}
    </DropdownMenuItem>
  )
}

const MENUS: { title: string; items: (ActionId | '-')[] }[] = [
  {
    title: t('menu.file'),
    items: [
      'file.new',
      'file.open',
      'file.openExample',
      '-',
      'file.save',
      'file.saveAs',
      '-',
      'file.exportNetlist',
      'file.exportSvg',
      'file.exportPng',
      'file.exportBomCsv',
      'file.exportBomXlsx',
      '-',
      'file.importKicadSch',
      'file.importKicad',
      'file.importSpice',
      'file.importLibrary',
      'file.newSymbol',
      'file.newComponent',
      '-',
      'app.settings',
    ],
  },
  {
    title: t('menu.edit'),
    items: [
      'edit.undo',
      'edit.redo',
      '-',
      'edit.cut',
      'edit.copy',
      'edit.paste',
      'edit.duplicate',
      'edit.delete',
      '-',
      'edit.selectAll',
      'edit.makeBlock',
      'edit.rotate',
      'edit.mirrorX',
      'edit.mirrorY',
      '-',
      'edit.alignLeft',
      'edit.alignRight',
      'edit.alignTop',
      'edit.alignBottom',
      'edit.alignCenterX',
      'edit.alignCenterY',
      'edit.distributeX',
      'edit.distributeY',
    ],
  },
  {
    title: 'Place',
    items: [
      'place.symbol',
      'tool.wire',
      'tool.bus',
      'tool.label',
      'tool.globalLabel',
      'tool.portLabel',
      'place.ground',
      'place.power',
      'place.junction',
      '-',
      'place.resistor',
      'place.capacitor',
      'place.inductor',
      'place.diode',
      'place.vsource',
      'place.isource',
      'place.npn',
      'place.pnp',
      'place.nmos',
      'place.opamp',
      '-',
      'tool.directive',
    ],
  },
  {
    title: 'Simulate',
    items: ['sim.run', 'sim.cancel', '-', 'sim.probe', 'sim.toggleOp', 'sim.clearTraces'],
  },
  {
    title: t('menu.view'),
    items: ['view.fit', 'view.zoomIn', 'view.zoomOut', '-', 'view.theme', 'view.resetLayout'],
  },
  {
    title: t('menu.help'),
    items: ['app.guide', '-', 'app.sendToAgent', '-', 'app.palette', 'app.shortcuts', 'app.console'],
  },
]

const TOOL_HINTS: Record<string, string> = {
  select: 'Click to select, drag to move (wires follow), Alt+drag detaches from wires',
  wire: 'Click to add a corner, click a pin or wire to finish · / corner direction · Esc ends',
  bus: 'A bus only groups nets: name it D[0..7], connect members with wires labelled D0…D7 · Esc ends',
  place: 'Click to place · R rotate · X / Y mirror · Esc ends',
  label: 'Click a wire to label it (a ring shows it connects) · Esc ends',
  junction: 'Click a wire crossing to join the wires · Esc ends',
  directive: 'Click to place the directive · Esc cancels',
  probe: 'Click a wire (voltage) or a part (current) · Alt power · Shift sets the reference',
  highlight: 'Click a wire to highlight its net · Esc ends',
}

function StatusBar({ workspace }: { workspace: Workspace }) {
  const { connected, info, revision, issues } = useProject()
  const { cursor, view, tool, selection } = useEditor()
  const toolName = tool.kind === 'wire' && tool.bus ? 'bus' : tool.kind
  const errors = issues.filter((i) => i.severity === 'error').length
  const warnings = issues.length - errors
  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 overflow-hidden border-t bg-muted/40 px-3 font-mono text-xs whitespace-nowrap text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <span className={`size-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-destructive'}`} />
        {connected ? t('status.connected') : t('status.disconnected')}
      </span>
      <span>
        {info?.name ?? '—'}
        {info?.dirty ? ' •' : ''} rev {revision}
      </span>
      {workspace === 'schematic' ? (
        <span className="min-w-0 flex-1 truncate" title={TOOL_HINTS[toolName]}>
          <span className="text-foreground">{toolName}</span> · {TOOL_HINTS[toolName]}
        </span>
      ) : (
        <span className="flex-1" />
      )}
      {selection.size > 0 && <span>{selection.size} selected</span>}
      <span className={errors ? 'text-destructive' : ''}>
        ERC {errors}E {warnings}W
      </span>
      {workspace === 'schematic' && (
        <>
          <span>
            X {(cursor[0] / 100).toFixed(2)} Y {(cursor[1] / 100).toFixed(2)} mm
          </span>
          <span>{Math.round(view.scale * 1000)}%</span>
        </>
      )}
    </footer>
  )
}

export function AppShell() {
  const theme = useTheme((s) => s.theme)
  const toggleTheme = useTheme((s) => s.toggle)
  const info = useProject((s) => s.info)
  const [workspace, setWorkspace] = useState<Workspace>('schematic')
  const [fullEditor, setFullEditor] = useState(false) // a full-window editor is in front
  useEffect(() => useWorkspace.setState({ workspace }), [workspace])
  const api = useRef<DockviewApi | null>(null)

  const loadLayout = useCallback((target: DockviewApi, ws: Workspace) => {
    target.clear()
    try {
      const saved = localStorage.getItem(layoutKey(ws))
      if (saved) {
        target.fromJSON(JSON.parse(saved))
        return
      }
    } catch {
      // fall back to the default layout
    }
    defaultLayout(target, ws)
  }, [])

  const onReady = (event: DockviewReadyEvent) => {
    api.current = event.api
    dock = event.api
    loadLayout(event.api, workspace)
    // The full-window editors are maximized only while they are shown: going back to the
    // schematic tab beside them brings the library, inspector and other panels back.
    event.api.onDidActivePanelChange(({ panel }) => {
      if (!panel) return
      setFullEditor(FULL_WINDOW.has(panel.id))
      if (FULL_WINDOW.has(panel.id)) {
        if (!panel.api.isMaximized()) panel.api.maximize()
      } else if (event.api.hasMaximizedGroup()) {
        // Only a tab beside the editor brings the other panels back. A panel elsewhere getting
        // the focus back (the library after its New menu closed) leaves the editor as it is:
        // maximizing it again on the next click would move it and lose that click.
        const beside = [...FULL_WINDOW].some((id) => event.api.getPanel(id)?.group === panel.group)
        if (beside) event.api.exitMaximizedGroup()
      }
    })
    event.api.onDidLayoutChange(() => {
      try {
        localStorage.setItem(layoutKey(workspaceRef.current), JSON.stringify(event.api.toJSON()))
      } catch {
        // layout just isn't remembered
      }
    })
  }
  const workspaceRef = useRef(workspace)
  const switchWorkspace = (ws: Workspace) => {
    if (ws === workspaceRef.current) return
    workspaceRef.current = ws
    setWorkspace(ws)
    if (api.current) loadLayout(api.current, ws)
  }
  const switchWorkspaceRef = useRef(switchWorkspace)
  switchWorkspaceRef.current = switchWorkspace

  useEffect(() => {
    const onOpen = (e: Event) => openPanel(String((e as CustomEvent).detail))
    const onClose = (e: Event) => {
      const panel = dock?.getPanel(String((e as CustomEvent).detail))
      if (panel?.api.isMaximized()) panel.api.exitMaximized()
      panel?.api.close()
    }
    const onMaximize = (e: Event) => {
      const panel = dock?.getPanel(String((e as CustomEvent).detail))
      if (!panel) return
      if (panel.api.isMaximized()) panel.api.exitMaximized()
      else panel.api.maximize()
    }
    const onWorkspace = (e: Event) =>
      switchWorkspaceRef.current(String((e as CustomEvent).detail) as Workspace)
    window.addEventListener('bpt:open-panel', onOpen)
    window.addEventListener('bpt:close-panel', onClose)
    window.addEventListener('bpt:maximize-panel', onMaximize)
    window.addEventListener('bpt:workspace', onWorkspace)
    return () => {
      window.removeEventListener('bpt:open-panel', onOpen)
      window.removeEventListener('bpt:close-panel', onClose)
      window.removeEventListener('bpt:maximize-panel', onMaximize)
      window.removeEventListener('bpt:workspace', onWorkspace)
    }
  }, [])

  useEffect(
    () =>
      registerActions({
        // Undo/redo work in every workspace (schematic and graph edits share one history).
        'edit.undo': () => void useProject.getState().undo(),
        'edit.redo': () => void useProject.getState().redo(),
        'file.new': async () => {
          if (!(await useProject.getState().confirmLeave())) return
          const name = await prompt({ title: 'New project', label: 'Project name', initial: 'untitled' })
          if (name) await useProject.getState().newProject(name.trim())
        },
        'file.open': async () => {
          if (!(await useProject.getState().confirmLeave())) return
          const path = await pickProjectPath({ mode: 'open' })
          if (path) await useProject.getState().openProject(path)
        },
        'file.openExample': () => useDialogs.getState().setExamples(true),
        'file.importKicad': () => void importKicadSymbols(),
        'file.importSpice': () => void importSpiceModels(),
        'file.newSymbol': () => editSymbol(null),
        'file.newComponent': () => openComponentWizard(),
        'file.importLibrary': () => void importLibraryPackage(),
        'file.importKicadSch': async () => {
          if (!(await useProject.getState().confirmLeave())) return
          const path = await pickProjectPath({ mode: 'kicadSch' })
          if (path) await useProject.getState().importKicadSchematic(path)
        },
        'file.save': async () => {
          if (useProject.getState().info?.path) await useProject.getState().save()
          else runAction('file.saveAs')
        },
        'file.saveAs': async () => {
          const current = useProject.getState().info
          const folder = current?.path ? current.path.split(/[\\/]/).slice(0, -1).join('/') : undefined
          const path = await pickProjectPath({ mode: 'save', name: current?.name ?? 'untitled', folder })
          if (path) await useProject.getState().save(path)
        },
        'file.exportNetlist': () => exportFile('netlist'),
        'file.exportSvg': () => exportFile('schematic?format=svg'),
        'file.exportPng': () => exportFile('schematic?format=png&width=3000'),
        'file.exportBomCsv': () => exportFile('bom?format=csv'),
        'file.exportBomXlsx': () => exportFile('bom?format=xlsx'),
        'view.theme': () => useTheme.getState().toggle(),
        'view.resetLayout': () => {
          if (!dock) return
          try {
            localStorage.removeItem(layoutKey(workspaceRef.current))
          } catch {
            // nothing stored
          }
          dock.clear()
          defaultLayout(dock, workspaceRef.current)
        },
        // F5 runs what the workspace shows: the analysis graph in Analysis, the simulation elsewhere.
        'sim.run': () =>
          workspaceRef.current === 'analysis' ? useGraph.getState().run() : useSimulation.getState().run(),
        'sim.cancel': () =>
          workspaceRef.current === 'analysis'
            ? useGraph.getState().cancel()
            : useSimulation.getState().cancel(),
        'sim.toggleOp': () => useSimulation.getState().setShowOp(!useSimulation.getState().showOp),
        'sim.clearTraces': () => useSimulation.getState().clearTraces(),
        'app.palette': () => useDialogs.getState().setPalette(true),
        'app.shortcuts': () => useDialogs.getState().setShortcuts(true),
        'app.settings': () => useDialogs.getState().setSettings(true),
        'app.guide': () => useDialogs.getState().setGuide(true),
        'app.sendToAgent': () => void openSendToAgent(),
        'app.console': () => window.dispatchEvent(new CustomEvent('bpt:focus-console')),
      }),
    [],
  )

  return (
    <div className="flex h-svh flex-col bg-background text-foreground">
      <header className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <Activity className="mr-1 size-4 text-emerald-500" />
        <span className="mr-2 text-sm font-semibold">{t('app.title')}</span>
        {MENUS.map((menu) => (
          <DropdownMenu key={menu.title}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 font-normal">
                {menu.title}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-56">
              {menu.items.map((item, i) =>
                // biome-ignore lint/suspicious/noArrayIndexKey: static menu separators
                item === '-' ? <DropdownMenuSeparator key={i} /> : <MenuItem key={item} action={item} />,
              )}
              {menu.title === t('menu.view') && (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>Panels</DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    {Object.entries(PANEL_TITLES).map(([id, title]) => (
                      <DropdownMenuItem key={id} onSelect={() => openPanel(id)}>
                        {title}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        ))}
        <nav className="mx-auto flex gap-1 rounded-md bg-muted p-0.5" aria-label="Workspaces">
          {(['schematic', 'simulate', 'analysis'] as Workspace[]).map((ws) => (
            <button
              type="button"
              key={ws}
              // "Simulate workspace", not the same name as the Simulate menu (screen readers)
              aria-label={`${t(WORKSPACE_LABEL[ws])} workspace`}
              aria-pressed={workspace === ws}
              onClick={() => switchWorkspace(ws)}
              className={`rounded px-3 py-0.5 text-xs ${workspace === ws ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
            >
              {t(WORKSPACE_LABEL[ws])}
            </button>
          ))}
        </nav>
        <span className="truncate text-xs text-muted-foreground" title={info?.path ?? undefined}>
          {info ? (info.path ?? `${info.name} (unsaved)`) : 'no project'}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs"
          title="Send a picture of the window with your marks and a comment to the AI agent (F9)"
          onClick={() => void openSendToAgent()}
        >
          <Send /> Agent
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={toggleTheme}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun /> : <Moon />}
        </Button>
      </header>
      <MainToolbar workspace={workspace} />
      {workspace === 'schematic' && !fullEditor && <ModelBar />}
      <main className="min-h-0 flex-1">
        <DockviewReact
          components={components}
          onReady={onReady}
          theme={theme === 'dark' ? themeDark : themeLight}
        />
      </main>
      <StatusBar workspace={workspace} />
      <Dialogs />
    </div>
  )
}
