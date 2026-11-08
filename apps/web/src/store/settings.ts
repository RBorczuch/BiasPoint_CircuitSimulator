/** Per-browser user preferences (editor look and behaviour), kept in localStorage. */
import { create } from 'zustand'

export interface Settings {
  showGrid: boolean
  crosshair: 'small' | 'full'
  cursorTips: boolean
  autoJunctions: boolean // a new wire crossing another one connects to it
  realism: 'always' | 'hover' | 'off' // when parts show "ideal" / "real" / the library part
  symbolStandard: 'iec' | 'ansi' // drawing of parts without a look of their own
  wireMode: '90' | '45' | 'free' // how a new wire runs to the cursor
  opVoltages: boolean // operating point overlay: node voltages
  opCurrents: boolean // ... currents of the parts
  opPower: boolean // ... power of two-terminal parts
}

const KEY = 'bpt.settings'
const DEFAULTS: Settings = {
  showGrid: true,
  crosshair: 'small',
  cursorTips: true,
  autoJunctions: false,
  realism: 'always',
  symbolStandard: 'iec',
  wireMode: '90',
  opVoltages: true,
  opCurrents: true,
  opPower: false,
}

function load(): Settings {
  try {
    const stored = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    // Before the part tags the setting was off / marker / values.
    if (!['always', 'hover', 'off'].includes(stored.realism)) stored.realism = 'always'
    return stored
  } catch {
    return DEFAULTS
  }
}

interface SettingsState extends Settings {
  update: (patch: Partial<Settings>) => void
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch)
    const { update: _update, ...values } = { ...get(), ...patch }
    try {
      localStorage.setItem(KEY, JSON.stringify(values))
    } catch {
      // not remembered in private mode
    }
  },
}))
