/**
 * Characteristics of the built-in passive templates from their formulas, in the browser: the
 * curves follow every keystroke (well under a frame) instead of waiting for the backend.
 * The same networks as bpt/models/templates.py (series / parallel R, L, C built from the
 * filled-in fields; empty optional fields leave their element out); a test keeps them equal.
 */
import { parseValue } from './units'

export type Values = Record<string, number>
type Complex = [number, number]
type Elem = { letter: 'R' | 'C' | 'L'; value: (v: Values, volts: number, amps: number) => number }
type Node = Elem | { ser: Node[] } | { par: Node[] }

const TWO_PI = 2 * Math.PI
const R = (key: string): Elem => ({ letter: 'R', value: (v) => v[key] })
const C = (key: string): Elem => ({ letter: 'C', value: (v) => v[key] })
const L = (key: string): Elem => ({ letter: 'L', value: (v) => v[key] })
const has = (v: Values, ...keys: string[]) => keys.every((k) => k in v)
const opt = (v: Values, key: string, make: (k: string) => Elem): Node[] => (has(v, key) ? [make(key)] : [])

const NETWORKS: Record<string, (v: Values) => Node> = {
  resistor: (v) => ({ par: [{ ser: [R('Rnom'), ...opt(v, 'ls', L)] }, ...opt(v, 'cp', C)] }),
  capacitor: (v) => ({
    ser: [{ par: [C('Cnom'), ...opt(v, 'rleak', R)] }, ...opt(v, 'esr', R), ...opt(v, 'esl', L)],
  }),
  mlcc: (v) => {
    if (!has(v, 'vhalf')) return NETWORKS.capacitor(v)
    // The dielectric loses capacitance with the DC voltage across the part.
    const cv: Elem = { letter: 'C', value: (val, volts) => val.Cnom / (1 + (volts / val.vhalf) ** 2) }
    return { ser: [{ par: [cv, ...opt(v, 'rleak', R)] }, ...opt(v, 'esr', R), ...opt(v, 'esl', L)] }
  },
  electrolytic: (v) => {
    // ESR falls with frequency: rlf in parallel with a capacitance that shorts it above flf.
    const cd: Elem = { letter: 'C', value: (val) => 1 / (TWO_PI * val.flf * val.rlf) }
    const rise: Node[] = has(v, 'rlf', 'flf') ? [{ par: [R('rlf'), cd] }] : []
    return {
      ser: [{ par: [C('Cnom'), ...opt(v, 'rleak', R)] }, ...opt(v, 'esr', R), ...rise, ...opt(v, 'esl', L)],
    }
  },
  film: (v) => {
    const absorption: Node[] = has(v, 'rda', 'cda') ? [{ ser: [R('rda'), C('cda')] }] : []
    return {
      ser: [
        { par: [C('Cnom'), ...opt(v, 'rins', R), ...absorption] },
        ...opt(v, 'esr', R),
        ...opt(v, 'esl', L),
      ],
    }
  },
  inductor: (v) => {
    const coil: Elem = has(v, 'isat')
      ? { letter: 'L', value: (val, _volts, amps) => val.Lnom / (1 + (amps / val.isat) ** 2) }
      : L('Lnom')
    // The winding's resistance rising with frequency: rac in parallel with an inductance that
    // shorts it below fac (as the backend).
    const lx: Elem = { letter: 'L', value: (val) => val.rac / (TWO_PI * val.fac) }
    const ac: Node[] = has(v, 'rac', 'fac') ? [{ par: [R('rac'), lx] }] : []
    return { par: [{ ser: [coil, ...opt(v, 'dcr', R), ...ac] }, ...opt(v, 'cp', C), ...opt(v, 'rp', R)] }
  },
}

const REQUIRED: Record<string, string> = {
  resistor: 'Rnom',
  capacitor: 'Cnom',
  mlcc: 'Cnom',
  electrolytic: 'Cnom',
  film: 'Cnom',
  inductor: 'Lnom',
}

/** Templates computed here (the others go to the backend). */
export const hasFormulas = (template: string): boolean => template in NETWORKS

