import { useEffect, useState } from 'react'
import type { SymbolDef } from '@/api/types'
import { ComponentCardDialog } from '@/components/ComponentCard'
import { EquationDeviceDialog } from '@/components/EquationDevice'
import { SymbolPreview } from '@/components/SymbolPreview'
import { Button } from '@/components/ui/button'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Kbd } from '@/components/ui/kbd'
import { Textarea } from '@/components/ui/textarea'
import {
  ACTIONS,
  type ActionId,
  eventKey,
  isAvailable,
  PRESETS,
  type PresetName,
  runAction,
  useKeymap,
} from '@/keymap/keymap'
import { useDialogs } from '@/store/dialogs'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'
import { useSimulation } from '@/store/simulation'
import { ExamplesDialog } from './ExamplesDialog'
import { FileDialog } from './FileDialog'
import { GuideDialog } from './GuideDialog'
import { LibraryManager } from './LibraryManager'
import { SearchGroups } from './SearchGroups'
import { SendToAgentDialog } from './SendToAgentDialog'
import { SettingsDialog } from './SettingsDialog'
import { SpiceImportDialog } from './SpiceImportDialog'

function PromptDialog() {
  const request = useDialogs((s) => s.prompt)
  const [value, setValue] = useState('')
  useEffect(() => {
    setValue(request?.initial ?? '')
  }, [request])
  if (!request) return null
  const submit = () => request.resolve(value.trim() ? value : null)
  return (
    <Dialog open onOpenChange={(open) => !open && request.resolve(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.label && <DialogDescription>{request.label}</DialogDescription>}
        </DialogHeader>
        {request.multiline ? (
          <Textarea
            autoFocus
            rows={4}
            className="font-mono"
            value={value}
            placeholder={request.placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && e.ctrlKey && submit()}
          />
        ) : (
          <Input
            autoFocus
            className="font-mono"
            value={value}
            placeholder={request.placeholder}
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
          />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => request.resolve(null)}>
            Cancel
          </Button>
          <Button onClick={submit}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ChoiceDialog() {
  const request = useDialogs((s) => s.choice)
  if (!request) return null
  const last = request.choices[request.choices.length - 1]
  return (
    <Dialog open onOpenChange={(open) => !open && request.resolve(null)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          <DialogDescription>{request.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {request.choices.map((c) => (
            <Button
              key={c.value}
              variant={c.variant ?? 'default'}
              autoFocus={c === last}
              onClick={() => request.resolve(c.value)}
            >
              {c.label}
            </Button>
          ))}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SymbolPicker() {
  const resolve = useDialogs((s) => s.symbolPicker)
  const symbols = useProject((s) => s.symbols)
  if (!resolve) return null
  const byCategory = new Map<string, SymbolDef[]>()
  for (const s of symbols.values()) {
    byCategory.set(s.category, [...(byCategory.get(s.category) ?? []), s])
  }
  return (
    <CommandDialog
      open
      onOpenChange={(open) => !open && resolve(null)}
      title="Add symbol"
      description="Search the library"
    >
      <CommandInput placeholder="Search symbols…" />
      <CommandList>
        <CommandEmpty>No symbol found.</CommandEmpty>
        {[...byCategory.entries()].map(([category, items]) => (
          <CommandGroup key={category} heading={category}>
            {items.map((item) => (
              <CommandItem key={item.id} value={`${item.name} ${item.id}`} onSelect={() => resolve(item.id)}>
                <SymbolPreview symbol={item} size={22} />
                {item.name}
                <span className="ml-auto font-mono text-[10px] text-muted-foreground/60">
                  {item.ref_prefix.startsWith('#') ? '' : `${item.ref_prefix}1`}
                </span>
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

function CommandPalette() {
  const open = useDialogs((s) => s.palette)
  const setOpen = useDialogs((s) => s.setPalette)
  const [search, setSearch] = useState('')
  useEffect(() => {
    if (open) setSearch('')
  }, [open])
  const bindings = useKeymap((s) => s.bindings)()
  const job = useSimulation((s) => s.job)
  const info = useProject((s) => s.info)
  const selected = useEditor((s) => s.selection.size > 0)
  const running = job?.status === 'queued' || job?.status === 'running'
  // Offer only what makes sense now (Stop while nothing runs would be the top match for "sim").
  const pointless: Partial<Record<ActionId, boolean>> = {
    'sim.cancel': !running,
    'sim.run': running,
    'edit.undo': !info?.can_undo,
    'edit.redo': !info?.can_redo,
    'edit.rotate': !selected,
    'edit.mirrorX': !selected,
    'edit.mirrorY': !selected,
    'edit.delete': !selected,
    'edit.copy': !selected,
    'edit.cut': !selected,
    'edit.duplicate': !selected,
    'edit.move': !selected,
    'edit.drag': !selected,
    'view.zoomSelection': !selected,
  }
  const groups = new Map<string, ActionId[]>()
  for (const [id, def] of Object.entries(ACTIONS)) {
    if (!isAvailable(id as ActionId) || id === 'app.palette' || pointless[id as ActionId]) continue
    groups.set(def.group, [...(groups.get(def.group) ?? []), id as ActionId])
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={setOpen}
      title="Command palette"
      description="Run an action or find a part, net, signal, sheet or graph"
    >
      <CommandInput
        placeholder="Command, part, net, signal, sheet…"
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        <CommandEmpty>Nothing found.</CommandEmpty>
        <SearchGroups query={search} close={() => setOpen(false)} />
        {[...groups.entries()].map(([group, ids]) => (
          <CommandGroup key={group} heading={group}>
            {ids.map((id) => (
              <CommandItem
                key={id}
                value={ACTIONS[id].label}
                onSelect={() => {
                  setOpen(false)
                  setTimeout(() => runAction(id), 0)
                }}
              >
                {ACTIONS[id].label}
                {bindings[id]?.[0] && <CommandShortcut>{bindings[id][0]}</CommandShortcut>}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
    </CommandDialog>
  )
}

function ShortcutsDialog() {
  const open = useDialogs((s) => s.shortcuts)
  const setOpen = useDialogs((s) => s.setShortcuts)
  const { preset, setPreset, setBinding, reset } = useKeymap()
  const bindings = useKeymap((s) => s.bindings)()
  const [recording, setRecording] = useState<ActionId | null>(null)

  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return
      setBinding(recording, e.key === 'Escape' ? [] : [eventKey(e)])
      setRecording(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording, setBinding])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[80vh] overflow-hidden sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Click a shortcut and press the new key. Escape clears it.</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 text-sm">
          Preset
          {/* Only the presets that differ: LTspice and Altium layouts are still KiCad's (phase 9). */}
          {(Object.keys(PRESETS) as PresetName[])
            .filter((name) => name === 'kicad' || PRESETS[name] !== PRESETS.kicad)
            .map((name) => (
              <Button
                key={name}
                size="sm"
                variant={preset === name ? 'default' : 'outline'}
                onClick={() => setPreset(name)}
              >
                {name === 'kicad' ? 'KiCad' : name === 'ltspice' ? 'LTspice' : 'Altium'}
              </Button>
            ))}
          <Button size="sm" variant="ghost" className="ml-auto" onClick={reset}>
            Reset
          </Button>
        </div>
        <div className="-mx-6 max-h-[55vh] overflow-auto px-6">
          {(Object.keys(ACTIONS) as ActionId[]).map((id) => (
            <div key={id} className="flex items-center justify-between border-b py-1.5 text-sm last:border-0">
              <span>
                {ACTIONS[id].label}
                <span className="ml-2 text-xs text-muted-foreground">{ACTIONS[id].group}</span>
              </span>
              <button type="button" onClick={() => setRecording(id)} className="flex gap-1">
                {recording === id ? (
                  <span className="text-xs text-primary">press a key…</span>
                ) : bindings[id]?.length ? (
                  bindings[id].map((key) => <Kbd key={key}>{key}</Kbd>)
                ) : (
                  <span className="text-xs text-muted-foreground">—</span>
                )}
              </button>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Dialogs() {
  return (
    <>
      <PromptDialog />
      <ChoiceDialog />
      <FileDialog />
      <SpiceImportDialog />
      <EquationDeviceDialog />
      <LibraryManager />
      <ComponentCardDialog />
      <SettingsDialog />
      <ExamplesDialog />
      <GuideDialog />
      <SendToAgentDialog />
      <SymbolPicker />
      <CommandPalette />
      <ShortcutsDialog />
    </>
  )
}
