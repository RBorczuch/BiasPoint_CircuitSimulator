/**
 * Symbol looks (FR-SCH-6): other drawings of the same part with the same pins – ANSI zigzag
 * resistor, electrolytic capacitor... A placed part shows its own look, or the one the IEC /
 * ANSI setting asks for (the project's, else the program's).
 */
import type { SymbolDef } from '@/api/types'
import { useProject } from '@/store/project'
import { useSettings } from '@/store/settings'

const copies = new WeakMap<SymbolDef, Map<string, SymbolDef>>()
const names = new WeakMap<SymbolDef, string>()

/** The waveform keyword of a source's transient value ("SIN(0 1 1k)" -> "SIN"). */
export const signalOf = (tran?: string): string => (tran ?? '').trim().split('(')[0].trim().toUpperCase()

/**
 * The symbol drawn as `look` or, without one, as its waveform asks (a sine source shows a sine;
 * `tran`: its transient value) or else the IEC / ANSI setting.
 */
export function drawn(symbol: SymbolDef, look?: string | null, tran?: string): SymbolDef {
  if (!symbol.looks?.length) return symbol
  const standard = symbolStandard()
  const wave = signalOf(tran)
  const chosen = look
    ? symbol.looks.find((l) => l.name === look)
    : ((wave ? symbol.looks.find((l) => l.signal === wave) : undefined) ??
      symbol.looks.find((l) => l.standard === standard))
  if (!chosen) return symbol
  let byName = copies.get(symbol)
  if (!byName) {
    byName = new Map()
    copies.set(symbol, byName)
  }
  let copy = byName.get(chosen.name)
  if (!copy) {
    copy = { ...symbol, graphics: chosen.graphics }
    byName.set(chosen.name, copy)
    names.set(copy, chosen.name)
  }
  return copy
}

/** IEC or ANSI for parts without a look of their own: the project's choice, else the setting. */
export function symbolStandard(): 'iec' | 'ansi' {
  return useProject.getState().project?.symbol_standard ?? useSettings.getState().symbolStandard
}

/** This project's parts back to the built-in drawing (as the IEC / ANSI setting asks). */
export async function restoreDrawing(symbolId: string): Promise<void> {
  const { project, execute } = useProject.getState()
  const look = project?.default_looks?.[symbolId]
  if (!project || !look) return
  const placed = project.sheets.flatMap((s) =>
    s.instances
      .filter((i) => i.symbol === symbolId && i.look === look)
      .map((i) => ({ sheet: s.name, id: i.id })),
  )
  await execute({
    type: 'transaction',
    label: 'restore the built-in drawing',
    commands: [
      { type: 'set_default_look', symbol: symbolId, look: null },
      ...placed.map((p) => ({ type: 'update_instance' as const, sheet: p.sheet, id: p.id, look: '' })),
    ],
  })
}

/** Name of the look a symbol from `drawn` shows ("" = its own drawing): part of cache keys. */
export function lookName(symbol: SymbolDef): string {
  return names.get(symbol) ?? ''
}
