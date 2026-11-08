/** Right-click menu of the schematic; items depend on what was clicked (KiCad-style groups). */
import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { apiPost } from '@/api/client'
import { ACTIONS, type ActionId, runAction, useKeymap } from '@/keymap/keymap'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'

/** A block's circuit put in its place (one undo step). */
async function flattenBlock(id: string): Promise<void> {
  const { info, sheetName, refresh } = useProject.getState()
  if (!info || !id) return
  try {
    await apiPost(`/api/projects/${info.id}/flatten`, { sheet: sheetName, id })
    await refresh()
    toast.success('Block flattened', {
      description: 'Its pins became labels on the same nets; Ctrl+Z undoes.',
    })
  } catch (error) {
    toast.error(`Cannot flatten: ${error instanceof Error ? error.message : String(error)}`)
  }
}

import { useSimulation } from '@/store/simulation'
import { activeEditor } from './controller'

type Item = { label: string; run: () => void; key?: string; danger?: boolean } | '-'

function useItems(): Item[] {
  const menu = useEditor((s) => s.contextMenu)
  const bindings = useKeymap((s) => s.bindings)()
  const hasResults = useSimulation((s) => s.meta?.status === 'ok')
  const symbols = useProject((s) => s.symbols)
  const project = useProject((s) => s.project)
  if (!menu) return []
  const action = (id: ActionId, label?: string, danger = false): Item => ({
    label: label ?? ACTIONS[id].label,
    run: () => runAction(id),
    key: bindings[id]?.[0],
    danger,
  })
  const editor = activeEditor
  const { target, world } = menu
  switch (target.kind) {
    case 'instances': {
      const inst = project?.sheets.flatMap((s) => s.instances).find((i) => i.id === target.id)
      const symbol = inst ? symbols.get(inst.symbol) : undefined
      const isPart = Boolean(symbol?.spice)
      const block = inst?.symbol.startsWith('sheet:') ? inst.symbol.slice('sheet:'.length) : null
      return [
        ...(block
          ? [
              { label: `Open sheet “${block}”`, run: () => useProject.getState().setSheet(block) } as Item,
              {
                label: 'Flatten (put its circuit here)',
                run: () => void flattenBlock(inst?.id ?? ''),
              } as Item,
              '-' as const,
            ]
          : []),
        action('edit.properties', 'Properties…'),
        ...(isPart && !block && target.id
          ? [{ label: 'Edit value…', run: () => void editor?.editValue(target.id ?? '') } as Item]
          : []),
        '-',
        action('edit.rotate'),
        action('edit.mirrorX'),
        action('edit.mirrorY'),
        ...(hasResults && isPart
          ? (['-', { label: 'Probe current', run: () => editor?.probeAt(world) }] as Item[])
          : []),
        '-',
        action('edit.cut'),
        action('edit.copy'),
        action('edit.duplicate'),
        ...(isPart ? [action('edit.makeBlock'), action('edit.makePart')] : []),
        action('edit.delete', undefined, true),
      ]
    }
    case 'wires':
      return [
        ...(hasResults
          ? ([{ label: 'Probe voltage', run: () => editor?.probeAt(world) }, '-'] as Item[])
          : []),
        { label: 'Highlight net', run: () => editor?.highlightNetAt(world) },
        { label: 'Add label here…', run: () => void editor?.addLabelAt(world) },
        { label: 'Add junction here', run: () => void editor?.addJunctionAt(world) },
        '-',
        action('edit.drag', 'Drag'),
        action('edit.delete', undefined, true),
      ]
    case 'labels':
      return [
        { label: 'Edit net name…', run: () => void editor?.editLabel(target.id ?? '') },
        action('edit.properties', 'Properties…'),
        { label: 'Highlight net', run: () => editor?.highlightNetAt(world) },
        '-',
        action('edit.delete', undefined, true),
      ]
    case 'junctions':
    case 'directives':
      return [
        action('edit.properties', 'Properties…'),
        action('edit.move', 'Move'),
        '-',
        action('edit.delete', undefined, true),
      ]
    default:
      return [
        action('edit.paste'),
        '-',
        action('place.symbol'),
        action('place.ground'),
        action('place.power'),
        action('tool.wire'),
        action('tool.label'),
        '-',
        action('edit.selectAll'),
        action('view.fit'),
        ...(hasResults ? (['-', action('sim.probe')] as Item[]) : []),
      ]
  }
}

const close = () => useEditor.getState().setContextMenu(null)

export function ContextMenu() {
  const menu = useEditor((s) => s.contextMenu)
  const items = useItems()
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close()
      }
    }
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('pointerdown', onDown, true)
    ref.current?.querySelector('button')?.focus()
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('pointerdown', onDown, true)
    }
  }, [menu])

  if (!menu) return null
  // Keep the menu inside the window.
  const left = Math.min(menu.client[0], window.innerWidth - 230)
  const top = Math.min(menu.client[1], window.innerHeight - items.length * 30 - 16)
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 min-w-52 rounded-md border bg-popover p-1 text-sm text-popover-foreground shadow-md"
      style={{ left, top }}
    >
      {items.map((item, i) =>
        item === '-' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static separators
          <div key={i} className="-mx-1 my-1 h-px bg-border" />
        ) : (
          <button
            type="button"
            role="menuitem"
            key={item.label}
            className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-left outline-none hover:bg-accent focus:bg-accent ${item.danger ? 'text-destructive' : ''}`}
            onClick={() => {
              close()
              setTimeout(item.run, 0)
            }}
            onKeyDown={(e) => {
              const buttons = [...(ref.current?.querySelectorAll('button') ?? [])]
              const index = buttons.indexOf(e.currentTarget)
              if (e.key === 'ArrowDown') buttons[(index + 1) % buttons.length]?.focus()
              if (e.key === 'ArrowUp') buttons[(index - 1 + buttons.length) % buttons.length]?.focus()
            }}
          >
            {item.label}
            {item.key && <span className="ml-6 font-mono text-xs text-muted-foreground">{item.key}</span>}
          </button>
        ),
      )}
    </div>
  )
}
