/** Show a signal's source on the schematic: its net highlighted, or its part selected. */
import { toast } from 'sonner'
import { apiGet } from '@/api/client'
import type { SheetNets } from '@/api/types'
import { activeEditor } from '@/editor/controller'
import { showOnSchematic } from '@/panels/IssueList'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'

const workspace = (name: string) => window.dispatchEvent(new CustomEvent('bpt:workspace', { detail: name }))

/** Highlight a net and bring its wires into view (on whichever sheet has it). */
export async function revealNet(net: string): Promise<boolean> {
  const { project, info } = useProject.getState()
  if (!project || !info) return false
  for (const sheet of project.sheets) {
    const nets = await apiGet<SheetNets>(
      `/api/projects/${info.id}/circuit/nets?sheet=${encodeURIComponent(sheet.name)}`,
    ).catch(() => null)
    if (!nets) continue
    const ids = Object.entries({ ...nets.wires, ...nets.labels })
      .filter(([, n]) => n.toLowerCase() === net.toLowerCase())
      .map(([id]) => id)
    if (!ids.length) continue
    useProject.getState().setSheet(sheet.name)
    workspace('schematic')
    useEditor.getState().setHighlightNet(net)
    setTimeout(() => activeEditor?.centerOn(new Set(ids)), 120)
    return true
  }
  return false
}

/** V(net) -> the net; I(R1), I(Q1.C) -> the part. Expressions show their first signal. */
export async function revealSignal(expr: string): Promise<void> {
  const voltage = /V\(([^),]+)\)/i.exec(expr)
  const current = /I\(([^).]+)(?:\.[^)]*)?\)/i.exec(expr)
  if (voltage && (await revealNet(voltage[1]))) return
  if (current) {
    const ref = current[1]
    const owner = useProject.getState().project?.sheets.some((s) => s.instances.some((i) => i.ref === ref))
    if (owner) {
      showOnSchematic([ref])
      return
    }
  }
  toast.info(`${expr} has no single place on the schematic`)
}
