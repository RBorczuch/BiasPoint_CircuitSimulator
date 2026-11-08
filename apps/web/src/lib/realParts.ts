/**
 * Ideal R, C, L and real parts (FR-CMP-5): the quick model of an ideal part (its parasitic
 * fields) is the form of the matching equivalent-circuit template, so a part goes from ideal to
 * a library component and back with its values.
 */
import type { Command, ComponentKind, Instance, Project } from '@/api/types'

export interface QuickModel {
  template: string // equivalent-circuit template with the same fields as the parasitics
  param: string // value parameter of the ideal part (R, C, L)
  main: string // template field holding that value (Rnom, Cnom, Lnom)
  kind: ComponentKind
}

export const QUICK: Record<string, QuickModel> = {
  'bpt:resistor': { template: 'resistor', param: 'R', main: 'Rnom', kind: 'resistor' },
  'bpt:capacitor': { template: 'capacitor', param: 'C', main: 'Cnom', kind: 'capacitor' },
  'bpt:inductor': { template: 'inductor', param: 'L', main: 'Lnom', kind: 'inductor' },
}

export const IDEAL_OF_KIND: Partial<Record<ComponentKind, string>> = {
  resistor: 'bpt:resistor',
  capacitor: 'bpt:capacitor',
  inductor: 'bpt:inductor',
}

/** Standard template of a built-in diode or transistor: its fields are the model's parameters. */
export const DEVICE_TEMPLATE: Record<string, string> = {
  'bpt:diode': 'tpl:Standard templates/Diode (signal)',
  'bpt:led': 'tpl:Standard templates/LED',
  'bpt:zener': 'tpl:Standard templates/Zener diode',
  'bpt:npn': 'tpl:Standard templates/NPN transistor',
  'bpt:pnp': 'tpl:Standard templates/PNP transistor',
  'bpt:nmos': 'tpl:Standard templates/N-channel MOSFET',
  'bpt:pmos': 'tpl:Standard templates/P-channel MOSFET',
  'bpt:njfet': 'tpl:Standard templates/N-channel JFET',
  'bpt:pjfet': 'tpl:Standard templates/P-channel JFET',
}

/** SPICE defaults of the standard templates' fields, by element letter (ngspice manual). A
 *  library model that does not set a parameter means this value, not the example part's.
 *  "Infinite" defaults: VAF / IKF = 0 (ngspice reads 0 as infinite), BV = 1e30. */
const SPICE_DEFAULTS: Record<string, Record<string, string>> = {
  D: { is: '1e-14', n: '1', rs: '0', bv: '1e30', ibv: '1m', cjo: '0', vj: '1', mj: '0.5', tt: '0' },
  Q: { is: '1e-16', bf: '100', vaf: '0', ikf: '0', br: '1', rb: '0', rc: '0', cje: '0', cjc: '0', tf: '0' },
  M: { vto: '0', kp: '20u', lambda: '0', rd: '0', rs: '0', cgso: '0', cgdo: '0' },
  J: { vto: '-2', beta: '100u', lambda: '0', rd: '0', rs: '0', cgs: '0', cgd: '0' },
}

/** Template form from a ``.model`` card: fields are its parameters in lower case (M is ``mj``,
 *  ``m`` being the part multiplier); fields the model leaves out get the SPICE default of
 *  ``element`` (D, Q, M, J). Parameters the template has no field for are ignored. */
export function modelForm(params: Record<string, string>, element = ''): Record<string, string> {
  const form: Record<string, string> = { ...SPICE_DEFAULTS[element] }
  for (const [key, value] of Object.entries(params)) {
    const field = key.toLowerCase()
    form[field === 'm' ? 'mj' : field] = value
  }
  return form
}

/** Template form of an ideal part: its value and quick-model fields. */
export function quickForm(
  symbolId: string,
  params: Record<string, string>,
  parasitics: string[],
): Record<string, string> {
  const quick = QUICK[symbolId]
  if (!quick) return {}
  const form: Record<string, string> = {}
  if (params[quick.param]?.trim()) form[quick.main] = params[quick.param].trim()
  for (const key of parasitics) if (params[key]?.trim()) form[key] = params[key].trim()
  return form
}

/** Put library component ``componentId`` in place of ``inst`` (its own parameters go). */
export function toRealPart(sheet: string, inst: Instance, componentId: string): Command[] {
  const clear = Object.fromEntries(Object.keys(inst.model.params).map((k) => [k, null]))
  return [
    { type: 'update_instance', sheet, id: inst.id, symbol: componentId },
    { type: 'set_params', sheet, id: inst.id, params: clear, model: null, variant: null, pins: null },
  ]
}

/** The ideal part for a placed component, with the values the quick model can keep. */
export function toIdealPart(
  sheet: string,
  inst: Instance,
  project: Project,
  parasitics: (symbolId: string) => string[],
): { commands: Command[]; dropped: string[] } | null {
  const block = project.sheets.find((s) => `sheet:${s.name}` === inst.symbol)
  const info = block?.component
  const ideal = info && IDEAL_OF_KIND[info.kind]
  if (!block || !info || !ideal) return null
  const quick = QUICK[ideal]
  const values = { ...(block.parameters ?? {}), ...inst.model.params } // with derived ones (Cp from SRF)
  const keep = new Set(parasitics(ideal))
  const params: Record<string, string | null> = Object.fromEntries(
    Object.keys(inst.model.params).map((k) => [k, null]),
  )
  const dropped: string[] = []
  for (const [key, value] of Object.entries(values)) {
    if (!value.trim()) continue
    if (key === quick.main) params[quick.param] = value
    else if (keep.has(key)) params[key] = value
    else if (key !== 'srf') dropped.push(key) // the SRF is kept through Cp
  }
  if (!params[quick.param]) params[quick.param] = values[quick.main] ?? null
  return {
    commands: [
      { type: 'update_instance', sheet, id: inst.id, symbol: ideal },
      { type: 'set_params', sheet, id: inst.id, params },
    ],
    dropped,
  }
}
