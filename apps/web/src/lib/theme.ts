import { create } from 'zustand'

export type Theme = 'dark' | 'light'

const STORAGE_KEY = 'bpt.theme'

function stored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

interface ThemeState {
  theme: Theme
  setTheme: (theme: Theme) => void
  toggle: () => void
}

export const useTheme = create<ThemeState>((set, get) => ({
  theme: stored(),
  setTheme: (theme) => {
    apply(theme)
    try {
      localStorage.setItem(STORAGE_KEY, theme)
    } catch {
      // private mode: theme just isn't remembered
    }
    set({ theme })
  },
  toggle: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),
}))

apply(stored())

export interface CanvasPalette {
  background: number
  gridDot: number
  gridDotMajor: number
  symbol: number
  symbolFill: number
  pin: number
  wire: number
  bus: number
  junction: number
  label: number
  power: number
  text: number
  ref: number
  selection: number
  ghost: number
  error: number
  stress: number // a part used beyond its margin (stress analysis)
  directive: number
  annotation: number
  highlight: number
  parasitic: number
}

/** Schematic canvas colors per theme (Pixi needs numeric colors, not CSS variables). */
export const canvasPalette: Record<Theme, CanvasPalette> = {
  dark: {
    background: 0x111113,
    gridDot: 0x3f3f46,
    gridDotMajor: 0x52525b,
    symbol: 0xd4d4d8,
    symbolFill: 0xd4d4d8,
    pin: 0xa1a1aa,
    wire: 0x34d399,
    bus: 0x60a5fa,
    junction: 0x34d399,
    label: 0x60a5fa,
    power: 0xf87171,
    text: 0xa1a1aa,
    ref: 0xe4e4e7,
    selection: 0xfbbf24,
    ghost: 0x71717a,
    error: 0xef4444,
    stress: 0xf97316,
    directive: 0xc084fc,
    annotation: 0x38bdf8,
    highlight: 0xf472b6,
    parasitic: 0xfb923c,
  },
  light: {
    background: 0xfafafa,
    gridDot: 0xd4d4d8,
    gridDotMajor: 0xa1a1aa,
    symbol: 0x27272a,
    symbolFill: 0x27272a,
    pin: 0x52525b,
    wire: 0x059669,
    bus: 0x2563eb,
    junction: 0x059669,
    label: 0x2563eb,
    power: 0xdc2626,
    text: 0x52525b,
    ref: 0x18181b,
    selection: 0xd97706,
    ghost: 0xa1a1aa,
    error: 0xdc2626,
    stress: 0xea580c,
    directive: 0x9333ea,
    annotation: 0x0369a1,
    highlight: 0xdb2777,
    parasitic: 0xc2410c,
  },
}
