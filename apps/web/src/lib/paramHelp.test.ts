import { describe, expect, it } from 'vitest'
import { paramInfo, spiceParamInfo } from './paramHelp'

// The built-in templates and their fields (backend: bpt/models/templates.py, standard_templates.py).
const TEMPLATES: Record<string, string[]> = {
  resistor: ['Rnom', 'ls', 'cp'],
  capacitor: ['Cnom', 'esr', 'esl', 'rleak'],
  mlcc: ['Cnom', 'vhalf', 'esr', 'esl', 'rleak'],
  electrolytic: ['Cnom', 'esr', 'rlf', 'flf', 'esl', 'rleak'],
  film: ['Cnom', 'esr', 'esl', 'rins', 'rda', 'cda'],
  inductor: ['Lnom', 'dcr', 'cp', 'srf', 'rac', 'fac', 'rp', 'isat'],
  'tpl:Standard templates/Real transformer': ['lp', 'n', 'k', 'rp', 'rs', 'rcore', 'cw'],
  'tpl:Standard templates/NPN with package': ['lb', 'lc', 'le', 'cbe', 'cbc'],
  'tpl:Standard templates/Op-amp macromodel': [
    'aol',
    'gbw',
    'sr',
    'vos',
    'ib',
    'cmrr',
    'psrr',
    'vohigh',
    'volow',
    'iout',
    'iq',
    'rin',
    'rout',
  ],
  'tpl:Standard templates/Diode (signal)': ['is', 'n', 'rs', 'bv', 'ibv', 'cjo', 'vj', 'mj', 'tt'],
  'tpl:Standard templates/LED': ['is', 'n', 'rs', 'bv', 'cjo'],
  'tpl:Standard templates/Zener diode': ['bv', 'ibv', 'rs', 'is', 'n', 'cjo'],
  'tpl:Standard templates/NPN transistor': [
    'is',
    'bf',
    'vaf',
    'ikf',
    'ise',
    'ne',
    'br',
    'rb',
    'rc',
    'cje',
    'cjc',
    'tf',
  ],
  'tpl:Standard templates/PNP transistor': [
    'is',
    'bf',
    'vaf',
    'ikf',
    'ise',
    'ne',
    'br',
    'rb',
    'rc',
    'cje',
    'cjc',
    'tf',
  ],
  'tpl:Standard templates/N-channel MOSFET': ['vto', 'kp', 'lambda', 'rd', 'rs', 'cgso', 'cgdo', 'cbd'],
  'tpl:Standard templates/P-channel MOSFET': ['vto', 'kp', 'lambda', 'rd', 'rs', 'cgso', 'cgdo', 'cbd'],
  'tpl:Standard templates/N-channel MOSFET (level 3)': [
    'vto',
    'kp',
    'theta',
    'rd',
    'rs',
    'cgso',
    'cgdo',
    'cbd',
  ],
  'tpl:Standard templates/P-channel MOSFET (level 3)': [
    'vto',
    'kp',
    'theta',
    'rd',
    'rs',
    'cgso',
    'cgdo',
    'cbd',
  ],
  'tpl:Standard templates/Hybrid-pi BJT (small signal)': ['ic', 'beta', 'vaf', 'rx', 'cpi', 'cmu'],
  'tpl:Standard templates/NPN transistor (Ebers-Moll)': ['is', 'bf', 'br', 'rb', 'rc', 'cje', 'cjc', 'tf'],
  'tpl:Standard templates/PNP transistor (Ebers-Moll)': ['is', 'bf', 'br', 'rb', 'rc', 'cje', 'cjc', 'tf'],
  'tpl:Standard templates/N-channel JFET': ['vto', 'beta', 'lambda', 'rd', 'rs', 'cgs', 'cgd'],
  'tpl:Standard templates/P-channel JFET': ['vto', 'beta', 'lambda', 'rd', 'rs', 'cgs', 'cgd'],
}

describe('parameter cards', () => {
  it('explain every field of every built-in template', () => {
    const missing = Object.entries(TEMPLATES).flatMap(([t, keys]) =>
      keys.filter((k) => !paramInfo(t, k)?.help).map((k) => `${t}: ${k}`),
    )
    expect(missing).toEqual([])
  })
  it('point at the part of a curve a parameter acts on', () => {
    const esl = paramInfo('capacitor', 'esl')
    const region = esl?.region?.({ Cnom: 1e-6, esl: 1e-9 })
    expect(esl?.chart).toBe('|Z|(f)')
    expect(region?.[0]).toBeCloseTo(1 / (2 * Math.PI * Math.sqrt(1e-15)), -3) // from the resonance up
    const rs = paramInfo('tpl:Standard templates/Diode (signal)', 'rs')
    const [lo, hi] = rs?.region?.({ is: 2.5e-9, n: 1.75, rs: 0.5 }) ?? [0, 0]
    expect(lo).toBeGreaterThan(0.6) // the right end of the forward curve
    expect(hi).toBeGreaterThan(lo)
  })
})

describe('cards of SPICE model parameters', () => {
  it('finds them in any case, by the type of the model', () => {
    expect(spiceParamInfo('D', 'IS')?.name).toBe(
      paramInfo('tpl:Standard templates/Diode (signal)', 'is')?.name,
    )
    expect(spiceParamInfo('D', 'M')?.name).toBe(
      paramInfo('tpl:Standard templates/Diode (signal)', 'mj')?.name,
    )
    expect(spiceParamInfo('npn', 'VJE')?.name).toBe('B-E built-in potential')
    expect(spiceParamInfo('PMOS', 'GAMMA')?.name).toBe('Body effect')
    expect(spiceParamInfo('NJF', 'BETA')).toBeDefined()
  })
  it('knows it does not know', () => {
    expect(spiceParamInfo('D', 'NOPE')).toBeUndefined()
    expect(spiceParamInfo('SW', 'RON')).toBeUndefined()
  })
})
