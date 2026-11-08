/**
 * Actions and keyboard shortcuts. Presets mirror other tools (KiCad is the default);
 * user overrides are stored in localStorage (per-browser convenience).
 */
import { create } from 'zustand'

export const ACTIONS = {
  'tool.select': { label: 'Select tool', group: 'Tools' },
  'tool.highlightNet': { label: 'Highlight net', group: 'Tools' },
  'tool.wire': { label: 'Draw wire', group: 'Tools' },
  'tool.bus': { label: 'Draw bus', group: 'Tools' },
  'tool.label': { label: 'Place net label', group: 'Tools' },
  'tool.globalLabel': { label: 'Place global label', group: 'Tools' },
  'tool.portLabel': { label: 'Place port (hierarchical label)', group: 'Tools' },
  'tool.directive': { label: 'Place SPICE directive', group: 'Tools' },
  'place.symbol': { label: 'Add symbol…', group: 'Place' },
  'place.ground': { label: 'Place ground', group: 'Place' },
  'place.power': { label: 'Place power net', group: 'Place' },
  'place.junction': { label: 'Place junction', group: 'Place' },
  'place.resistor': { label: 'Place resistor', group: 'Place' },
  'place.capacitor': { label: 'Place capacitor', group: 'Place' },
  'place.inductor': { label: 'Place inductor', group: 'Place' },
  'place.diode': { label: 'Place diode', group: 'Place' },
  'place.vsource': { label: 'Place voltage source', group: 'Place' },
  'place.isource': { label: 'Place current source', group: 'Place' },
  'place.npn': { label: 'Place NPN transistor', group: 'Place' },
  'place.pnp': { label: 'Place PNP transistor', group: 'Place' },
  'place.nmos': { label: 'Place N-channel MOSFET', group: 'Place' },
  'place.opamp': { label: 'Place op-amp', group: 'Place' },
  'edit.rotate': { label: 'Rotate', group: 'Edit' },
  'edit.mirrorX': { label: 'Mirror horizontally', group: 'Edit' },
  'edit.alignLeft': { label: 'Align left edges', group: 'Edit' },
  'edit.alignRight': { label: 'Align right edges', group: 'Edit' },
  'edit.alignTop': { label: 'Align top edges', group: 'Edit' },
  'edit.alignBottom': { label: 'Align bottom edges', group: 'Edit' },
  'edit.alignCenterX': { label: 'Align centres vertically', group: 'Edit' },
  'edit.alignCenterY': { label: 'Align centres horizontally', group: 'Edit' },
  'edit.distributeX': { label: 'Distribute horizontally', group: 'Edit' },
  'edit.distributeY': { label: 'Distribute vertically', group: 'Edit' },
  'edit.mirrorY': { label: 'Mirror vertically', group: 'Edit' },
  'edit.move': { label: 'Move', group: 'Edit' },
  'edit.nudgeLeft': { label: 'Move selection left one grid step', group: 'Edit' },
  'edit.nudgeRight': { label: 'Move selection right one grid step', group: 'Edit' },
  'edit.nudgeUp': { label: 'Move selection up one grid step', group: 'Edit' },
  'edit.nudgeDown': { label: 'Move selection down one grid step', group: 'Edit' },
  'edit.drag': { label: 'Drag (keep connections)', group: 'Edit' },
  'edit.properties': { label: 'Edit properties', group: 'Edit' },
  'edit.delete': { label: 'Delete', group: 'Edit' },
  'edit.undo': { label: 'Undo', group: 'Edit' },
  'edit.redo': { label: 'Redo', group: 'Edit' },
  'edit.cut': { label: 'Cut', group: 'Edit' },
  'edit.copy': { label: 'Copy', group: 'Edit' },
  'edit.paste': { label: 'Paste', group: 'Edit' },
  'edit.duplicate': { label: 'Duplicate', group: 'Edit' },
  'edit.selectAll': { label: 'Select all', group: 'Edit' },
  'edit.makeBlock': { label: 'Create block from selection…', group: 'Edit' },
  'edit.makePart': { label: 'Make a part from the selection…', group: 'Edit' },
  'edit.cancel': { label: 'Cancel / clear selection', group: 'Edit' },
  'wire.cycleMode': { label: 'Wire angle: 90° / 45° / any', group: 'Edit' },
  'wire.toggleCorner': { label: 'Toggle wire corner direction', group: 'Edit' },
  'sim.run': { label: 'Run simulation', group: 'Simulate' },
  'sim.cancel': { label: 'Stop simulation', group: 'Simulate' },
  'sim.probe': { label: 'Probe tool', group: 'Simulate' },
  'sim.toggleOp': { label: 'Show / hide operating point', group: 'Simulate' },
  'sim.clearTraces': { label: 'Clear plot', group: 'Simulate' },
  'sheet.enter': { label: 'Enter block (open its sheet)', group: 'View' },
  'sheet.up': { label: 'Leave block (parent sheet)', group: 'View' },
  'view.fit': { label: 'Zoom to fit', group: 'View' },
  'view.zoomSelection': { label: 'Zoom to selection', group: 'View' },
  'view.zoomIn': { label: 'Zoom in', group: 'View' },
  'view.zoomOut': { label: 'Zoom out', group: 'View' },
  'view.theme': { label: 'Toggle dark / light theme', group: 'View' },
  'view.resetLayout': { label: 'Reset panel layout', group: 'View' },
  'app.palette': { label: 'Command palette', group: 'App' },
  'app.shortcuts': { label: 'Keyboard shortcuts…', group: 'App' },
  'app.settings': { label: 'Settings…', group: 'App' },
  'app.guide': { label: 'Getting started…', group: 'App' },
  'app.sendToAgent': { label: 'Send to agent…', group: 'App' },
  'app.console': { label: 'Focus command line', group: 'App' },
  'file.new': { label: 'New project', group: 'File' },
  'file.open': { label: 'Open project…', group: 'File' },
  'file.openExample': { label: 'Open example…', group: 'File' },
  'file.importKicad': { label: 'Import KiCad symbols…', group: 'File' },
  'file.importKicadSch': { label: 'Import KiCad schematic…', group: 'File' },
  'file.importSpice': { label: 'Import SPICE models…', group: 'File' },
  'file.newSymbol': { label: 'New symbol…', group: 'File' },
  'file.newComponent': { label: 'New part (from a datasheet / template)…', group: 'File' },
  'file.importLibrary': { label: 'Import library package (.bptlib)…', group: 'File' },
  'file.save': { label: 'Save project', group: 'File' },
  'file.saveAs': { label: 'Save project as…', group: 'File' },
  'file.exportNetlist': { label: 'Export SPICE netlist (.cir)', group: 'File' },
  'file.exportSvg': { label: 'Export schematic as SVG', group: 'File' },
  'file.exportPng': { label: 'Export schematic as PNG', group: 'File' },
  'file.exportBomCsv': { label: 'Export bill of materials (CSV)', group: 'File' },
  'file.exportBomXlsx': { label: 'Export bill of materials (Excel)', group: 'File' },
} as const

