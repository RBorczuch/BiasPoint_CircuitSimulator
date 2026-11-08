/**
 * "Values from the datasheet" (docs/projekt-kreator.md §8): cards that turn a datasheet table's
 * values into the template's (VZ at IZT → BV, IBV, RS; Ciss, Coss, Crss → the capacitances…).
 * Each card shows what would change before Apply; a card folded stays folded for its template.
 */
import { type ReactNode, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { parseValue, spiceNumber } from '@/lib/units'

const VT = (1.380649e-23 * 300.15) / 1.602176634e-19 // thermal voltage at 27 °C
/** A value for a form field: three digits, with a SPICE suffix (200p, not 2.00e-10). */
const round = (x: number) => spiceNumber(Number(x.toPrecision(3)))

type Values = Record<string, string>
type Apply = (values: Values) => void

interface FieldSpec {
  label: string // also the input's accessible name
  value: string
  set: (v: string) => void
  placeholder?: string
  unit?: string
  width?: string
}

const folded = (key: string): boolean => {
  try {
    return localStorage.getItem(`bpt.helper.${key}`) === 'folded'
  } catch {
    return false
  }
}

/** A card: its title (click: fold / unfold), its inputs, the values it would set, Apply. */
export function HelperCard({
  title,
  testid,
  remember,
  fields,
  result,
  note,
  onApply,
  children,
}: {
  title: string
  testid: string
  remember: string // where its folding is remembered (the template)
  fields?: FieldSpec[]
  result?: Values | string | null // the values it would set, or why it cannot yet
  note?: ReactNode
  onApply?: (values: Values) => void
  children?: ReactNode
}) {
  const key = `${remember}:${testid}`
  const [open, setOpen] = useState(() => !folded(key))
  const toggle = () => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(`bpt.helper.${key}`, next ? 'open' : 'folded')
    } catch {
      // only not remembered
    }
  }
  const ready = result && typeof result === 'object' ? result : null
  return (
    <div className="rounded-md border text-xs" data-testid={testid}>
      <button
        type="button"
        className="flex w-full items-center gap-1 px-2 py-1 text-left font-medium hover:bg-accent/50"
        aria-expanded={open}
        onClick={toggle}
      >
        <span className="text-muted-foreground">{open ? '▾' : '▸'}</span>
        {title}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t px-2 py-1.5">
          {fields && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {fields.map((f) => (
                <span key={f.label} className="flex items-center gap-1">
                  <span className="text-muted-foreground">{f.label}</span>
                  <Input
                    aria-label={f.label}
                    className={`h-6 font-mono text-xs ${f.width ?? 'w-16'}`}
                    placeholder={f.placeholder}
                    value={f.value}
                    onChange={(e) => f.set(e.target.value)}
                  />
                  {f.unit && <span className="text-muted-foreground">{f.unit}</span>}
                </span>
              ))}
            </div>
          )}
          {children}
          {note}
          {result !== undefined && (
            <div className="flex items-center gap-2">
              <span
                className={`min-w-0 flex-1 font-mono ${ready ? '' : 'text-muted-foreground'}`}
                data-testid={`${testid}-preview`}
              >
                {ready
                  ? `→ ${Object.entries(ready)
                      .map(([k, v]) => `${k.toUpperCase()} ${v}`)
                      .join(' · ')}`
                  : typeof result === 'string'
                    ? result
                    : ''}
              </span>
              {onApply && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-xs"
                  disabled={!ready}
                  onClick={() => ready && onApply(ready)}
                >
                  Apply
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** A Zener's table values → BV, IBV, RS: VZ at IZT, the slope there N·Vt / IZT + RS. */
export function ZenerValues({ n, remember, onApply }: { n: number; remember: string; onApply: Apply }) {
  const [vz, setVz] = useState('5.1')
  const [izt, setIzt] = useState('5m')
  const [zz, setZz] = useState('40')
  const [v, i, z] = [parseValue(vz), parseValue(izt), parseValue(zz)]
  const result =
    v === null || i === null || z === null || i <= 0
      ? 'Give VZ, IZT and ZZT as numbers'
      : (() => {
          const rs = Math.max(z - (n * VT) / i, 0.01)
          return { bv: (v - i * rs).toPrecision(4), ibv: i.toPrecision(3), rs: rs.toPrecision(3) }
        })()
  return (
    <HelperCard
      title="Zener from the datasheet table"
      testid="zener-values"
      remember={remember}
      fields={[
        { label: 'VZ', value: vz, set: setVz, unit: 'V' },
        { label: 'IZT', value: izt, set: setIzt, unit: 'A' },
        { label: 'ZZT', value: zz, set: setZz, unit: 'Ω' },
      ]}
      result={result}
      onApply={onApply}
    />
  )
}

/**
 * An electrolytic from the catalogue's maxima: |Z| at 100 kHz is the high-frequency ESR; tan δ at
 * 120 Hz gives the ESR there, tan δ / (2π·120·C), and the rise above the HF ESR (halving at
 * 1 kHz); the leakage after a minute at the rated voltage gives R leak (when not given: the usual
 * 0.01·C·V or 3 µA, whichever is greater).
 */
export function ElectrolyticValues({
  cnom,
  remember,
  onApply,
}: {
  cnom: string
  remember: string
  onApply: Apply
}) {
  const [tan, setTan] = useState('0.14')
  const [z, setZ] = useState('')
  const [leak, setLeak] = useState('')
  const [volts, setVolts] = useState('25')
  const c = parseValue(cnom)
  const t = parseValue(tan)
  const esr120 = c && t ? t / (2 * Math.PI * 120 * c) : null
  const [zh, v] = [parseValue(z), parseValue(volts)]
  // 0.01·C[µF]·V in µA is 0.01·C·V in A.
  const i = leak.trim() ? parseValue(leak) : c && v ? Math.max(0.01 * c * v, 3e-6) : null
  const result =
    !c || esr120 === null || zh === null || v === null || v <= 0
      ? 'Give C, tan δ, Z at 100 kHz and the rated voltage'
      : i === null || i <= 0
        ? 'Give the leakage current as a number (e.g. 3u)'
        : {
            esr: round(zh),
            rlf: round(Math.max(esr120 - zh, 0) * (1 + (120 / 1e3) ** 2)),
            flf: '1k',
            rleak: round(v / i),
          }
  return (
    <HelperCard
      title="Electrolytic from the catalogue"
      testid="electrolytic-values"
      remember={remember}
      fields={[
        { label: 'tan δ', value: tan, set: setTan },
        { label: 'Z at 100 kHz', value: z, set: setZ, placeholder: 'Ω' },
        { label: 'Leakage current', value: leak, set: setLeak, placeholder: '0.01CV' },
        { label: 'Rated voltage', value: volts, set: setVolts, unit: 'V' },
      ]}
      note={
        esr120 !== null && (
          <span className="text-[11px] text-muted-foreground">ESR at 120 Hz: {esr120.toPrecision(3)} Ω</span>
        )
      }
      result={result}
      onApply={onApply}
    />
  )
}

/** A MOSFET's capacitances → level 1: Cgd = Crss, Cgs = Ciss − Crss, Cds = Coss − Crss. */
export function MosfetValues({ remember, onApply }: { remember: string; onApply: Apply }) {
  const [ciss, setCiss] = useState('')
  const [coss, setCoss] = useState('')
  const [crss, setCrss] = useState('')
  const [i, o, r] = [parseValue(ciss), parseValue(coss), parseValue(crss)]
  const f = (x: number) => round(Math.max(x, 0))
  const result =
    i === null || o === null || r === null
      ? 'Give Ciss, Coss and Crss (e.g. 50p)'
      : { cgso: f(i - r), cgdo: f(r), cbd: f(o - r) }
  return (
    <HelperCard
      title="Capacitances from the datasheet table"
      testid="mosfet-values"
      remember={remember}
      fields={[
        { label: 'Ciss', value: ciss, set: setCiss, unit: 'F' },
        { label: 'Coss', value: coss, set: setCoss, unit: 'F' },
        { label: 'Crss', value: crss, set: setCrss, unit: 'F' },
      ]}
      result={result}
      onApply={onApply}
    />
  )
}

/** A MOSFET's gate charge → level 1: Cgd swings by about VDD on the plateau (Qgd), Cgs + Cgd
 *  charge up to the plateau voltage (Qgs). Same formula as the backend's gate_charge_values. */
export function GateChargeValues({ remember, onApply }: { remember: string; onApply: Apply }) {
  const [qgs, setQgs] = useState('')
  const [qgd, setQgd] = useState('')
  const [plateau, setPlateau] = useState('')
  const [vdd, setVdd] = useState('')
  const [s, d, p, v] = [parseValue(qgs), parseValue(qgd), parseValue(plateau), parseValue(vdd)]
  const result =
    s === null || d === null || p === null || v === null || p <= 0 || v <= 0
      ? 'Give Qgs, Qgd, the plateau voltage and the VDD of the test (e.g. 2n, 4n, 4.5, 30)'
      : {
          cgso: round(Math.max(s / p - d / v, 0)),
          cgdo: round(d / v),
        }
  return (
    <HelperCard
      title="Capacitances from the gate charge"
      testid="gate-charge-values"
      remember={remember}
      fields={[
        { label: 'Qgs', value: qgs, set: setQgs, unit: 'C' },
        { label: 'Qgd', value: qgd, set: setQgd, unit: 'C' },
        { label: 'Plateau', value: plateau, set: setPlateau, unit: 'V' },
        { label: 'VDD', value: vdd, set: setVdd, unit: 'V' },
      ]}
      note={
        <span className="text-[11px] text-muted-foreground">
          Constant capacitances: the card's Vgs(Qg) shows how close the plateau comes.
        </span>
      }
      result={result}
      onApply={onApply}
    />
  )
}

/** A BJT's fT, Cobo, Cibo → TF, CJC, CJE: the transit time is 1/(2π·fT) less the time to charge
 *  the junctions at that current. */
export function BjtValues({ remember, onApply }: { remember: string; onApply: Apply }) {
  const [ft, setFt] = useState('')
  const [ic, setIc] = useState('10m')
  const [cobo, setCobo] = useState('')
  const [cibo, setCibo] = useState('')
  const [f, i, o, b] = [parseValue(ft), parseValue(ic), parseValue(cobo), parseValue(cibo)]
  const result =
    f === null || i === null || o === null || b === null || f <= 0 || i <= 0
      ? 'Give fT, its Ic, Cobo and Cibo (e.g. 300meg, 10m, 4p, 9p)'
      : {
          tf: round(Math.max(1 / (2 * Math.PI * f) - ((o + b) * VT) / i, 1e-12)),
          cjc: round(o),
          cje: round(b),
        }
  return (
    <HelperCard
      title="Speed and capacitances from the table"
      testid="bjt-values"
      remember={remember}
      fields={[
        { label: 'fT', value: ft, set: setFt, unit: 'Hz' },
        { label: 'Ic of fT', value: ic, set: setIc, unit: 'A' },
        { label: 'Cobo', value: cobo, set: setCobo, unit: 'F' },
        { label: 'Cibo', value: cibo, set: setCibo, unit: 'F' },
      ]}
      result={result}
      onApply={onApply}
    />
  )
}