/** Form text -> numbers (empty fields absent), with derived values; null when unusable. */
export function numbers(template: string, form: Record<string, string>): Values | null {
  const out: Values = {}
  for (const [key, text] of Object.entries(form)) {
    if (!text.trim()) continue
    const value = parseValue(text)
    if (value === null || value <= 0) return null
    out[key] = value
  }
  if (!(REQUIRED[template] in out)) return null
  // The self-resonance sets the winding capacitance when that is not given.
  if (template === 'inductor' && !('cp' in out) && 'srf' in out)
    out.cp = 1 / ((TWO_PI * out.srf) ** 2 * out.Lnom)
  return out
}

const add = (a: Complex, b: Complex): Complex => [a[0] + b[0], a[1] + b[1]]
const inv = ([re, im]: Complex): Complex => {
  const d = re * re + im * im
  return [re / d, -im / d]
}

function impedanceOf(node: Node, w: number, v: Values, volts: number, amps: number): Complex {
  if ('letter' in node) {
    const x = node.value(v, volts, amps)
    if (node.letter === 'R') return [x, 0]
    return node.letter === 'C' ? [0, -1 / (w * x)] : [0, w * x]
  }
  if ('ser' in node)
    return node.ser.reduce<Complex>((z, n) => add(z, impedanceOf(n, w, v, volts, amps)), [0, 0])
  return inv(node.par.reduce<Complex>((y, n) => add(y, inv(impedanceOf(n, w, v, volts, amps))), [0, 0]))
}

/** Complex impedance [re, im] at frequency ``f`` around a DC operating point. */
export function impedance(template: string, v: Values, f: number, volts = 0, amps = 0): Complex {
  return impedanceOf(NETWORKS[template](v), TWO_PI * f, v, volts, amps)
}

/** A frequency where the main reactance dominates (a decade under the resonances). */
function lowFrequency(template: string, v: Values): number {
  if (template === 'inductor') {
    let f = v.dcr ? (100 * v.dcr) / (TWO_PI * v.Lnom) : 1e3
    if ('cp' in v) f = Math.min(f, 0.01 / (TWO_PI * Math.sqrt(v.Lnom * v.cp)))
    return f
  }
  return v.esl ? 0.01 / (TWO_PI * Math.sqrt(v.Cnom * v.esl)) : 1e3
}

export interface Curve {
  name: string
  x_unit: string
  y_unit: string
  x: number[]
  y: number[]
}

/** The charts of a filled-in form (as the backend's /templates/preview); null when unusable. */
export function previewCurves(
  template: string,
  form: Record<string, string>,
  fmin: number,
  fmax: number,
): Curve[] | null {
  const v = numbers(template, form)
  if (!v) return null
  const f = Array.from({ length: 161 }, (_, k) => fmin * (fmax / fmin) ** (k / 160))
  const z = f.map((x) => impedance(template, v, x))
  const curves: Curve[] = [
    { name: '|Z|(f)', x_unit: 'Hz', y_unit: 'Ω', x: f, y: z.map(([re, im]) => Math.hypot(re, im)) },
    {
      name: 'phase(f)',
      x_unit: 'Hz',
      y_unit: '°',
      x: f,
      y: z.map(([re, im]) => (Math.atan2(im, re) * 180) / Math.PI),
    },
  ]
  if (template !== 'resistor')
    curves.push({ name: 'ESR(f)', x_unit: 'Hz', y_unit: 'Ω', x: f, y: z.map(([re]) => re) })
  const fl = lowFrequency(template, v)
  if ('vhalf' in v) {
    const volts = Array.from({ length: 31 }, (_, k) => (3 * v.vhalf * k) / 30)
    const y = volts.map((u) => -1 / (TWO_PI * fl * impedance(template, v, fl, u)[1]))
    curves.push({ name: 'C(V)', x_unit: 'V', y_unit: 'F', x: volts, y })
  }
  if ('isat' in v) {
    const amps = Array.from({ length: 31 }, (_, k) => (3 * v.isat * k) / 30)
    const y = amps.map((i) => impedance(template, v, fl, 0, i)[1] / (TWO_PI * fl))
    curves.push({ name: 'L(I)', x_unit: 'A', y_unit: 'H', x: amps, y })
  }
  return curves
}