export type ActionId = keyof typeof ACTIONS
export type Bindings = Record<ActionId, string[]>
export type PresetName = 'kicad' | 'ltspice' | 'altium'

const KICAD: Bindings = {
  'tool.select': [],
  'tool.highlightNet': ['`'],
  'tool.wire': ['W'],
  'tool.bus': ['B'],
  'tool.label': ['L'],
  'tool.globalLabel': ['Shift+L', 'Ctrl+L'],
  'tool.portLabel': ['H'],
  'tool.directive': ['T'],
  'place.symbol': ['A'],
  'place.ground': ['P'],
  'place.power': ['Shift+P'],
  'place.junction': ['J'],
  'place.resistor': ['Shift+R'],
  'place.capacitor': ['C'],
  'place.inductor': ['K'],
  'place.diode': ['D'],
  'place.vsource': ['V'],
  'place.isource': ['I'],
  'place.npn': ['Q'],
  'place.pnp': ['Shift+Q'],
  'place.nmos': ['N'],
  'place.opamp': ['U'],
  'edit.rotate': ['R'],
  'edit.mirrorX': ['X'],
  'edit.mirrorY': ['Y'],
  'edit.alignLeft': [],
  'edit.alignRight': [],
  'edit.alignTop': [],
  'edit.alignBottom': [],
  'edit.alignCenterX': [],
  'edit.alignCenterY': [],
  'edit.distributeX': [],
  'edit.distributeY': [],
  'edit.move': ['M'],
  'edit.nudgeLeft': ['ArrowLeft', 'Shift+ArrowLeft'],
  'edit.nudgeRight': ['ArrowRight', 'Shift+ArrowRight'],
  'edit.nudgeUp': ['ArrowUp', 'Shift+ArrowUp'],
  'edit.nudgeDown': ['ArrowDown', 'Shift+ArrowDown'],
  'edit.drag': ['G'],
  'edit.properties': ['E'],
  'edit.delete': ['Delete', 'Backspace'],
  'edit.undo': ['Ctrl+Z'],
  'edit.redo': ['Ctrl+Y', 'Ctrl+Shift+Z'],
  'edit.cut': ['Ctrl+X'],
  'edit.copy': ['Ctrl+C'],
  'edit.paste': ['Ctrl+V'],
  'edit.duplicate': ['Ctrl+D'],
  'edit.selectAll': ['Ctrl+A'],
  'edit.makeBlock': [],
  'edit.makePart': [],
  'edit.cancel': ['Escape'],
  'wire.toggleCorner': ['/'],
  'wire.cycleMode': ['Shift+Space'],
  'sim.run': ['F5'],
  'sim.cancel': ['Shift+F5'],
  'sim.probe': ['Ctrl+P'],
  'sim.toggleOp': ['Ctrl+Shift+O'],
  'sim.clearTraces': [],
  'sheet.enter': [],
  'sheet.up': ['Alt+Backspace'],
  'view.fit': ['Home'],
  'view.zoomSelection': ['Shift+Home'],
  'view.zoomIn': ['=', '+'],
  'view.zoomOut': ['-'],
  'view.theme': [],
  'view.resetLayout': [],
  'app.palette': ['Ctrl+K'],
  'app.shortcuts': ['Ctrl+/'],
  'app.settings': ['Ctrl+,'],
  'app.guide': ['F1'],
  'app.sendToAgent': ['F9'],
  'app.console': [':'],
  'file.new': ['Ctrl+N'],
  'file.open': ['Ctrl+O'],
  'file.openExample': [],
  'file.importKicad': [],
  'file.importKicadSch': [],
  'file.importSpice': [],
  'file.newSymbol': [],
  'file.newComponent': [],
  'file.importLibrary': [],
  'file.save': ['Ctrl+S'],
  'file.saveAs': ['Ctrl+Shift+S'],
  'file.exportNetlist': [],
  'file.exportBomCsv': [],
  'file.exportBomXlsx': [],
  'file.exportSvg': [],
  'file.exportPng': [],
}

