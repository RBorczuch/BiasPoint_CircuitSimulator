/**
 * Dragging on the part editor's charts (docs/projekt-kreator.md §6):
 *
 * - feature handles: named points of a curve tied to parameters (the self-resonance sets ESL and
 *   ESR, the knee of L(I) sets Isat, the bend of a diode's forward curve sets RS…), each new value
 *   computed straight from the point;
 * - pulling the curve anywhere: the unlocked parameters change as little as possible (in log
 *   scale) so that the curve goes through the point under the mouse and stays where it was
 *   elsewhere (a few Gauss-Newton steps on the template's formulas).
 *
 * Values are in base units; the editor turns them into the form's text and keeps the locks and
 * limits (a locked parameter is left out, a value is clamped to its limits).
 */
import { valueAt } from './chartAxes'
import { impedance } from './passives'

export type Values = Record<string, number>

export interface Curve {
  x: number[]
  y: number[]
}

export interface FeatureHandle {
  label: string
  chart: string
  x: number
  y: number
  hint: string // what dragging it changes
  params: string[] // the values it can change
  /** New values for a drop at (x, y); keys outside `params` are not returned. */
  apply: (x: number, y: number) => Values
}

const TWO_PI = 2 * Math.PI
const VT = 0.02585
const finite = (v: number) => Number.isFinite(v) && v > 0
const none: Values = {} // a drop that changes nothing (outside the model's reach)

/** The model's value of a passive template on a chart at x (|Z|, phase, ESR, C(V), L(I)). */
export function passiveValue(template: string, v: Values, chart: string, x: number): number | null {
  if (chart === 'C(V)') return v.vhalf ? v.Cnom / (1 + (x / v.vhalf) ** 2) : (v.Cnom ?? null)
  if (chart === 'L(I)') return v.isat ? v.Lnom / (1 + (x / v.isat) ** 2) : (v.Lnom ?? null)
  const [re, im] = impedance(template, v, x)
  if (chart === '|Z|(f)') return Math.hypot(re, im)
  if (chart === 'ESR(f)') return re
  if (chart === 'phase(f)') return (Math.atan2(im, re) * 180) / Math.PI
  return null
}

/** On-resistance against gate voltage (low VDS): the channel (its mobility falling with THETA,
 *  level 3) plus RD and RS. Negative
 *  voltages for a P-channel part, as in its datasheet; values for the gates turned on only. */
export function rdsCurve(v: Values, gates: number[]): Curve {
  const on = gates.filter((g) => Math.abs(g) > Math.abs(v.vto ?? 0) + 1e-3)
  return {
    x: on,
    y: on.map((g) => {
      const vov = Math.abs(g) - Math.abs(v.vto ?? 0)
      return (1 + (v.theta ?? 0) * vov) / (v.kp * vov) + (v.rd ?? 0) + (v.rs ?? 0)
    }),
  }
}

/** x where a monotonic curve reaches y (interpolated in log space when both are positive). */
export function xAt(curve: Curve, y: number): number | null {
  for (let i = 0; i < curve.x.length - 1; i++) {
    const [a, b] = [curve.y[i], curve.y[i + 1]]
    if ((y - a) * (y - b) <= 0 && a !== b) {
      const t = a > 0 && b > 0 && y > 0 ? Math.log(y / a) / Math.log(b / a) : (y - a) / (b - a)
      return curve.x[i] + t * (curve.x[i + 1] - curve.x[i])
    }
  }
  return null
}

const capacitorFamily = ['capacitor', 'mlcc', 'electrolytic', 'film']

/** The feature handles of a template for its current values. `curves`: the model's curves by
 *  chart name (device templates: from the preview); `has`: whether the form gives a field. */
