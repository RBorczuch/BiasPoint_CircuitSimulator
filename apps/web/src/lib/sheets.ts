/** Adding, renaming and deleting sheets (each is one undo step). */
import { toast } from 'sonner'
import { apiPost } from '@/api/client'
import type { Sheet } from '@/api/types'
import { choose, prompt } from '@/store/dialogs'
import { useProject } from '@/store/project'
import { newId } from './ids'

// Sheets are files (sheets/<name>.json): letters, digits, space, _ and - only.
const VALID = /^[\p{L}\p{N} _-]{1,40}$/u

function checkName(name: string, except?: string): string | null {
  const sheets = useProject.getState().project?.sheets ?? []
  if (!VALID.test(name)) return 'use letters, digits, spaces, _ or - (up to 40)'
  if (sheets.some((s) => s.name.toLowerCase() === name.toLowerCase() && s.name !== except))
    return `a sheet named “${name}” already exists`
  return null
}

export async function addSheet(): Promise<void> {
  const { project, execute, setSheet } = useProject.getState()
  if (!project) return
  let suggestion = `sheet ${project.sheets.length + 1}`
  for (let n = project.sheets.length + 2; project.sheets.some((s) => s.name === suggestion); n++)
    suggestion = `sheet ${n}`
  const name = (await prompt({ title: 'New sheet', label: 'Sheet name', initial: suggestion }))?.trim()
  if (!name) return
  const problem = checkName(name)
  if (problem) {
    toast.error(`Cannot add the sheet: ${problem}`)
    return
  }
  const sheet = { id: newId(), name, instances: [], wires: [], junctions: [], labels: [], directives: [] }
  if (await execute({ type: 'add_sheet', sheet })) setSheet(name)
}

export async function renameSheet(name: string): Promise<void> {
  const next = (await prompt({ title: 'Rename sheet', label: 'New name', initial: name }))?.trim()
  if (!next || next === name) return
  const problem = checkName(next, name)
  if (problem) {
    toast.error(`Cannot rename: ${problem}`)
    return
  }
  const { execute, setSheet, sheetName } = useProject.getState()
  if ((await execute({ type: 'rename_sheet', name, new_name: next })) && sheetName === name) setSheet(next)
}

export async function removeSheet(name: string): Promise<void> {
  const { project, execute, setSheet, sheetName } = useProject.getState()
  if (!project) return
  if (project.sheets.length === 1) {
    toast.error('A project needs at least one sheet')
    return
  }
  const sheet = project.sheets.find((s) => s.name === name)
  const used = sheet ? sheet.instances.length + sheet.wires.length + sheet.labels.length : 0
  const uses = blockUses(project.sheets, name)
  if (used || uses.length) {
    const asBlock = uses.length
      ? ` It is placed as a block (${uses.join(', ')}); those blocks stop working.`
      : ''
    const answer = await choose({
      title: `Delete sheet “${name}”?`,
      description: `It has ${sheet?.instances.length ?? 0} parts and ${sheet?.wires.length ?? 0} wires.${asBlock} Undo (Ctrl+Z) brings it back.`,
      choices: [
        { label: 'Delete', value: 'delete', variant: 'destructive' },
        { label: 'Cancel', value: 'cancel', variant: 'outline' }, // last = focused: Enter keeps it
      ],
    })
    if (answer !== 'delete') return
  }
  if (sheetName === name) setSheet(project.sheets.find((s) => s.name !== name)?.name ?? 'root')
  await execute({ type: 'remove_sheet', name })
}

// -- hierarchy ---------------------------------------------------------------------------------

const BLOCK = 'sheet:'

/** Where a sheet sits in the hierarchy, from the top: [{sheet: 'root', ref: 'X1'}, …]; [] at the top. */
export function blockPath(sheets: Sheet[], name: string): { sheet: string; ref: string }[] {
  const path: { sheet: string; ref: string }[] = []
  let current = name
  for (let depth = 0; depth < 10; depth++) {
    // Seen through its first use, as the netlister and the results name it (X1.mid).
    const parent = sheets.find((s) => s.instances.some((i) => i.symbol === BLOCK + current))
    const block = parent?.instances.find((i) => i.symbol === BLOCK + current)
    if (!parent || !block) break
    path.unshift({ sheet: parent.name, ref: block.ref })
    current = parent.name
  }
  return path
}

/**
 * The path shown for the current sheet: the instance path it was entered through, when it
 * leads to this sheet, else the first use of the sheet.
 */
export function viewSteps(
  sheets: Sheet[],
  name: string,
  viewPath: string[] | null,
): { sheet: string; ref: string }[] {
  if (viewPath?.length) {
    const used = new Set(
      sheets.flatMap((s) =>
        s.instances.filter((i) => i.symbol.startsWith(BLOCK)).map((i) => i.symbol.slice(BLOCK.length)),
      ),
    )
    let candidates = sheets.filter((s) => !used.has(s.name))
    const steps: { sheet: string; ref: string }[] = []
    let inner = ''
    for (const ref of viewPath) {
      const found = candidates
        .map((s) => [s, s.instances.find((i) => i.ref === ref && i.symbol.startsWith(BLOCK))] as const)
        .find(([, i]) => i)
      if (!found?.[1]) break
      steps.push({ sheet: found[0].name, ref })
      inner = found[1].symbol.slice(BLOCK.length)
      candidates = sheets.filter((s) => s.name === inner)
    }
    if (steps.length === viewPath.length && inner === name) return steps
  }
  return blockPath(sheets, name)
}

/** Blocks placed from a sheet, as "root/X1" (for warnings before deleting it). */
export function blockUses(sheets: Sheet[], name: string): string[] {
  return sheets.flatMap((s) =>
    s.instances.filter((i) => i.symbol === BLOCK + name).map((i) => `${s.name}/${i.ref}`),
  )
}

/**
 * Selection -> a new sheet with ports, placed back as one block (one undo step). Nets that
 * join the selection to the rest become ports; ground and global nets stay global.
 */
export async function createBlock(ids: string[]): Promise<string | null> {
  const { project, sheetName, refresh } = useProject.getState()
  if (!project || ids.length === 0) {
    toast.info('Select the parts to put in the block first')
    return null
  }
  let suggestion = 'block 1'
  for (let n = 2; project.sheets.some((s) => s.name === suggestion); n++) suggestion = `block ${n}`
  const name = (
    await prompt({
      title: 'Create block from selection',
      label: 'Name of the new sheet (the block shows it)',
      initial: suggestion,
    })
  )?.trim()
  if (!name) return null
  const problem = checkName(name)
  if (problem) {
    toast.error(`Cannot create the block: ${problem}`)
    return null
  }
  try {
    const result = await apiPost<{ revision: number; ref: string; ports: string[] }>(
      `/api/projects/${useProject.getState().info?.id}/blocks`,
      { sheet: sheetName, ids, name },
    )
    await refresh()
    toast.success(
      result.ref
        ? `Block ${result.ref} (${name}) with ports ${result.ports.join(', ') || '–'}. Double-click it to open; Ctrl+Z undoes.`
        : `Moved to sheet ${name} (it joins the rest through global nets only)`,
    )
    return result.ref || null
  } catch (error) {
    toast.error(`Cannot create the block: ${error instanceof Error ? error.message : String(error)}`)
    return null
  }
}
