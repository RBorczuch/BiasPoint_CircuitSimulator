/**
 * Everything the command palette finds besides commands (Ctrl+K): parts, nets, signals of the
 * last run, sheets, analysis graphs and library parts. Choosing one goes there.
 */
import { Activity, Cable, CircleDot, FileText, Package, Workflow } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/api/client'
import type { SheetNets } from '@/api/types'
import { CommandGroup, CommandItem } from '@/components/ui/command'
import { activeEditor } from '@/editor/controller'
import { showOnSchematic } from '@/panels/IssueList'
import { filterSymbols } from '@/panels/LibraryPanel'
import { useEditor } from '@/store/editor'
import { useGraph } from '@/store/graph'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'

const LIMIT = 30 // per group: the palette is for jumping, not browsing

const workspace = (name: string) => window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: name }))

interface NetHit {
  net: string
  sheet: string
  ids: string[] // wires and labels of the net on that sheet
}

/** Nets of every sheet (loaded when a search starts). */
function useNets(active: boolean): NetHit[] {
  const project = useProject((s) => s.project)
  const info = useProject((s) => s.info)
  const [nets, setNets] = useState<NetHit[]>([])
  useEffect(() => {
    if (!active || !project || !info) return
    let cancelled = false
    void Promise.all(
      project.sheets.map(async (sheet) => {
        const found = await apiGet<SheetNets>(
          `/api/projects/${info.id}/circuit/nets?sheet=${encodeURIComponent(sheet.name)}`,
        ).catch(() => null)
        const byNet = new Map<string, string[]>()
        for (const [id, net] of Object.entries({ ...found?.wires, ...found?.labels }))
          byNet.set(net, [...(byNet.get(net) ?? []), id])
        return [...byNet.entries()].map(([net, ids]) => ({ net, sheet: sheet.name, ids }))
      }),
    ).then((lists) => !cancelled && setNets(lists.flat()))
    return () => {
      cancelled = true
    }
  }, [active, project, info])
  return nets
}

export function SearchGroups({ query, close }: { query: string; close: () => void }) {
  const project = useProject((s) => s.project)
  const symbols = useProject((s) => s.symbols)
  const meta = useSimulation((s) => s.meta)
  const q = query.trim().toLowerCase()
  const nets = useNets(q.length > 0)
  const has = (...fields: (string | undefined)[]) => fields.some((f) => f?.toLowerCase().includes(q))

  const parts = useMemo(
    () =>
      (project?.sheets ?? []).flatMap((sheet) =>
        sheet.instances
          .filter((i) => !i.ref.startsWith('#'))
          .map((i) => ({ inst: i, sheet: sheet.name, symbol: symbols.get(i.symbol) })),
      ),
    [project, symbols],
  )
  if (!q || !project) return null

  const go = (fn: () => void) => {
    close()
    setTimeout(fn, 0)
  }
  const foundParts = parts
    .filter(({ inst, symbol }) => has(inst.ref, symbol?.name, ...Object.values(inst.model.params)))
    .slice(0, LIMIT)
  const foundNets = nets.filter((n) => has(n.net)).slice(0, LIMIT)
  const foundSignals = (meta?.signals ?? [])
    .filter((s) => s.name !== meta?.scale && has(s.name))
    .slice(0, LIMIT)
  const foundSheets = project.sheets.filter((s) => has(s.name))
  const foundGraphs = project.graphs.filter((g) => has(g.name))
  const foundLibrary = filterSymbols([...symbols.values()], q)
    .filter((s) => !s.id.startsWith('sheet:'))
    .slice(0, LIMIT)

  // `value` carries the query so cmdk keeps the items: they are filtered here already.
  return (
    <>
      {foundParts.length > 0 && (
        <CommandGroup heading="Parts">
          {foundParts.map(({ inst, sheet, symbol }) => (
            <CommandItem
              key={inst.id}
              value={`part ${inst.ref} ${q}`}
              onSelect={() => go(() => showOnSchematic([inst.ref]))}
            >
              <CircleDot />
              {inst.ref}
              <span className="text-muted-foreground">
                {symbol?.name}
                {symbol?.value_param && inst.model.params[symbol.value_param]
                  ? ` · ${inst.model.params[symbol.value_param]}`
                  : ''}
                {project.sheets.length > 1 ? ` · ${sheet}` : ''}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {foundNets.length > 0 && (
        <CommandGroup heading="Nets">
          {foundNets.map((hit) => (
            <CommandItem
              key={`${hit.sheet}/${hit.net}`}
              value={`net ${hit.sheet} ${hit.net} ${q}`}
              onSelect={() =>
                go(() => {
                  useProject.getState().setSheet(hit.sheet)
                  workspace('schematic')
                  useEditor.getState().setHighlightNet(hit.net)
                  toast(`Net ${hit.net} highlighted`, { duration: 2000 })
                  setTimeout(() => activeEditor?.centerOn(new Set(hit.ids)), 50)
                })
              }
            >
              <Cable />
              {hit.net}
              {project.sheets.length > 1 && <span className="text-muted-foreground">{hit.sheet}</span>}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {foundSignals.length > 0 && (
        <CommandGroup heading="Signals (last run)">
          {foundSignals.map((signal) => (
            <CommandItem
              key={signal.name}
              value={`signal ${signal.name} ${q}`}
              onSelect={() =>
                go(() => {
                  useSimulation.getState().addTrace(signal.name)
                  workspace('simulate')
                })
              }
            >
              <Activity />
              {signal.name}
              <span className="text-muted-foreground">plot</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {foundSheets.length > 0 && (
        <CommandGroup heading="Sheets">
          {foundSheets.map((sheet) => (
            <CommandItem
              key={sheet.id}
              value={`sheet ${sheet.name} ${q}`}
              onSelect={() =>
                go(() => {
                  useProject.getState().setSheet(sheet.name)
                  workspace('schematic')
                })
              }
            >
              <FileText />
              {sheet.name}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {foundGraphs.length > 0 && (
        <CommandGroup heading="Analysis graphs">
          {foundGraphs.map((graph) => (
            <CommandItem
              key={graph.name}
              value={`graph ${graph.name} ${q}`}
              onSelect={() =>
                go(() => {
                  useGraph.getState().setActive(graph.name)
                  workspace('analysis')
                })
              }
            >
              <Workflow />
              {graph.name}
            </CommandItem>
          ))}
        </CommandGroup>
      )}
      {foundLibrary.length > 0 && (
        <CommandGroup heading="Place from the library">
          {foundLibrary.map((symbol) => (
            <CommandItem
              key={symbol.id}
              value={`library ${symbol.id} ${q}`}
              onSelect={() =>
                go(() => {
                  workspace('schematic')
                  useEditor.getState().clearSelection()
                  useEditor.getState().setTool({ kind: 'place', symbolId: symbol.id, rot: 0, mirror: false })
                })
              }
            >
              <Package />
              {symbol.name}
              <span className="text-muted-foreground">{symbol.category}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      )}
    </>
  )
}