export function featureHandles(
  template: string,
  v: Values,
  curves: Record<string, Curve[]>,
  has: (key: string) => boolean,
): FeatureHandle[] {
  const out: FeatureHandle[] = []
  const lin = (chart: string, x: number) => {
    const c = curves[chart]?.[0]
    return c ? valueAt(c.x, c.y, x, false, false) : null
  }
  const log = (chart: string, x: number, logX = false) => {
    const c = curves[chart]?.[0]
    return c ? valueAt(c.x, c.y, x, logX, true) : null
  }

  if (capacitorFamily.includes(template) && finite(v.Cnom)) {
    const z = (f: number) => passiveValue(template, v, '|Z|(f)', f) ?? 0
    if (finite(v.esl) && finite(v.esr)) {
      const f0 = 1 / (TWO_PI * Math.sqrt(v.Cnom * v.esl))
      const others = z(f0) - v.esr // what else adds at resonance (an electrolytic's rise)
      out.push({
        label: 'SRF',
        chart: '|Z|(f)',
        x: f0,
        y: z(f0),
        hint: 'sideways ESL (the resonance), up / down ESR (the dip)',
        params: ['esl', 'esr'],
        apply: (f, y) => ({ esl: 1 / ((TWO_PI * f) ** 2 * v.Cnom), esr: Math.max(y - others, 1e-6) }),
      })
      const fc = f0 / 30
      out.push({
        label: 'C',
        chart: '|Z|(f)',
        x: fc,
        y: z(fc),
        hint: 'the capacitive slope: up / down C',
        params: ['Cnom'],
        apply: (f, y) => ({ Cnom: 1 / (TWO_PI * f * y) }),
      })
    }
    if (template === 'mlcc' && finite(v.vhalf))
      out.push({
        label: 'V½',
        chart: 'C(V)',
        x: v.vhalf,
        y: v.Cnom / 2,
        hint: 'sideways V½ (where C has halved), up / down C',
        params: ['vhalf', 'Cnom'],
        apply: (x, y) => ({ vhalf: Math.max(x, 1e-3), Cnom: 2 * y }),
      })
    if (template === 'electrolytic' && finite(v.flf) && finite(v.esr)) {
      const rlf = v.rlf ?? 0
      out.push({
        label: 'ESR HF',
        chart: 'ESR(f)',
        x: v.flf * 30,
        y: v.esr + rlf / (1 + 900),
        hint: 'up / down the high-frequency ESR',
        params: ['esr'],
        apply: (_x, y) => ({ esr: Math.max(y - rlf / 901, 1e-6) }),
      })
      out.push({
        label: 'corner',
        chart: 'ESR(f)',
        x: v.flf,
        y: v.esr + rlf / 2,
        hint: 'sideways the corner frequency, up / down the low-frequency rise',
        params: ['flf', 'rlf'],
        apply: (x, y) => ({ flf: x, rlf: Math.max(2 * (y - v.esr), 0) }),
      })
    }
  }

  if (template === 'inductor' && finite(v.Lnom)) {
    if (finite(v.cp)) {
      const f0 = 1 / (TWO_PI * Math.sqrt(v.Lnom * v.cp))
      out.push({
        label: 'SRF',
        chart: '|Z|(f)',
        x: f0,
        y: passiveValue(template, v, '|Z|(f)', f0) ?? 0,
        hint: has('cp')
          ? 'sideways Cp (the resonance), up / down Rp (the peak)'
          : 'sideways the SRF, up / down Rp',
        params: [has('cp') ? 'cp' : 'srf', ...(finite(v.rp) ? ['rp'] : [])],
        apply: (f, y) => ({
          ...(has('cp') ? { cp: 1 / ((TWO_PI * f) ** 2 * v.Lnom) } : { srf: f }),
          ...(finite(v.rp) ? { rp: Math.max(y, 1e-3) } : none),
        }),
      })
    }
    if (finite(v.isat))
      out.push({
        label: 'Isat',
        chart: 'L(I)',
        x: v.isat,
        y: v.Lnom / 2,
        hint: 'sideways Isat (where L has halved), up / down L',
        params: ['isat', 'Lnom'],
        apply: (x, y) => ({ isat: Math.max(x, 1e-6), Lnom: 2 * y }),
      })
  }

  // -- diodes: the forward curve is I(V) on a log current axis -------------------------------------
  if ('is' in v && 'n' in v && curves['I-V forward']?.length) {
    const fwd = curves['I-V forward'][0]
    const rs = v.rs ?? 0
    const at = (i: number) => xAt(fwd, i)
    const lowI = 1e-6
    const low = at(lowI)
    if (low !== null)
      out.push({
        label: 'IS',
        chart: 'I-V forward',
        x: low,
        y: lowI,
        hint: 'the current at low bias: IS (N kept)',
        params: ['is'],
        apply: (x, y) => {
          const model = log('I-V forward', x)
          return model && model > 0 ? { is: v.is * (y / model) } : none
        },
      })
    const midI = 1e-3
    const mid = at(midI)
    if (mid !== null && low !== null)
      out.push({
        label: 'N',
        chart: 'I-V forward',
        x: mid,
        y: midI,
        hint: 'the slope of the curve: N (the low-current point kept)',
        params: ['n', 'is'],
        apply: (x, y) => {
          const v1 = low - lowI * rs
          const v2 = x - y * rs
          if (y <= lowI * 1.01) return none
          const n = (v2 - v1) / (VT * Math.log(y / lowI))
          if (!(n > 0.2 && n < 20)) return none
          return { n, is: lowI / (Math.exp(v1 / (n * VT)) - 1) }
        },
      })
    const top = Math.max(...fwd.y.filter(Number.isFinite))
    const highI = top * 0.5
    const high = at(highI)
    if (high !== null && highI > midI * 3)
      out.push({
        label: 'RS',
        chart: 'I-V forward',
        x: high,
        y: highI,
        hint: 'the bend at high current: RS',
        params: ['rs'],
        apply: (x, y) => ({ rs: Math.max((x - v.n * VT * Math.log(y / v.is + 1)) / y, 0) }),
      })
    if (finite(v.bv) && curves['I-V reverse']?.length)
      out.push({
        label: 'BV',
        chart: 'I-V reverse',
        x: v.bv,
        y: finite(v.ibv) ? v.ibv : (log('I-V reverse', v.bv) ?? 1e-4),
        hint: 'sideways BV (the knee), up / down IBV',
        params: ['bv', ...(finite(v.ibv) ? ['ibv'] : [])],
        apply: (x, y) => ({ bv: Math.max(x, 0.1), ...(finite(v.ibv) ? { ibv: Math.max(y, 1e-12) } : none) }),
      })
    const cj = curves['C(V)']?.[0]
    if (finite(v.cjo) && cj?.x.length)
      out.push({
        label: 'CJO',
        chart: 'C(V)',
        x: cj.x[0],
        y: cj.y[0],
        hint: 'up / down the capacitance at 0 V',
        params: ['cjo'],
        apply: (_x, y) => ({ cjo: v.cjo * (y / cj.y[0]) }),
      })
  }

  // -- MOSFET / JFET: threshold and transconductance on Id(Vgs) -------------------------------------
  const transfer = curves['Id(Vgs)']?.[0]
  if ('vto' in v && transfer?.x.length) {
    const gain = 'kp' in v ? 'kp' : 'beta' in v ? 'beta' : null
    out.push({
      label: 'VTO',
      chart: 'Id(Vgs)',
      x: v.vto,
      y: lin('Id(Vgs)', v.vto) ?? 0,
      hint: 'sideways the threshold voltage',
      params: ['vto'],
      apply: (x) => ({ vto: x }),
    })
    const xs = transfer.x.filter(Number.isFinite)
    const far = v.vto + 0.7 * (Math.max(...xs) - v.vto)
    const id = lin('Id(Vgs)', far)
    if (gain && id && id > 0)
      out.push({
        label: gain.toUpperCase(),
        chart: 'Id(Vgs)',
        x: far,
        y: id,
        hint: `up / down the drain current: ${gain.toUpperCase()}`,
        params: [gain],
        apply: (x, y) => {
          const model = lin('Id(Vgs)', x)
          return model && model > 0 && y > 0 ? { [gain]: v[gain] * (y / model) } : none
        },
      })
  }

  // The flat end of RDS(Vgs): what the channel does not explain is RD + RS.
  const rds = curves['RDS(Vgs)']?.[0]
  if ('rd' in v && 'kp' in v && rds?.x.length) {
    const end = rds.x.length - 1
    const [g, r] = [rds.x[end], rds.y[end]]
    const channel = r - (v.rd + (v.rs ?? 0))
    out.push({
      label: 'RDS',
      chart: 'RDS(Vgs)',
      x: g,
      y: r,
      hint: 'up / down the flat end: RD and RS',
      params: ['rd', 'rs'],
      apply: (_x, y) => {
        const series = y - channel
        const now = v.rd + (v.rs ?? 0)
        if (!(series > 0)) return none
        return now > 0
          ? { rd: (v.rd * series) / now, rs: ((v.rs ?? 0) * series) / now }
          : { rd: series / 2, rs: series / 2 }
      },
    })
  }

  // -- BJT: gain peak and roll-off on hFE(Ic), IS on Ic(Vbe), VAF on Ic(Vce) -------------------------
  const hfe = curves['hFE(Ic)']?.[0]
  if ('bf' in v && hfe?.x.length) {
    let peak = 0
    hfe.y.forEach((y, i) => {
      if (Number.isFinite(y) && y > hfe.y[peak]) peak = i
    })
    out.push({
      label: 'BF',
      chart: 'hFE(Ic)',
      x: hfe.x[peak],
      y: hfe.y[peak],
      hint: 'up / down the gain: BF',
      params: ['bf'],
      apply: (_x, y) => (hfe.y[peak] > 0 && y > 0 ? { bf: v.bf * (y / hfe.y[peak]) } : none),
    })
    if (finite(v.ikf)) {
      const g = valueAt(hfe.x, hfe.y, v.ikf, true, false)
      if (g !== null)
        out.push({
          label: 'IKF',
          chart: 'hFE(Ic)',
          x: v.ikf,
          y: g,
          hint: 'sideways the high-current roll-off: IKF',
          params: ['ikf'],
          apply: (x) => ({ ikf: Math.max(x, 1e-9) }),
        })
    }
    // The fall at low current, base-emitter leakage: 1/hFE = 1/BF + ISE (Ic/IS)^(1/NE) / Ic.
    if ('ise' in v && finite(v.is) && finite(v.bf) && peak > 0) {
      const low = hfe.x[0]
      const anchor = low ** 0.7 * hfe.x[peak] ** 0.3 // where the fall is, above the end of the curve
      const excess = (y: number) => 1 / y - 1 / v.bf
      const ne = finite(v.ne) ? v.ne : 1.5
      const iseFor = (x: number, y: number, n: number) => (excess(y) * x) / (x / v.is) ** (1 / n)
      const gain = valueAt(hfe.x, hfe.y, anchor, true, false)
      if (gain !== null)
        out.push({
          label: 'ISE',
          chart: 'hFE(Ic)',
          x: anchor,
          y: gain,
          hint: 'the fall of the gain at low current: ISE',
          params: ['ise'],
          apply: (x, y) => (y > 0 && excess(y) > 0 ? { ise: iseFor(x, y, ne) } : none),
        })
      if (finite(v.ise) && low < anchor && gain !== null && excess(gain) > 0)
        out.push({
          label: 'NE',
          chart: 'hFE(Ic)',
          x: low,
          y: hfe.y[0],
          hint: 'how steeply the gain falls below ISE: NE',
          params: ['ne', 'ise'],
          apply: (x, y) => {
            if (!(y > 0 && excess(y) > 0 && x < anchor)) return none
            // Through this point and still through the ISE handle's.
            const inverse = 1 + Math.log(excess(y) / excess(gain)) / Math.log(x / anchor)
            if (!(inverse > 0)) return none
            const n = Math.min(Math.max(1 / inverse, 1), 4)
            return { ne: n, ise: iseFor(anchor, gain, n) }
          },
        })
    }
  }
  const icvbe = curves['Ic(Vbe)']?.[0]
  if ('bf' in v && finite(v.is) && icvbe?.x.length) {
    const x = xAt(icvbe, 1e-3)
    if (x !== null)
      out.push({
        label: 'IS',
        chart: 'Ic(Vbe)',
        x,
        y: 1e-3,
        hint: 'the collector current at a VBE: IS',
        params: ['is'],
        apply: (vx, y) => {
          const model = log('Ic(Vbe)', vx)
          return model && model > 0 ? { is: v.is * (y / model) } : none
        },
      })
  }
  const family = curves['Ic(Vce)']
  if ('vaf' in v && family?.length) {
    const topCurve = family[family.length - 1]
    const n = topCurve.x.length
    if (n > 4) {
      const x0 = topCurve.x[Math.floor(n * 0.3)]
      const i0 = topCurve.y[Math.floor(n * 0.3)]
      const x1 = topCurve.x[n - 1]
      out.push({
        label: 'VAF',
        chart: 'Ic(Vce)',
        x: x1,
        y: topCurve.y[n - 1],
        hint: 'up / down the slope of the lines: VAF',
        params: ['vaf'],
        apply: (_x, y) => {
          const r = y / i0
          if (!(r > 1.0001)) return { vaf: 1e4 }
          const vaf = (x1 - r * x0) / (r - 1)
          return vaf > 0 ? { vaf } : none
        },
      })
    }
  }

  // -- a resistor: its value on the flat part of |Z|(f) -----------------------------------------------
  const flat = curves['|Z|(f)']?.[0]
  if (template === 'resistor' && finite(v.Rnom) && flat?.x.length) {
    const [x0, y0] = [flat.x[0], flat.y[0]]
    out.push({
      label: 'R',
      chart: '|Z|(f)',
      x: x0,
      y: y0,
      hint: 'up / down the resistance',
      params: ['Rnom'],
      apply: (_x, y) => (y > 0 ? { Rnom: v.Rnom * (y / y0) } : none),
    })
  }

  // -- a transformer: the turns ratio in mid-band, the magnetizing inductance on |Zin| ---------------
  const ratio = curves['Ratio(f)']?.[0]
  if (finite(v.n) && finite(v.lp) && ratio?.x.length) {
    const mid = Math.floor(ratio.x.length / 2)
    const [x0, y0] = [ratio.x[mid], ratio.y[mid]]
    if (finite(y0))
      out.push({
        label: 'ratio',
        chart: 'Ratio(f)',
        x: x0,
        y: y0,
        hint: 'up / down the turns ratio',
        params: ['n'],
        apply: (_x, y) => (y > 0 ? { n: v.n * (y / y0) } : none),
      })
    const open = curves['|Zin|(f)']?.[0] // (secondary open: the first)
    if (open?.x.length) {
      // Where the primary is inductive: between its copper and its core loss.
      const rising = Math.sqrt(Math.max(v.rp || 0.1, 1e-3) * Math.max(v.rcore || 1e4, 1)) / (TWO_PI * v.lp)
      const x1 = Math.min(Math.max(rising, open.x[0]), open.x[open.x.length - 1])
      const y1 = valueAt(open.x, open.y, x1, true, true)
      if (y1 !== null && y1 > 0)
        out.push({
          label: 'Lp',
          chart: '|Zin|(f)',
          x: x1,
          y: y1,
          hint: 'the magnetizing inductance: ωL through this point',
          params: ['lp'],
          apply: (x, y) => (x > 0 && y > 0 ? { lp: v.lp * (y / y1) * (x1 / x) } : none),
        })
    }
  }

  // -- an op-amp: the DC gain and where the gain reaches 0 dB -------------------------------------------
  const open = curves['Aol(f)']?.[0]
  if (finite(v.aol) && finite(v.gbw) && open?.x.length) {
    const [x0, y0] = [open.x[0], open.y[0]]
    out.push({
      label: 'Aol',
      chart: 'Aol(f)',
      x: x0,
      y: y0,
      hint: 'up / down the DC gain',
      params: ['aol'],
      apply: (_x, y) => ({ aol: v.aol * 10 ** ((y - y0) / 20) }),
    })
    const unity = xAt(open, 0)
    if (unity !== null && unity > 0)
      out.push({
        label: 'GBW',
        chart: 'Aol(f)',
        x: unity,
        y: 0,
        hint: 'sideways the gain-bandwidth product',
        params: ['gbw'],
        apply: (x) => (x > 0 ? { gbw: v.gbw * (x / unity) } : none),
      })
  }
  return out
}