// LTspice / Altium presets are filled in phase 12; until then they start from KiCad.
export const PRESETS: Record<PresetName, Bindings> = { kicad: KICAD, ltspice: KICAD, altium: KICAD }

/** Normalized key string for an event: "Ctrl+Shift+K", "W", "Delete", "=". */
export function eventKey(event: KeyboardEvent): string {
  const parts: string[] = []
  if (event.ctrlKey || event.metaKey) parts.push('Ctrl')
  if (event.altKey) parts.push('Alt')
  let key = event.key
  if (key.length === 1) key = key.toUpperCase()
  if (key === ' ') key = 'Space'
  const symbol = key.length === 1 && !/[A-Z0-9]/.test(key)
  if (event.shiftKey && !symbol) parts.push('Shift')
  if (!['Control', 'Shift', 'Alt', 'Meta'].includes(key)) parts.push(key)
  return parts.join('+')
}

const STORAGE_KEY = 'bpt.keymap'

interface Stored {
  preset: PresetName
  overrides: Partial<Bindings>
}

function load(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) return JSON.parse(raw) as Stored
  } catch {
    // ignore unreadable settings
  }
  return { preset: 'kicad', overrides: {} }
}

interface KeymapState extends Stored {
  bindings: () => Bindings
  setPreset: (preset: PresetName) => void
  setBinding: (action: ActionId, keys: string[]) => void
  reset: () => void
}

function persist(state: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // not remembered in private mode
  }
}

export const useKeymap = create<KeymapState>((set, get) => ({
  ...load(),
  bindings: () => ({ ...PRESETS[get().preset], ...get().overrides }) as Bindings,
  setPreset: (preset) => {
    set({ preset })
    persist({ preset, overrides: get().overrides })
  },
  setBinding: (action, keys) => {
    const overrides = { ...get().overrides, [action]: keys }
    set({ overrides })
    persist({ preset: get().preset, overrides })
  },
  reset: () => {
    set({ overrides: {} })
    persist({ preset: get().preset, overrides: {} })
  },
}))

// -- dispatch ---------------------------------------------------------------------------------

type Handler = (event?: KeyboardEvent) => void
const handlers = new Map<ActionId, Handler>()

/** Register handlers; returns an unregister function. */
export function registerActions(map: Partial<Record<ActionId, Handler>>): () => void {
  for (const [id, handler] of Object.entries(map)) handlers.set(id as ActionId, handler as Handler)
  return () => {
    for (const id of Object.keys(map)) handlers.delete(id as ActionId)
  }
}

export function runAction(id: ActionId, event?: KeyboardEvent): boolean {
  const handler = handlers.get(id)
  if (!handler) return false
  handler(event)
  return true
}

export const isAvailable = (id: ActionId): boolean => handlers.has(id)

/** Keys that still work while typing in a text field. */
// F5 / Shift+F5 (run / stop): nothing to type, and unhandled the browser would reload the page.
const GLOBAL_IN_INPUTS = new Set(['Ctrl+S', 'Ctrl+K', 'Ctrl+Shift+S', 'Ctrl+O', 'Ctrl+N', 'F5', 'Shift+F5'])

export function installKeyboard(): () => void {
  const onKeyDown = (event: KeyboardEvent) => {
    const key = eventKey(event)
    const target = event.target as HTMLElement | null
    const typing = target?.closest('input, textarea, select, [contenteditable="true"], [role="dialog"]')
    if (typing && !GLOBAL_IN_INPUTS.has(key)) return
    // Leaving the field commits what was typed (fields commit on blur) before the action runs.
    if (typing && key.endsWith('F5')) (target as HTMLElement).blur()
    const bindings = useKeymap.getState().bindings()
    for (const [id, keys] of Object.entries(bindings)) {
      if (keys.includes(key) && runAction(id as ActionId, event)) {
        event.preventDefault()
        return
      }
    }
  }
  window.addEventListener('keydown', onKeyDown)
  return () => window.removeEventListener('keydown', onKeyDown)
}
