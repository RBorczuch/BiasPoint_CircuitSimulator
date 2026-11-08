import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { runAction } from '@/keymap/keymap'
import { useTheme } from '@/lib/theme'
import { useDialogs } from '@/store/dialogs'
import { useSettings } from '@/store/settings'

function Setting({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b py-2 last:border-0">
      <div>
        <p className="text-sm">{label}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  )
}

function Choice<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: [T, string][]
  onChange: (v: T) => void
}) {
  return (
    <div className="flex rounded-md bg-muted p-0.5">
      {options.map(([id, label]) => (
        <button
          type="button"
          key={id}
          aria-pressed={value === id}
          onClick={() => onChange(id)}
          className={`rounded px-2 py-0.5 text-xs ${value === id ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

export function SettingsDialog() {
  const open = useDialogs((s) => s.settings)
  const setOpen = useDialogs((s) => s.setSettings)
  const settings = useSettings()
  const { theme, setTheme } = useTheme()
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Stored in this browser.</DialogDescription>
        </DialogHeader>
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">General</h3>
        <Setting label="Theme">
          <Choice
            value={theme}
            options={[
              ['dark', 'Dark'],
              ['light', 'Light'],
            ]}
            onChange={setTheme}
          />
        </Setting>
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Editor</h3>
        <Setting label="Show grid">
          <input
            type="checkbox"
            className="size-4"
            aria-label="Show grid"
            checked={settings.showGrid}
            onChange={(e) => settings.update({ showGrid: e.target.checked })}
          />
        </Setting>
        <Setting label="Drawing cursor" hint="Cross shown while placing, wiring or probing">
          <Choice
            value={settings.crosshair}
            options={[
              ['small', 'Small'],
              ['full', 'Full screen'],
            ]}
            onChange={(crosshair) => settings.update({ crosshair })}
          />
        </Setting>
        <Setting label="Cursor tips" hint="Distances, wire length, net and voltage next to the cursor">
          <input
            type="checkbox"
            className="size-4"
            aria-label="Cursor tips"
            checked={settings.cursorTips}
            onChange={(e) => settings.update({ cursorTips: e.target.checked })}
          />
        </Setting>
        <Setting
          label="Junctions at crossings"
          hint="A new wire that crosses another one connects to it (a junction dot is added)"
        >
          <input
            type="checkbox"
            className="size-4"
            aria-label="Junctions at crossings"
            checked={settings.autoJunctions}
            onChange={(e) => settings.update({ autoJunctions: e.target.checked })}
          />
        </Setting>
        <Setting
          label="Ideal / real tags"
          hint="Small tag under parts: ideal, real (with ESR, ESL… set) or the library part"
        >
          <Choice
            value={settings.realism}
            options={[
              ['always', 'Always'],
              ['hover', 'On hover'],
              ['off', 'Off'],
            ]}
            onChange={(realism) => settings.update({ realism })}
          />
        </Setting>
        <Setting
          label="Wire angle"
          hint="How a new wire runs to the cursor (Shift+Space switches while drawing)"
        >
          <Choice
            value={settings.wireMode}
            options={[
              ['90', '90°'],
              ['45', '45°'],
              ['free', 'Any'],
            ]}
            onChange={(wireMode) => settings.update({ wireMode })}
          />
        </Setting>
        <Setting
          label="Symbol standard"
          hint="IEC (European: box resistor) or ANSI (American: zigzag); a part can choose its own look"
        >
          <Choice
            value={settings.symbolStandard}
            options={[
              ['iec', 'IEC'],
              ['ansi', 'ANSI'],
            ]}
            onChange={(symbolStandard) => settings.update({ symbolStandard })}
          />
        </Setting>
        <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Keyboard</h3>
        <Setting label="Shortcuts" hint="KiCad-style keys; every key can be changed">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOpen(false)
              runAction('app.shortcuts')
            }}
          >
            Edit shortcuts…
          </Button>
        </Setting>
      </DialogContent>
    </Dialog>
  )
}