/**
 * The unlocked values of a passive template changed as little as possible (log scale) so that its
 * curve on `chart` goes through `target` and stays at `anchors` (the curve's values before the
 * drag, away from the target). Null when nothing can move.
 */
export function pullCurve(
  template: string,
  start: Values,
  chart: string,
  target: [number, number],
  free: string[],
  anchors: [number, number][],
  limits: (key: string) => [number | null, number | null] = () => [null, null],
): Values | null {
  const keys = free.filter((k) => finite(start[k]))
  if (!keys.length) return null
  const logY = chart !== 'phase(f)'
  const res = (v: Values) => {
    const out: number[] = []
    const value = (x: number) => passiveValue(template, v, chart, x)
    const diff = (model: number | null, want: number, weight: number) => {
      if (model === null || !Number.isFinite(model)) return out.push(1e3)
      out.push(
        weight * (logY ? Math.log(Math.max(model, 1e-300) / Math.max(want, 1e-300)) : (model - want) / 30),
      )
    }
    diff(value(target[0]), target[1], 8)
    for (const [x, y] of anchors) diff(value(x), y, 1)
    keys.forEach((k) => {
      out.push(0.05 * Math.log(v[k] / start[k])) // the least change
    })
    return out
  }
  const clamp = (k: string, value: number) => {
    const [lo, hi] = limits(k)
    return Math.min(Math.max(value, lo ?? 0), hi ?? Number.POSITIVE_INFINITY)
  }
  let p = keys.map((k) => Math.log(start[k]))
  const valuesOf = (q: number[]) => {
    const v = { ...start }
    keys.forEach((k, i) => {
      v[k] = clamp(k, Math.exp(q[i]))
    })
    return v
  }
  let lambda = 1e-2
  let r = res(valuesOf(p))
  let cost = r.reduce((s, e) => s + e * e, 0)
  for (let iter = 0; iter < 12; iter++) {
    const h = 1e-4
    const jac = keys.map((_k, j) => {
      const q = [...p]
      q[j] += h
      return res(valuesOf(q)).map((e, i) => (e - r[i]) / h)
    })
    const n = keys.length
    const a = Array.from({ length: n }, (_v, i) =>
      Array.from({ length: n }, (_w, j) => jac[i].reduce((s, e, m) => s + e * jac[j][m], 0)),
    )
    const g = Array.from({ length: n }, (_v, i) => jac[i].reduce((s, e, m) => s + e * r[m], 0))
    let improved = false
    for (let tries = 0; tries < 6 && !improved; tries++) {
      const m = a.map((row, i) => row.map((e, j) => e + (i === j ? lambda * (e + 1e-9) : 0)))
      const dp = solve(
        m,
        g.map((e) => -e),
      )
      if (!dp) {
        lambda *= 10
        continue
      }
      const q = p.map((e, i) => e + Math.max(-2, Math.min(2, dp[i])))
      const rq = res(valuesOf(q))
      const cq = rq.reduce((s, e) => s + e * e, 0)
      if (cq < cost) {
        p = q
        r = rq
        cost = cq
        lambda = Math.max(lambda / 3, 1e-6)
        improved = true
      } else lambda *= 4
    }
    if (!improved) break
  }
  const out = valuesOf(p)
  return Object.fromEntries(keys.map((k) => [k, out[k]]))
}

/** Gaussian elimination with partial pivoting (small systems). */
function solve(a: number[][], b: number[]): number[] | null {
  const n = b.length
  const m = a.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let pivot = c
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r][c]) > Math.abs(m[pivot][c])) pivot = r
    if (Math.abs(m[pivot][c]) < 1e-300) return null
    ;[m[c], m[pivot]] = [m[pivot], m[c]]
    for (let r = c + 1; r < n; r++) {
      const f = m[r][c] / m[c][c]
      for (let k = c; k <= n; k++) m[r][k] -= f * m[c][k]
    }
  }
  const x = new Array<number>(n).fill(0)
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r][n]
    for (let k = r + 1; k < n; k++) s -= m[r][k] * x[k]
    x[r] = s / m[r][r]
  }
  return x.every(Number.isFinite) ? x : null
}
