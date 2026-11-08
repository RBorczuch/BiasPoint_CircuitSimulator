/** Waveform viewer options (chart type, axis scales, palette, titles), kept in localStorage. */
import { create } from 'zustand'

export type ChartKind = 'line' | 'step' | 'points'
export type PaletteName = 'default' | 'colorblind' | 'print'

// Each palette is distinguishable on dark and light backgrounds.
export const PALETTES: Record<PaletteName, { label: string; colors: string[] }> = {
  default: {
    label: 'Default',
    colors: ['#22c55e', '#3b82f6', '#f59e0b', '#ef4444', '#a855f7', '#06b6d4', '#ec4899', '#84cc16'],
  },
  colorblind: {
    // Okabe–Ito, black replaced by grey so it shows on dark backgrounds.
    label: 'Colour-blind safe',
    colors: ['#0072b2', '#e69f00', '#009e73', '#cc79a7', '#56b4e9', '#d55e00', '#f0e442', '#999999'],
  },
  print: {
    label: 'Print (greys, dashes)',
    colors: ['#3f3f46', '#71717a', '#52525b', '#a1a1aa'],
  },
}

export interface PlotOptions {
  kind: ChartKind
  xLog: boolean | null // null: automatic (log for AC)
  yLog: boolean
  xy: string | null // expression of the trace used as the x axis (XY plot), null = vs. scale
  xTitle: string // '' = automatic
  yTitle: string
  palette: PaletteName
  width: number // default line width
}

const KEY = 'bpt.plot'
export const PLOT_DEFAULTS: PlotOptions = {
  kind: 'line',
  xLog: null,
  yLog: false,
  xy: null,
  xTitle: '',
  yTitle: '',
  palette: 'default',
  width: 1.5,
}

function load(): PlotOptions {
  try {
    return { ...PLOT_DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}'), xy: null }
  } catch {
    return PLOT_DEFAULTS
  }
}

interface PlotState extends PlotOptions {
  setPlot: (patch: Partial<PlotOptions>) => void
}

export const usePlot = create<PlotState>((set, get) => ({
  ...load(),
  setPlot: (patch) => {
    set(patch)
    const { setPlot: _setPlot, xy: _xy, ...values } = { ...get(), ...patch } // XY is per session
    try {
      localStorage.setItem(KEY, JSON.stringify(values))
    } catch {
      // not remembered in private mode
    }
  },
}))

/** Dash pattern of the n-th trace in the print palette (colours alone do not survive printing). */
export const printDash = (index: number): TraceDash =>
  (['solid', 'dash', 'dot', 'dashdot'] as const)[index % 4]

export type TraceDash = 'solid' | 'dash' | 'dot' | 'dashdot'

export const DASHES: Record<TraceDash, number[]> = {
  solid: [],
  dash: [8, 4],
  dot: [2, 3],
  dashdot: [8, 3, 2, 3],
}
