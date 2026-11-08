/** User libraries: importing KiCad symbols and removing a library. */
import { toast } from 'sonner'
import { apiDelete, apiGet, apiPost } from '@/api/client'
import { choose, pickProjectPath, prompt } from '@/store/dialogs'
import { reloadLibrary } from '@/store/project'

interface ImportReport {
  library: string
  imported: number
  simulated: number
  skipped: string[]
}

export async function importKicadSymbols(): Promise<void> {
  const path = await pickProjectPath({ mode: 'kicad' })
  if (!path) return
  const pending = toast.loading('Importing symbols…')
  try {
    const report = await apiPost<ImportReport>('/api/library/import/kicad', { path })
    await reloadLibrary()
    const drawnOnly = report.imported - report.simulated
    toast.success(
      `Library “${report.library}”: ${report.imported} symbols` +
        (drawnOnly ? ` (${drawnOnly} drawn only – no SPICE model)` : '') +
        (report.skipped.length ? `, ${report.skipped.length} skipped` : ''),
      { id: pending, duration: 6000 },
    )
  } catch (error) {
    toast.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`, { id: pending })
  }
}

/** Add a library from a .bptlib package (shared by someone, or exported earlier). */
export async function importLibraryPackage(): Promise<void> {
  const path = await pickProjectPath({ mode: 'bptlib' })
  if (!path) return
  try {
    const report = await apiPost<ImportReport>('/api/library/import/bptlib', { path })
    await reloadLibrary()
    toast.success(`Library “${report.library}”: ${report.imported} parts`)
  } catch (error) {
    toast.error(`Import failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Write a library as a .bptlib package to share it. */
export async function exportLibrary(name: string): Promise<void> {
  const path = await pickProjectPath({ mode: 'saveLib', name })
  if (!path) return
  try {
    await apiPost('/api/library/export', { library: name, path })
    toast.success(`Library “${name}” exported to ${path}`)
  } catch (error) {
    toast.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function removeLibrary(name: string): Promise<void> {
  const answer = await choose({
    title: `Remove library “${name}”?`,
    description:
      'Its symbols disappear from the library panel. Projects that use them keep their own copies and still work.',
    choices: [
      { label: 'Remove', value: 'remove', variant: 'destructive' },
      { label: 'Cancel', value: 'cancel', variant: 'outline' },
    ],
  })
  if (answer !== 'remove') return
  try {
    await apiDelete(`/api/library/libraries/${encodeURIComponent(name)}`)
    await reloadLibrary()
    toast.success(`Library “${name}” removed`)
  } catch (error) {
    toast.error(`Cannot remove the library: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Remove one component or template (``kind``) from its user library, after asking. */
export async function removeLibraryItem(
  kind: 'component' | 'template',
  id: string,
  name: string,
): Promise<boolean> {
  const answer = await choose({
    title: `Remove ${kind} “${name}”?`,
    description:
      kind === 'component'
        ? 'It disappears from the library. Projects where it is placed keep their own copy and still work.'
        : 'It disappears from the list of templates. Parts made from it stay as they are.',
    choices: [
      { label: 'Remove', value: 'remove', variant: 'destructive' },
      { label: 'Cancel', value: 'cancel', variant: 'outline' },
    ],
  })
  if (answer !== 'remove') return false
  try {
    await apiDelete(`/api/library/${kind}s?id=${encodeURIComponent(id)}`)
    if (kind === 'component') await reloadLibrary()
    toast.success(`${name} removed`)
    return true
  } catch (error) {
    toast.error(`Cannot remove ${name}: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

const failed = (what: string, error: unknown) =>
  toast.error(`${what} failed: ${error instanceof Error ? error.message : String(error)}`)

/** A copy of a library item under another name (a standard one goes to My parts). */
export async function duplicateItem(id: string, name: string): Promise<void> {
  const copy = await prompt({
    title: `Duplicate ${name}`,
    label: 'Name of the copy',
    initial: `${name} copy`,
  })
  if (!copy?.trim()) return
  try {
    const made = await apiPost<string>('/api/library/items/duplicate', { id, name: copy.trim() })
    await reloadLibrary()
    toast.success(`${copy.trim()} made in ${made.replace(/^\w+:/, '').split('/')[0]}`)
  } catch (error) {
    failed('Duplicate', error)
  }
}

/** Move (a standard item: copy) to another library, made when it does not exist. */
export async function moveItem(id: string, name: string, copy: boolean): Promise<void> {
  const to = await prompt({
    title: `${copy ? 'Copy' : 'Move'} ${name} to a library`,
    label: 'Library',
    initial: 'My parts',
  })
  if (!to?.trim()) return
  try {
    await apiPost('/api/library/items/move', { ids: [id], to: to.trim(), mode: copy ? 'copy' : 'move' })
    await reloadLibrary()
    toast.success(`${name} ${copy ? 'copied' : 'moved'} to “${to.trim()}”`)
  } catch (error) {
    failed(copy ? 'Copy' : 'Move', error)
  }
}

interface Usage {
  project: string
  path: string | null
  parts: number
  version: number
}

/** Where a part or symbol is placed: open projects and recent ones. */
export async function showWhereUsed(id: string, name: string): Promise<void> {
  try {
    const usage = await apiGet<Usage[]>(`/api/library/symbols/usage?id=${encodeURIComponent(id)}`)
    if (!usage.length) {
      toast.info(`${name} is not used in the open or recent projects`)
      return
    }
    toast(`${name} is used in ${usage.length} project${usage.length === 1 ? '' : 's'}`, {
      description: usage
        .map((u) => `${u.project}: ${u.parts} placed, version ${u.version}${u.path ? '' : ' (not saved)'}`)
        .join('\n'),
      duration: 12000,
    })
  } catch (error) {
    failed('Where used', error)
  }
}

/** One item as a .bptlib package, to share it without its whole library. */
export async function exportItem(id: string, name: string): Promise<void> {
  const path = await pickProjectPath({ mode: 'saveLib', name })
  if (!path) return
  try {
    await apiPost('/api/library/items/export', { ids: [id], path })
    toast.success(`${name} exported to ${path}`)
  } catch (error) {
    failed('Export', error)
  }
}
