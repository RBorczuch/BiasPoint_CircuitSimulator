/**
 * Component maker (FR-CMP): a real part from a template – built-in (a form with formulas) or a
 * user's / library's equivalent circuit (FR-CMP-9: passives, transformers, transistors, ICs) –
 * or from an own sheet with ports, with values fitted to characteristic points (typed, pasted
 * from CSV, digitized from a datasheet chart or measured). The template's equivalent circuit
 * is drawn with the form's values. A full-window tab like the symbol editor.
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Lock, LockOpen, Maximize2, Redo2, Undo2 } from 'lucide-react'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'
import { apiGet, apiPatch, apiPost } from '@/api/client'
import type { Characteristic, Command } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { Input } from '@/components/ui/input'
import { fieldsOf, useCategories } from '@/lib/categories'
import { nearestE24 } from '@/lib/eseries'
import { type Curve, featureHandles, pullCurve, rdsCurve, type Values } from '@/lib/handles'
import { paramInfo } from '@/lib/paramHelp'
import { hasFormulas, numbers as passiveNumbers, previewCurves } from '@/lib/passives'
import {
  insertPoint,
  parsePoints,
  parseWeightedPoints,
  percentToFarads,
  pointRows,
  withLine,
} from '@/lib/points'
import { toRealPart } from '@/lib/realParts'
import { useTheme } from '@/lib/theme'
import { formatValue, parseValue, spiceNumber, toSpice, valueHint } from '@/lib/units'
import { editSheetAsTemplate, editTemplate } from '@/panels/TemplatePanel'
import { prompt } from '@/store/dialogs'
import { reloadLibrary, useProject } from '@/store/project'
import { type CardCurve, ComponentCard, curveSeries } from './ComponentCard'
import { CsvImport } from './CsvImport'
import {
  CHART_AXES,
  CHART_COLORS,
  ChartGroup,
  type ChartGroupValue,
  type ChartHandle,
  type ChartResiduals,
  type ChartSeries,
  type Cursors,
  CurveChart,
} from './CurveChart'
import {
  BjtValues,
  ElectrolyticValues,
  GateChargeValues,
  HelperCard,
  MosfetValues,
  ZenerValues,
} from './DatasheetHelpers'
import { ParamHelp } from './ParamHelp'
import {
  CategorySelect,
  DataPage,
  dataFields,
  SymbolPage,
  splitData,
  stalePlaced,
  UsagePage,
  updatePlaced,
} from './PartPages'
import { PictureTrace, type TraceState } from './PictureTrace'
import { PointsEditor } from './PointsEditor'
import { type SpiceChoice, SpiceModelPage, spiceItem } from './SpiceModel'
import { Tip } from './Tip'

const PANEL = 'componentWizard'

export interface TemplateField {
  key: string
  label: string
  unit: string
  default: string
  description: string
  required: boolean
  minimum?: string // lowest value the form accepts ("" = any)
  maximum?: string
  group?: string // heading the form shows it under
  help?: string // more for the parameter's card
}

export interface TemplateInfo {
  name: string
  label: string
  kind: string
  symbol: string
  description: string
  main: string // field shown as the value ("" = none)
  fields: TemplateField[]
  library: string // "" = built in
  ports: string[]
  version?: number
  category?: string // where the library offers it ("Capacitors/Ceramic")
}

interface Circuit {
  svg: string
  ports: string[]
  parameters: Record<string, string>
}

interface FitCurve {
  name: string
  x: number[]
  measured: number[]
  model: number[]
  error: number
  max_error: number
  residuals: number[] // per point: percent (degrees for a phase), model - measured
}

interface FitResult {
  values: Record<string, string>
  curves: FitCurve[]
  error: number
  max_error: number
  iterations: number
}

export interface WizardInit {
  mode?: 'template' | 'sheet' | 'spice'
  template?: string
  form?: Record<string, string>
  name?: string
  sheet?: string // own equivalent circuit: a sheet of the project
  replace?: { sheet: string; id: string } // a part to turn into the new component
  edit?: string // a library part to edit (a standard one: a copy in the user's library)
  page?: Page // the page it opens on
}

/** A library part as the editor loads it. */
interface EditedPart {
  id: string
  name: string
  description: string
  category?: string
  metadata: Record<string, string>
  ratings: Record<string, string>
  version: number
  template?: { name: string; values: Record<string, string> } | null
  characteristics: Characteristic[]
}
type Page = 'kind' | 'model' | 'characteristics' | 'symbol' | 'data' | 'usage'
const PAGES: [Page, string][] = [
  ['model', 'Model'],
  ['characteristics', 'Characteristics'],
  ['symbol', 'Symbol'],
  ['data', 'Data'],
  ['usage', 'Usage'],
]

const useWizard = create<{ init: WizardInit | null; serial: number; open: (init: WizardInit) => void }>(
  (set) => ({
    init: null,
    serial: 0,
    open: (init) => set((s) => ({ init, serial: s.serial + 1 })),
  }),
)

/** Open the component maker (a tab on the whole window). */
export function openComponentWizard(init: WizardInit = {}): void {
  useWizard.getState().open(init)
  window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: PANEL }))
}

const PASSIVE = ['|Z|(f)', 'phase(f)', 'ESR(f)', 'C(V)', 'L(I)'] as const
// Diodes: the forward voltage at a forward current, the junction capacitance at a reverse voltage.
const DIODE = ['VF(IF)', 'VZ(IZ)', 'Cj(VR)'] as const
// MOSFETs: the drain current at a gate voltage (transfer curve, threshold point), the on-resistance.
const MOS = ['Id(Vgs)', 'RDS(Vgs)', 'Id(Vds)'] as const
// Bipolar transistors: current gain, base-emitter voltage, saturation voltage (forced beta).
const BJT = ['hFE(Ic)', 'VBE(Ic)', 'VCEsat(Ic)', 'Ic(Vce)'] as const
// Transformers and op-amps: by simulation of their own benches.
const TRANSFORMER = ['Ratio(f)', '|Zin|(f)'] as const
const OPAMP = ['Aol(f)'] as const
// A small-signal transistor (hybrid-pi): its current gain against frequency.
const HYBRID = ['h21(f)'] as const
const KINDS = [...PASSIVE, ...DIODE, ...MOS, ...BJT, ...TRANSFORMER, ...OPAMP, ...HYBRID] as const
type Kind = (typeof KINDS)[number]
// The diode model parameters these points fit (other fields, e.g. BV, come from the form).
const DIODE_FIT = new Set(['is', 'n', 'rs', 'cjo', 'vj', 'mj', 'bv', 'ibv'])
const MOS_FIT = new Set(['vto', 'kp', 'lambda', 'theta', 'rd', 'rs'])
const BJT_FIT = new Set(['is', 'bf', 'br', 'vaf', 'ikf', 'ise', 'ne', 'rb', 'rc'])
// What their curves set: not the coupling k (its log scale would go above 1), not an op-amp's swing.
const TRANSFORMER_FIT = new Set(['lp', 'n', 'rp', 'rcore', 'cw'])
const OPAMP_FIT = new Set(['aol', 'gbw'])
const HYBRID_FIT = new Set(['beta', 'cpi', 'cmu', 'rx'])
const VT = (1.380649e-23 * 300.15) / 1.602176634e-19 // thermal voltage at 27 °C
// Typical LEDs at 20 mA by colour: forward voltage, emission coefficient, series resistance.
const LED_COLORS: Record<string, { vf: number; n: number; rs: number }> = {
  red: { vf: 2.0, n: 2.0, rs: 8 },
  orange: { vf: 2.05, n: 2.0, rs: 8 },
  yellow: { vf: 2.1, n: 2.0, rs: 8 },
  green: { vf: 3.1, n: 3.5, rs: 12 },
  blue: { vf: 3.2, n: 3.5, rs: 12 },
  white: { vf: 3.2, n: 3.5, rs: 12 },
  infrared: { vf: 1.3, n: 1.5, rs: 1.5 },
}
// Where diode points go on the part's datasheet curves.
const DIODE_ON: Record<string, Kind> = { 'I-V forward': 'VF(IF)', 'I-V reverse': 'VZ(IZ)', 'C(V)': 'Cj(VR)' }
// Points drawn on a semiconductor's card curve; `swap`: the points are (I, V), the curve I(V).
const SIMULATED_PULL = ['|Z|(f)', 'ESR(f)', 'C(V)', 'L(I)']
const MULTIPORT_PULL = ['Ratio(f)', '|Zin|(f)', 'Aol(f)', 'h21(f)']
const isOpamp = (ports: string[]) => ['+', '-', 'V+', 'V-', 'out'].every((p) => ports.includes(p))
/** A small-signal transistor: a transistor drawn of linear parts, pins B, C and E only (one with
 *  a model inside is a device, with datasheet curves of its own). */
const isHybrid = (t: { library: string; kind: string; ports: string[]; name: string }) =>
  Boolean(t.library) && t.kind === 'transistor' && /hybrid/i.test(t.name) && t.ports.length === 3
const isTransformer = (kind: string, ports: string[]) =>
  ['P1', 'P2', 'S1', 'S2'].every((p) => ports.includes(p)) || (kind === 'transformer' && ports.length >= 4)
const ON_CURVE: Record<string, { kind: Kind; swap: boolean }> = {
  'I-V forward': { kind: 'VF(IF)', swap: true },
  'I-V reverse': { kind: 'VZ(IZ)', swap: true },
  'Id(Vgs)': { kind: 'Id(Vgs)', swap: false },
  'hFE(Ic)': { kind: 'hFE(Ic)', swap: false },
  'Ic(Vbe)': { kind: 'VBE(Ic)', swap: true },
}

/** Where a field's value came from: shown as a dot by the field. */
type Origin = 'user' | 'fit' | 'datasheet'
const ORIGIN: Record<Origin, { color: string; title: string }> = {
  user: { color: 'bg-sky-500', title: 'typed' },
  fit: { color: 'bg-emerald-500', title: 'fitted to the points' },
  datasheet: { color: 'bg-amber-500', title: 'from the datasheet values' },
}

/** Whether a value sits at one of its fit limits (within 0.5 %): the fit stopped there. */
function atBound(value: string, [lo, hi]: [string, string]): boolean {
  const v = parseValue(value)
  if (v === null) return false
  return [lo, hi].some((b) => {
    const limit = b.trim() ? parseValue(b) : null
    return limit !== null && Math.abs(v - limit) <= Math.abs(limit) * 0.005 + 1e-30
  })
}

/** Points as lines of text: five significant digits, without trailing zeros (1000 16, 2e-11). */
const pointsText = (points: [number, number][]) =>
  points.map(([x, y]) => `${Number(x.toPrecision(5))} ${Number(y.toPrecision(5))}`).join('\n')

const AXIS_HINT: Record<Kind, string> = {
  '|Z|(f)': 'frequency [Hz]  impedance [Ω]',
  'phase(f)': 'frequency [Hz]  phase [°]',
  'ESR(f)': 'frequency [Hz]  ESR [Ω]',
  'C(V)': 'DC bias [V]  capacitance [F]',
  'L(I)': 'DC current [A]  inductance [H]',
  'VF(IF)': 'forward current [A]  forward voltage [V]',
  'Cj(VR)': 'reverse voltage [V]  junction capacitance [F]',
  'VZ(IZ)': 'reverse current [A]  Zener voltage [V]',
  'Id(Vgs)': 'gate voltage [V]  drain current [A] (threshold: Vth at its test current)',
  'RDS(Vgs)': 'gate voltage [V]  on-resistance [Ω]',
  'hFE(Ic)': 'collector current [A]  current gain',
  'VBE(Ic)': 'collector current [A]  base-emitter voltage [V]',
  'VCEsat(Ic)': 'collector current [A]  saturation voltage [V]',
  'Id(Vds)': 'drain voltage [V]  drain current [A]',
  'Ic(Vce)': 'collector voltage [V]  collector current [A]',
  'Ratio(f)': 'frequency [Hz]  voltage ratio [V/V]',
  '|Zin|(f)': 'frequency [Hz]  input impedance [Ω]',
  'Aol(f)': 'frequency [Hz]  open-loop gain [dB]',
  'h21(f)': 'frequency [Hz]  current gain',
}

export function ComponentWizard() {
  const { init, serial } = useWizard()
  const project = useProject((s) => s.project)
  const execute = useProject((s) => s.execute)
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => apiGet<TemplateInfo[]>('/api/components/templates'),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const [mode, setMode] = useState<'template' | 'sheet' | 'spice'>('template')
  const [spiceText, setSpiceText] = useState('')
  const [spiceChoice, setSpiceChoice] = useState<SpiceChoice | null>(null)
  const [templateName, setTemplateName] = useState('capacitor')
  const [form, setForm] = useState<Record<string, string>>({})
  const [origin, setOrigin] = useState<Record<string, Origin>>({})
  // Undo / redo of the form; typing in one field is one step.
  const history = useRef<{
    past: Record<string, string>[]
    future: Record<string, string>[]
    typing: string | null
  }>({
    past: [],
    future: [],
    typing: null,
  })
  const [, setSteps] = useState(0) // re-renders the undo / redo buttons
  const applyForm = (update: Record<string, string>, source: Origin, typing?: string) => {
    const h = history.current
    if (!typing || h.typing !== typing) {
      h.past = [...h.past.slice(-99), form]
      h.future = []
    }
    h.typing = typing ?? null
    setForm({ ...form, ...update })
    setOrigin((o) => ({ ...o, ...Object.fromEntries(Object.keys(update).map((k) => [k, source])) }))
    setSteps((n) => n + 1)
  }
  const undoForm = (back: boolean) => {
    const h = history.current
    const from = back ? h.past : h.future
    const previous = from.pop()
    if (!previous) return
    ;(back ? h.future : h.past).push(form)
    h.typing = null
    setForm(previous)
    setSteps((n) => n + 1)
  }
  const resetHistory = () => {
    history.current = { past: [], future: [], typing: null }
    setOrigin({})
    setSteps((n) => n + 1)
  }
  const [free, setFree] = useState<Set<string>>(new Set())
  // The parameter whose card is open: its part of the curves is highlighted on the charts.
  const [helpKey, setHelpKey] = useState<string | null>(null)
  // The x range each kind of points is fitted over (outside: shown, weight 0); "" = open.
  const [ranges, setRanges] = useState<Partial<Record<Kind, [string, string]>>>({})
  // Limits of fitted values: key -> [min, max] as typed ("" = open).
  const [bounds, setBounds] = useState<Record<string, [string, string]>>({})
  const [sheetName, setSheetName] = useState('')
  const [drive, setDrive] = useState<'v' | 'i'>('v')
  const [points, setPoints] = useState<Record<Kind, string>>({
    '|Z|(f)': '',
    'phase(f)': '',
    'ESR(f)': '',
    'C(V)': '',
    'L(I)': '',
    'VF(IF)': '',
    'Cj(VR)': '',
    'VZ(IZ)': '',
    'Id(Vgs)': '',
    'RDS(Vgs)': '',
    'hFE(Ic)': '',
    'VBE(Ic)': '',
    'VCEsat(Ic)': '',
    'Id(Vds)': '',
    'Ic(Vce)': '',
    'Ratio(f)': '',
    '|Zin|(f)': '',
    'Aol(f)': '',
    'h21(f)': '',
  })
  const [tab, setTab] = useState<Kind>('|Z|(f)')
  const [name, setName] = useState('')
  const [library, setLibrary] = useState('My parts')
  const [description, setDescription] = useState('')
  const [meta, setMeta] = useState<Record<string, string>>({})
  const [page, setPage] = useState<Page>('model')
  const [visited, setVisited] = useState<Set<Page>>(new Set()) // steps seen (the bar marks them)
  const [chartTab, setChartTab] = useState<string | null>(null) // the chart shown large
  const [chartGrid, setChartGrid] = useState(false) // all charts at once instead
  const [fullChart, setFullChart] = useState<string | null>(null) // the chart in full screen
  const [chartCursors, setChartCursors] = useState<Record<string, Cursors>>({}) // per x axis
  // biome-ignore lint/correctness/useExhaustiveDependencies: another model: other charts
  useEffect(() => {
    setFullChart(null)
    setChartCursors({})
  }, [templateName])
  const [pointsOpen, setPointsOpen] = useState(true)
  const [pointsView, setPointsView] = useState<'table' | 'text'>(() => {
    try {
      return localStorage.getItem('bpt.points.view') === 'text' ? 'text' : 'table'
    } catch {
      return 'table'
    }
  })
  const choosePointsView = (view: 'table' | 'text') => {
    setPointsView(view)
    try {
      localStorage.setItem('bpt.points.view', view)
    } catch {
      // only not remembered
    }
  }
  const [circuitBig, setCircuitBig] = useState(false)
  const [templateQuery, setTemplateQuery] = useState('')
  const nameRef = useRef<HTMLInputElement>(null)
  const libraryRef = useRef<HTMLInputElement>(null)
  const [category, setCategory] = useState('')
  const [look, setLook] = useState<string | null>(null) // null: as the template draws it
  const [changes, setChanges] = useState('')
  const [sources, setSources] = useState<Partial<Record<Kind, string>>>({}) // where points come from
  // The library part being edited: its id and version, and whether it is a standard one.
  const [editing, setEditing] = useState<{
    id: string
    version: number
    standard: boolean
    template: boolean
  } | null>(null)
  const categories = useCategories()
  const queries = useQueryClient()
  const symbols = useProject((s) => s.symbols)
  const [result, setResult] = useState<FitResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<CardCurve[]>([])
  const previewAsk = useRef(0) // the latest preview request; older answers are dropped
  const [circuit, setCircuit] = useState<Circuit | null>(null)
  const [circuitError, setCircuitError] = useState('')
  const theme = useTheme((s) => s.theme)
  const csvRef = useRef<HTMLInputElement>(null)
  const template = templates.find((t) => t.name === templateName)
  // The category the part gets without one of its own: its template's.
  const automaticCategory = mode === 'template' ? (template?.category ?? '') : ''

  // A fresh start each time the maker is opened.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs per opening (serial)
  useEffect(() => {
    if (!init) return
    setMode(init.mode ?? (init.sheet ? 'sheet' : 'template'))
    setTemplateName(init.template ?? 'capacitor')
    setForm(init.form ?? {})
    resetHistory()
    setFree(new Set())
    setSheetName(init.sheet ?? '')
    setPoints({
      '|Z|(f)': '',
      'phase(f)': '',
      'ESR(f)': '',
      'C(V)': '',
      'L(I)': '',
      'VF(IF)': '',
      'Cj(VR)': '',
      'VZ(IZ)': '',
      'Id(Vgs)': '',
      'RDS(Vgs)': '',
      'hFE(Ic)': '',
      'VBE(Ic)': '',
      'VCEsat(Ic)': '',
      'Id(Vds)': '',
      'Ic(Vce)': '',
      'Ratio(f)': '',
      '|Zin|(f)': '',
      'Aol(f)': '',
      'h21(f)': '',
    })
    setName(init.name ?? '')
    setDescription('')
    setMeta({})
    setResult(null)
    // A new part from nothing starts with how it is modelled (step 1); from a template, a sheet
    // or an existing part: straight on its model.
    setPage(init.page ?? (init.edit || init.template || init.sheet || init.mode ? 'model' : 'kind'))
    setVisited(new Set())
    setCategory('')
    setLook(null)
    setChanges('')
    setSources({})
    setSpiceText('')
    setSpiceChoice(null)
    setEditing(null)
    if (init.edit) void loadPart(init.edit)
  }, [serial])

  const loadPart = async (id: string) => {
    try {
      const parts = await apiGet<Record<string, EditedPart>>('/api/library/components')
      const part = parts[id]
      if (!part) throw new Error(`no library part ${id}`)
      const standard = id.startsWith('cmp:Standard ')
      setEditing({ id, version: part.version, standard, template: Boolean(part.template) })
      setName(part.name)
      setLibrary(standard ? 'My parts' : id.replace(/^cmp:/, '').split('/')[0])
      setDescription(part.description)
      setCategory(part.category ?? '')
      setMeta({ ...part.metadata, ...part.ratings })
      if (part.template) {
        setMode('template')
        setTemplateName(part.template.name)
        setForm(part.template.values)
        resetHistory()
      } else {
        setPage('data') // its circuit is a schematic: its data are what can be edited here
      }
      const loaded: Partial<Record<Kind, string>> = {}
      const from: Partial<Record<Kind, string>> = {}
      for (const c of part.characteristics) {
        if (!(KINDS as readonly string[]).includes(c.name)) continue
        loaded[c.name as Kind] = pointsText(c.points as [number, number][])
        if (c.source && c.source !== 'points') from[c.name as Kind] = c.source
      }
      setPoints((p) => ({ ...p, ...loaded }))
      setSources(from)
      const first = KINDS.find((k) => loaded[k])
      if (first) setTab(first)
    } catch (error) {
      toast.error(`Cannot open the part: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // Defaults of the chosen template where the form has nothing yet.
  useEffect(() => {
    if (!template) return
    setForm((f) => {
      const next = { ...f }
      let changed = false
      for (const field of template.fields)
        if (!(field.key in next)) {
          next[field.key] = field.default
          changed = true
        }
      return changed ? next : f
    })
    // A diode: the forward points fit IS, N and RS first (tick CJO, VJ, M with Cj points).
    const first =
      template.kind === 'diode'
        ? new Set(['is', 'n', 'rs'])
        : /MOSFET/i.test(template.name)
          ? new Set(['vto', 'kp', 'rs'])
          : /NPN|PNP/.test(template.name)
            ? new Set(['bf', 'ikf', 'ise', 'ne'])
            : template.library && isOpamp(template.ports)
              ? OPAMP_FIT
              : template.library && isTransformer(template.kind, template.ports)
                ? new Set(['lp', 'n'])
                : isHybrid(template)
                  ? new Set(['beta', 'cpi'])
                  : null
    setFree((s) =>
      s.size
        ? s
        : new Set(template.fields.filter((f) => f.default && (!first || first.has(f.key))).map((f) => f.key)),
    )
    setTab(
      template.kind === 'diode'
        ? 'VF(IF)'
        : /MOSFET/i.test(template.name)
          ? 'Id(Vgs)'
          : /NPN|PNP/.test(template.name)
            ? 'hFE(Ic)'
            : '|Z|(f)',
    )
    if (template.kind === 'inductor') setDrive('i')
  }, [template])

  const shownKinds: readonly Kind[] = useMemo(
    () =>
      mode === 'template' && template?.kind === 'diode'
        ? DIODE.filter(
            (k) =>
              k !== 'VZ(IZ)' || template.fields.some((f) => f.key === 'bv' && /zener/i.test(template.name)),
          )
        : mode === 'template' && template?.kind === 'transistor' && /MOSFET/i.test(template.name)
          ? MOS
          : mode === 'template' && template?.kind === 'transistor' && /NPN|PNP/.test(template.name)
            ? BJT
            : mode === 'template' && template?.library && isOpamp(template.ports)
              ? OPAMP
              : mode === 'template' && template && isHybrid(template)
                ? HYBRID
                : mode === 'template' && template?.library && isTransformer(template.kind, template.ports)
                  ? TRANSFORMER
                  : PASSIVE,
    [mode, template],
  )
  // Drain voltage of the transfer points ("" = Vds = Vgs, as for the threshold).
  const [vds, setVds] = useState('')
  // Conditions of BJT points: Vce of the gain / VBE points, forced beta of the saturation ones.
  const [vce, setVce] = useState('5')
  const [beta, setBeta] = useState('10')
  // The step of an output curve: the gate voltage (MOSFET) or the base current (BJT).
  const [vgsStep, setVgsStep] = useState('10')
  const [ibStep, setIbStep] = useState('1m')
  const chars: Characteristic[] = useMemo(
    () =>
      shownKinds
        .map((kind) => {
          const value = (text: string) => parseValue(text) as number
          const at =
            kind === 'Id(Vgs)' && parseValue(vds) !== null
              ? { at: { Vds: value(vds) } }
              : (kind === 'hFE(Ic)' || kind === 'VBE(Ic)') && parseValue(vce) !== null
                ? { at: { Vce: value(vce) } }
                : kind === 'VCEsat(Ic)' && parseValue(beta) !== null
                  ? { at: { beta: value(beta) } }
                  : kind === 'Id(Vds)' && parseValue(vgsStep) !== null
                    ? { at: { Vgs: value(vgsStep) } }
                    : kind === 'Ic(Vce)' && parseValue(ibStep) !== null
                      ? { at: { Ib: value(ibStep) } }
                      : {}
          return {
            name: kind,
            ...parseWeightedPoints(points[kind]),
            source: sources[kind]?.trim() || 'points',
            ...at,
          }
        })
        .filter((c) => c.points.length > 0),
    [points, shownKinds, vds, vce, beta, vgsStep, ibStep, sources],
  )

  // The model's curves while the form is typed: from the formulas of a built-in template, by
  // simulation for a user template with two pins or a diode / transistor (other parts: none).
  const twoPins = Boolean(template && template.ports.length === 2)
  // Diodes and transistors: datasheet curves from the model, no impedance points to fit.
  const device =
    mode === 'template' &&
    (template?.kind === 'diode' || template?.kind === 'transistor') &&
    !(template && isHybrid(template))
  // Diodes fit their SPICE parameters to datasheet points (by the model's formulas).
  const diodeFit = mode === 'template' && template?.kind === 'diode'
  // MOSFETs fit the level-1 parameters to transfer and on-resistance points.
  const mosFit =
    mode === 'template' && template?.kind === 'transistor' && /MOSFET/i.test(template?.name ?? '')
  const bjtFit =
    mode === 'template' && template?.kind === 'transistor' && /NPN|PNP/.test(template?.name ?? '')
  const semiFit = diodeFit || mosFit || bjtFit
  // Transformers and op-amps: their own curves by simulation (ratio, impedance; gain, swing, step).
  const ports = template?.ports ?? []
  const multiPin =
    mode === 'template' &&
    Boolean(template?.library) &&
    (isOpamp(ports) || isTransformer(template?.kind ?? '', ports) || Boolean(template && isHybrid(template)))
  const charted = twoPins || device || multiPin
  const fitSet = diodeFit
    ? DIODE_FIT
    : mosFit
      ? MOS_FIT
      : bjtFit
        ? BJT_FIT
        : multiPin
          ? isOpamp(ports)
            ? OPAMP_FIT
            : template && isHybrid(template)
              ? HYBRID_FIT
              : TRANSFORMER_FIT
          : null
  useEffect(() => {
    if (mode !== 'template' || !template) return
    if (template.library && !charted) {
      setPreview([])
      return
    }
    const fs = chars.filter((c) => c.name.endsWith('(f)')).flatMap((c) => c.points.map((p) => p[0]))
    const fmin = fs.length ? Math.min(10, Math.min(...fs) / 2) : 10
    const fmax = fs.length ? Math.max(1e9, Math.max(...fs) * 2) : 1e9
    // Built-in passives: from their formulas here, at every keystroke.
    if (!template.library && hasFormulas(template.name)) {
      setPreview(previewCurves(template.name, templateForm(template, form), fmin, fmax) ?? [])
      return
    }
    // The rest by simulation in the backend: after a short pause, the answer to the latest
    // form only (an older one arriving late is dropped).
    const ask = ++previewAsk.current
    const handle = setTimeout(() => {
      const body = { template: template.name, form: templateForm(template, form), fmin, fmax }
      const request = template.library
        ? apiPost<{ curves: CardCurve[] }>('/api/components/templates/card', body).then((c) => c.curves)
        : apiPost<CardCurve[]>('/api/components/templates/preview', body)
      request
        .then((curves) => ask === previewAsk.current && setPreview(curves))
        .catch(() => ask === previewAsk.current && setPreview([]))
    }, 150)
    return () => clearTimeout(handle)
  }, [mode, template, form, chars, charted])

  // The equivalent circuit with the form's values written in.
  useEffect(() => {
    if (mode !== 'template' || !template) return
    const handle = setTimeout(() => {
      apiPost<Circuit>('/api/components/templates/circuit', {
        template: template.name,
        form: templateForm(template, form),
        theme,
      })
        .then((c) => {
          setCircuit(c)
          setCircuitError('')
        })
        .catch((error) => setCircuitError(error instanceof Error ? error.message : String(error)))
    }, 300)
    return () => clearTimeout(handle)
  }, [mode, template, form, theme])

  const sheets = (project?.sheets ?? []).filter(
    (s) => !s.owner && s.labels.filter((l) => l.kind === 'port').length === 2,
  )
  const ownSheet = project?.sheets.find((s) => s.name === sheetName)
  const twoPorts = new Set(ownSheet?.labels.filter((l) => l.kind === 'port').map((l) => l.text)).size === 2

  // The last fit's values, was and is now, until they are kept or anything else changes them.
  const [fitChange, setFitChange] = useState<{
    before: Record<string, string>
    after: Record<string, string>
  } | null>(null)
  useEffect(() => {
    if (fitChange && (!result || Object.entries(fitChange.after).some(([k, v]) => form[k] !== v)))
      setFitChange(null)
  }, [fitChange, form, result])
  // What a fit changes: the ticked fields (for a diode, those its points determine).
  const fitKeys = [...free].filter((k) => !fitSet || fitSet.has(k))
  // `only`: fit to the shown curve alone (some values to some curves, in several passes: an
  // MLCC's ESL to |Z| near resonance, then its ESR to ESR(f)).
  const runFit = async (only?: Kind) => {
    if (!chars.length) {
      toast.error('Enter some characteristic points first')
      return
    }
    setBusy(true)
    // Typed limits, else the template's own range of the field.
    const limits = Object.fromEntries(
      fitKeys.map((k) => {
        const f = fields.find((x) => x.key === k)
        const [lo, hi] = bounds[k] ?? ['', '']
        return [k, [lo.trim() || f?.minimum || '', hi.trim() || f?.maximum || ''] as [string, string]]
      }),
    )
    const usedBounds = Object.fromEntries(Object.entries(limits).filter(([, [lo, hi]]) => lo || hi))
    // "Fit to the selection": points outside a kind's range keep their place, not their say.
    const ranged = chars
      .filter((c) => !only || c.name === only)
      .map((c) => {
        const [lo, hi] = (ranges[c.name as Kind] ?? ['', '']).map((t) => parseValue(t))
        if (lo === null && hi === null) return c
        const weights = c.points.map(([x], i) =>
          (lo !== null && x < lo) || (hi !== null && x > hi) ? 0 : (c.weights?.[i] ?? 1),
        )
        return { ...c, weights }
      })
    try {
      const fitted =
        mode === 'template'
          ? await apiPost<FitResult>('/api/components/templates/fit', {
              template: templateName,
              form: templateForm(template, form),
              free: fitKeys,
              characteristics: ranged,
              bounds: usedBounds,
            })
          : await apiPost<FitResult>('/api/components/fit-sheet', {
              project_id: useProject.getState().info?.id,
              sheet: sheetName,
              start: Object.fromEntries([...free].map((k) => [k, ownSheet?.parameters?.[k] ?? '1'])),
              characteristics: ranged,
              drive,
              bounds: usedBounds,
            })
      setResult(fitted)
      if (mode === 'template') {
        // Only what the fit moved: a value it left alone stays as typed, not marked as fitted.
        const moved = Object.fromEntries(
          Object.entries(fitted.values).filter(([k, v]) => {
            const [was, now] = [parseValue(form[k] ?? ''), parseValue(v)]
            return was === null || now === null ? (form[k] ?? '') !== v : was !== now
          }),
        )
        applyForm(moved, 'fit')
        setFitChange({ before: form, after: moved })
      }
      // The result is under the chart (no message over the charts).
    } catch (error) {
      toast.error(`Cannot fit: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const applyToSheet = async () => {
    if (!result || !ownSheet) return
    await execute({
      type: 'transaction',
      label: 'apply fitted values',
      commands: Object.entries(result.values).map(
        ([key, value]): Command => ({ type: 'set_parameter', sheet: ownSheet.name, name: key, value }),
      ),
    })
    toast.success(`Fitted values set as parameters of sheet ${ownSheet.name}`)
  }

  // `asName`: saved as a new part of that name (version 1), the edited one left as it is.
  const save = async (asName?: string) => {
    const fields = dataFields(fieldsOf(categories, category || automaticCategory))
    const { metadata, ratings } = splitData(meta, fields)
    if (asName && editing && !editing.template) {
      // A part drawn as a schematic: a copy of it, with the data as edited here.
      try {
        const id = await apiPost<string>('/api/library/items/duplicate', { id: editing.id, name: asName })
        await apiPatch('/api/library/components', {
          id,
          description,
          category,
          metadata,
          ratings,
          changes: '',
        })
        await reloadLibrary()
        toast.success(`${asName} saved as a new part`)
        window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
      } catch (error) {
        toast.error(`Cannot save: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (mode === 'spice' && !editing) {
      // A manufacturer's model: imported into the library as a part, the data added to it.
      const item = spiceItem(spiceChoice)
      if (!item) return
      try {
        const report = await apiPost<{ parts?: string[]; skipped: string[] }>('/api/library/import/spice', {
          text: spiceText,
          library: library.trim(),
          items: [item],
        })
        const id = report.parts?.[0]
        if (!id) throw new Error(report.skipped[0] ?? 'the model was not imported')
        await apiPatch('/api/library/components', {
          id,
          description,
          category,
          metadata,
          ratings,
          changes: '',
        })
        await reloadLibrary()
        toast.success(`${item.name} saved in library “${library.trim()}”`, {
          description: "A part with the manufacturer's model: place it from the library.",
        })
        window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
      } catch (error) {
        toast.error(`Cannot save: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (editing && !editing.template && !editing.standard) {
      try {
        await apiPatch('/api/library/components', {
          id: editing.id,
          description,
          category,
          metadata,
          ratings,
          changes,
        })
        await reloadLibrary()
        toast.success(`${name} saved (version ${editing.version + 1})`)
        await offerUpdate(editing.id)
        window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
      } catch (error) {
        toast.error(`Cannot save: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    if (mode === 'sheet') {
      if (!ownSheet) return
      try {
        const savedPart = await apiPost<{ id: string; name: string }>('/api/library/components', {
          project_id: useProject.getState().info?.id,
          sheet: ownSheet.name,
          library: library.trim(),
          name: name.trim() || ownSheet.name,
          kind: kindOfCategory(category) ?? (twoPorts ? (drive === 'i' ? 'inductor' : 'capacitor') : 'other'),
          description: description.trim(),
          metadata,
          ratings,
          characteristics: chars,
          category,
        })
        await reloadLibrary()
        if (init?.replace) {
          // Made from a selection: the saved part goes where its block was.
          const target = init.replace
          const inst = project?.sheets
            .find((s) => s.name === target.sheet)
            ?.instances.find((i) => i.id === target.id)
          if (inst)
            await execute({
              type: 'transaction',
              label: `use ${savedPart.name}`,
              commands: toRealPart(target.sheet, inst, savedPart.id),
            })
        }
        toast.success(`${name.trim() || ownSheet.name} saved in library “${library.trim()}”`, {
          description: init?.replace ? 'It took the place of its block.' : undefined,
        })
        window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
      } catch (error) {
        toast.error(`Cannot save: ${error instanceof Error ? error.message : String(error)}`)
      }
      return
    }
    try {
      const saved = await apiPost<{ id: string; name: string }>('/api/components/from-template', {
        template: templateName,
        form: templateForm(template, form),
        library: library.trim(),
        name: asName ?? name.trim(),
        description: description.trim(),
        metadata,
        ratings,
        characteristics: chars,
        category,
        look,
        changes: asName ? '' : changes,
      })
      await reloadLibrary()
      if (init?.replace) {
        // The part the maker was opened from becomes the new real part (same place and ref).
        const target = init.replace
        const inst = project?.sheets
          .find((s) => s.name === target.sheet)
          ?.instances.find((i) => i.id === target.id)
        if (inst)
          await execute({
            type: 'transaction',
            label: `use ${saved.name}`,
            commands: toRealPart(target.sheet, inst, saved.id),
          })
        toast.success(`${saved.name} saved and placed instead of the ideal part`)
      } else {
        toast.success(`${saved.name} saved in library “${library.trim()}”`, {
          description: 'Place it from the library; double-click it to see its equivalent circuit.',
        })
        if (editing && !editing.standard && !asName) await offerUpdate(saved.id)
      }
      window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))
    } catch (error) {
      toast.error(`Cannot save: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const saveAsNew = async () => {
    const copy = await prompt({ title: 'Save as a new part', label: 'Name', initial: `${name} copy` })
    if (copy?.trim()) await save(copy.trim())
  }

  // The part's circuit as a template: its values the defaults of the form.
  const saveAsTemplate = async () => {
    if (!editing) return
    const named = await prompt({
      title: 'Save as a model',
      label: 'Model name',
      initial: `${name} template`,
    })
    if (!named?.trim()) return
    const where = editing.standard ? 'My templates' : library.trim()
    try {
      await apiPost('/api/library/components/as-template', {
        id: editing.id,
        library: where,
        name: named.trim(),
      })
      await queries.invalidateQueries({ queryKey: ['templates'] })
      toast.success(`Model ${named.trim()} saved in “${where}”`, {
        description: 'New parts from it are in its category; change its circuit with Edit model.',
      })
    } catch (error) {
      toast.error(`Cannot save the template: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** After saving a part the project uses: offer to update the placed ones. */
  const offerUpdate = async (id: string) => {
    const info = useProject.getState().info
    if (!info) return
    const count = await stalePlaced(info.id, id)
    if (count)
      toast(`${count} placed part${count === 1 ? '' : 's'} of the older version in this project`, {
        duration: 15000,
        action: { label: 'Update them', onClick: () => void updatePlaced(info.id, [id]) },
      })
  }

  // A CSV file: its columns chosen in a dialog (units from the headers), then the points.
  const [csvText, setCsvText] = useState<string | null>(null)
  const fromCsv = async (file: File) => setCsvText(await file.text())
  // Measurements (.bptm.json): opened into the characteristics they hold, saved from them.
  const measurementRef = useRef<HTMLInputElement>(null)
  const openMeasurement = async (file: File) => {
    try {
      const m = JSON.parse(await file.text()) as {
        format?: string
        name?: string
        characteristics?: { name: string; points: [number, number][] }[]
      }
      if (m.format !== 'bptm') throw new Error('not a measurement file (.bptm.json)')
      const known = (m.characteristics ?? []).filter((c) => (KINDS as readonly string[]).includes(c.name))
      if (!known.length) throw new Error('none of its characteristics fits this editor')
      setPoints((p) => ({ ...p, ...Object.fromEntries(known.map((c) => [c.name, pointsText(c.points)])) }))
      setSources((s) => ({
        ...s,
        ...Object.fromEntries(known.map((c) => [c.name, `measurement ${m.name ?? file.name}`])),
      }))
      toast.success(`Measured points of ${known.map((c) => c.name).join(', ')} from ${file.name}`)
    } catch (error) {
      toast.error(`Cannot open ${file.name}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  const saveMeasurement = () => {
    const measurement = {
      format: 'bptm',
      version: 1,
      name,
      part: name,
      taken: new Date().toISOString(),
      characteristics: chars.map((c) => ({ ...c, source: 'measurement' })),
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(measurement, null, 2)], { type: 'application/json' }),
    )
    const a = document.createElement('a')
    a.href = url
    a.download = `${(name || 'measurement').replace(/[/:*?"<>|]/g, '_')}.bptm.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  // Tracing a datasheet picture in the chart's place (docs/projekt-modele.md §2): the picture
  // and its calibration stay per characteristic while the part is edited.
  const [tracing, setTracing] = useState(false)
  const [traces, setTraces] = useState<Record<string, TraceState>>({})
  const [traceFile, setTraceFile] = useState<File | null>(null)
  const [pictureShown, setPictureShown] = useState(true) // a traced picture under its chart
  const fromPicture = (file?: File) => {
    setTraceFile(file ?? null)
    setTracing(true)
  }
  /** A picture or a PDF dropped on the chart: traced for the points' characteristic. */
  const dropPicture = (e: React.DragEvent) => {
    const file = e.dataTransfer.files[0]
    if (!file || !(file.type.startsWith('image/') || /\.pdf$/i.test(file.name))) return
    e.preventDefault()
    fromPicture(file)
  }

  // -- dragging on the charts (docs/projekt-kreator.md §6) ---------------------------------------
  // A feature handle or the curve itself: the unlocked values follow, within their limits; one
  // drag is one undo step, Esc puts the values back; the curve before the drag stays in grey.
  const drag = useRef<{
    id: string
    snapshot: Record<string, string>
    start: Values
    anchors?: [number, number][]
  } | null>(null)
  const [ghost, setGhost] = useState<{ chart: string; x: number[]; y: number[] } | null>(null)
  const [moving, setMoving] = useState<string[]>([]) // the values a hovered or dragged handle changes
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [dragText, setDragText] = useState('')
  const builtinPassive =
    mode === 'template' && template !== undefined && !template.library && hasFormulas(template.name)
  const valuesNow = (): Values => {
    if (builtinPassive && template) return passiveNumbers(template.name, templateForm(template, form)) ?? {}
    const out: Values = {}
    for (const [k, v] of Object.entries(form)) {
      const n = parseValue(v)
      if (n !== null) out[k] = n
    }
    return out
  }
  const unitOf = (key: string) => template?.fields.find((f) => f.key === key)?.unit ?? ''
  const limitOf = (key: string): [number | null, number | null] => {
    const f = template?.fields.find((x) => x.key === key)
    const typed = bounds[key] ?? ['', '']
    const pick = (text: string | undefined) => (text?.trim() ? parseValue(text) : null)
    return [pick(typed[0]) ?? pick(f?.minimum), pick(typed[1]) ?? pick(f?.maximum)]
  }
  const curvesByChart = (): Record<string, Curve[]> => {
    const out: Record<string, Curve[]> = {}
    for (const c of preview) out[c.name] = [...(out[c.name] ?? []), { x: c.x, y: c.y }]
    const rds = mosFit ? rdsNow() : null
    if (rds) out['RDS(Vgs)'] = [rds]
    return out
  }
  /** The on-resistance from the values as they are now, over the gate voltages of its points. */
  const rdsNow = (): Curve | null => {
    const v = valuesNow()
    const gates = (chars.find((c) => c.name === 'RDS(Vgs)')?.points ?? []).map(([g]) => g)
    if (!gates.length || !(v.kp > 0)) return null
    const [lo, hi] = [Math.min(...gates), Math.max(...gates)]
    const n = 24
    return rdsCurve(
      v,
      Array.from({ length: n + 1 }, (_x, i) => lo + ((hi - lo) * i) / n),
    )
  }
  const startDrag = (label: string, chart: string) => {
    drag.current = { id: `drag-${label}-${Date.now()}`, snapshot: form, start: valuesNow() }
    const curve = preview.find((c) => c.name === chart)
    setGhost(curve ? { chart, x: curve.x, y: curve.y } : null)
  }
  /** New values from a drag: locked ones left out, each kept within its limits. */
  const dragTo = (update: Values) => {
    const d = drag.current
    if (!d) return
    const text: Record<string, string> = {}
    const changes: string[] = []
    for (const [key, raw] of Object.entries(update)) {
      if (!free.has(key) || !Number.isFinite(raw)) continue
      const [lo, hi] = limitOf(key)
      const value = Math.min(Math.max(raw, lo ?? Number.NEGATIVE_INFINITY), hi ?? Number.POSITIVE_INFINITY)
      const unit = unitOf(key)
      text[key] = toSpice(formatValue(value, unit, 3), unit)
      const label = template?.fields.find((f) => f.key === key)?.label ?? key
      const before = d.start[key]
      changes.push(
        `${label} ${before !== undefined ? `${formatValue(before, unit, 3)} → ` : ''}${formatValue(value, unit, 3)}`,
      )
    }
    if (!Object.keys(text).length) return
    applyForm(text, 'user', d.id)
    setDragText(changes.join(' · '))
  }
  const endDrag = (cancelled: boolean) => {
    const d = drag.current
    drag.current = null
    setGhost(null)
    setMoving([])
    setDragText('')
    if (!d || !cancelled) return
    // Esc: the values from before the drag, and no undo step for it.
    const h = history.current
    if (h.typing === d.id) {
      h.past.pop()
      h.typing = null
    }
    setForm(d.snapshot)
    setSteps((n) => n + 1)
  }
  const handlesFor = (chart: string): ChartHandle[] => {
    if (mode !== 'template' || !template) return []
    const has = (key: string) => Boolean(form[key]?.trim())
    return featureHandles(template.name, valuesNow(), curvesByChart(), has)
      .filter((h) => h.chart === chart)
      .map((h) => {
        const open = h.params.filter((k) => free.has(k))
        const labels = h.params.map((k) => template.fields.find((f) => f.key === k)?.label ?? k)
        return {
          label: h.label,
          x: h.x,
          y: h.y,
          hint: h.hint,
          disabled: open.length ? undefined : `${labels.join(', ')} locked – click the lock to let it move`,
          readout: drag.current?.id.startsWith(`drag-${h.label}-`) ? dragText : undefined,
          onStart: () => startDrag(h.label, chart),
          onDrag: (x, y) => dragTo(h.apply(x, y)),
          onEnd: endDrag,
          onHover: (on) => setMoving(on ? h.params : []),
        }
      })
  }
  /** Pulling the model's curve: live on a built-in passive's formulas; a diode's or transistor's
   *  curve is fitted to the dropped point (and the rest of the curve as it was) when released. */
  const grabFor = (
    chart: string,
  ): ((x: number, y: number, phase: 'start' | 'move' | 'end' | 'cancel') => void) | undefined => {
    if (mode !== 'template' || !template) return undefined
    const keys = template.fields.map((f) => f.key).filter((k) => free.has(k) && (!fitSet || fitSet.has(k)))
    if (!keys.length) return undefined
    if (builtinPassive) {
      return (x, y, phase) => {
        if (phase === 'start') {
          startDrag('curve', chart)
          const d = drag.current
          const curve = preview.find((c) => c.name === chart)
          if (d && curve) {
            const every = Math.max(1, Math.floor(curve.x.length / 14))
            d.anchors = curve.x
              .map((cx, k) => [cx, curve.y[k]] as [number, number])
              .filter((_q, k) => k % every === 0)
          }
          setMoving(keys)
        } else if (phase === 'move') {
          const d = drag.current
          if (!d) return
          const logX = CHART_AXES[chart]?.logX
          const far = (d.anchors ?? []).filter(([ax]) =>
            logX ? Math.abs(Math.log10(ax / x)) > 0.4 : Math.abs(ax - x) > Math.abs(x) * 0.3,
          )
          const pulled = pullCurve(template.name, d.start, chart, [x, y], keys, far, limitOf)
          if (pulled) dragTo(pulled)
        } else endDrag(phase === 'cancel')
      }
    }
    // A user's two-pin model is fitted by simulation: when released, as a transistor's.
    const on = semiFit
      ? ON_CURVE[chart]
      : !device &&
          ((twoPins && SIMULATED_PULL.includes(chart)) || (multiPin && MULTIPORT_PULL.includes(chart)))
        ? { kind: chart as Kind, swap: false }
        : undefined
    const curve = preview.find((c) => c.name === chart)
    if (!on || !curve) return undefined
    return (x, y, phase) => {
      if (phase === 'start') {
        setGhost({ chart, x: curve.x, y: curve.y })
        setMoving(keys)
        return
      }
      if (phase === 'cancel') return endDrag(false)
      if (phase !== 'end') return
      const logX = CHART_AXES[chart]?.logX
      const anchors = curve.x
        .map((cx, i) => [cx, curve.y[i]] as [number, number])
        .filter(
          ([cx, cy], i) =>
            i % Math.max(1, Math.floor(curve.x.length / 12)) === 0 &&
            (cy > 0 || chart === 'Aol(f)') &&
            (logX ? Math.abs(Math.log10(cx / x)) > 0.3 : Math.abs(cx - x) > 0.05 * Math.abs(x || 1)),
        )
      // In the order of x (the fit by simulation sweeps from the first to the last), the dropped
      // point weighing most.
      const weighted = [[x, y, 20] as const, ...anchors.map(([ax, ay]) => [ax, ay, 1] as const)]
        .map(([px, py, w]) => (on.swap ? ([py, px, w] as const) : ([px, py, w] as const)))
        .sort((m, n) => m[0] - n[0])
      const pts = weighted.map(([px, py]) => [px, py] as [number, number])
      const value = (text: string) => parseValue(text) as number
      const at =
        on.kind === 'Id(Vgs)' && parseValue(vds) !== null
          ? { at: { Vds: value(vds) } }
          : (on.kind === 'hFE(Ic)' || on.kind === 'VBE(Ic)') && parseValue(vce) !== null
            ? { at: { Vce: value(vce) } }
            : {}
      void apiPost<FitResult>('/api/components/templates/fit', {
        template: templateName,
        form: templateForm(template, form),
        free: keys,
        characteristics: [
          { name: on.kind, points: pts, weights: weighted.map(([, , w]) => w), source: 'drag', ...at },
        ],
        bounds: {},
      })
        .then((fitted) => {
          const changed = Object.fromEntries(Object.entries(fitted.values).filter(([k]) => keys.includes(k)))
          applyForm(changed, 'user')
          toast.success(`The curve follows the point: ${Object.keys(changed).join(', ')} changed`)
        })
        .catch((error) =>
          toast.error(`Cannot follow the point: ${error instanceof Error ? error.message : String(error)}`),
        )
        .finally(() => endDrag(false))
    }
  }
  const ghostSeries = (chart: string): ChartSeries[] =>
    ghost?.chart === chart ? [{ label: 'before', x: ghost.x, y: ghost.y, color: '', faint: true }] : []

  const help = (() => {
    if (!helpKey || mode !== 'template') return null
    const info = paramInfo(templateName, helpKey)
    if (!info?.chart || !info.region) return null
    const passive = template ? passiveNumbers(template.name, templateForm(template, form)) : null
    const values: Record<string, number> = { ...(passive ?? {}) }
    if (!passive)
      for (const [k, v] of Object.entries(form)) {
        const n = parseValue(v)
        if (n !== null) values[k] = n
      }
    const region = info.region(values)
    return region ? { chart: info.chart, region } : null
  })()
  const highlightOn = (chart: string) => (help?.chart === chart ? help.region : null)

  // The datasheet points on a chart: each one movable (its reading corrected) and switchable
  // (right click: left out of the fit); the fitting range drawn and set with Alt+drag.
  const pointSeries = (kind: Kind, swap = false): ChartSeries | null => {
    const rows = pointRows(points[kind]).filter((r) => !r.error)
    if (!rows.length) return null
    return {
      label: 'points',
      x: rows.map((r) => (swap ? (r.y as number) : (r.x as number))),
      y: rows.map((r) => (swap ? (r.x as number) : (r.y as number))),
      color: CHART_COLORS[1],
      kind: 'points',
      ids: rows.map((r) => r.line),
      weights: rows.map((r) => r.weight),
    }
  }
  const movePoint =
    (kind: Kind, swap = false) =>
    (id: number, x: number, y: number) => {
      const row = pointRows(points[kind]).find((r) => r.line === id)
      if (!row) return
      const [px, py] = swap ? [y, x] : [x, y]
      const round = (v: number) => spiceNumber(Number(v.toPrecision(4)))
      const cols = [round(px), round(py), ...row.cols.slice(2)]
      setPoints((all) => ({ ...all, [kind]: withLine(all[kind], id, cols.join(' ')) }))
    }
  // What a plain mouse does on the charts (docs/projekt-modele.md §3).
  const [chartTool, setChartTool] = useState<'add' | 'range' | null>(null)
  useEffect(() => {
    if (!chartTool) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setChartTool(null)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [chartTool])
  const pointTools = (kind: Kind, swap = false) => ({
    tool: chartTool,
    onPointAdd: (x: number, y: number) => {
      const [px, py] = swap ? [y, x] : [x, y]
      const round = (v: number) => spiceNumber(Number(v.toPrecision(4)))
      setPoints((all) => ({ ...all, [kind]: insertPoint(all[kind], px, `${round(px)} ${round(py)}`) }))
    },
    onPointRemove: (id: number) => setPoints((all) => ({ ...all, [kind]: withLine(all[kind], id, null) })),
  })
  const togglePoint = (kind: Kind) => (id: number) => {
    const row = pointRows(points[kind]).find((r) => r.line === id)
    if (!row) return
    const cols = row.cols.slice(0, 2)
    if (row.weight !== 0) cols.push('0')
    setPoints((all) => ({ ...all, [kind]: withLine(all[kind], id, cols.join(' ')) }))
  }
  const rangeOf = (kind: Kind): [number | null, number | null] => {
    const [a, b] = ranges[kind] ?? ['', '']
    return [a.trim() ? parseValue(a) : null, b.trim() ? parseValue(b) : null]
  }
  const setRangeOf = (kind: Kind) => (r: [number | null, number | null]) => {
    const text = (v: number | null) => (v === null ? '' : spiceNumber(Number(v.toPrecision(3))))
    setRanges({ ...ranges, [kind]: [text(r[0]), text(r[1])] })
    if (chartTool === 'range') setChartTool(null) // selected: the mouse is back to reading the chart
  }

  // The fit's verification under a chart: its residuals (on the chart's x: a device curve drawn
  // as I(V) has its points' voltages there) and the error in words.
  const residualsOf = (fitted: FitCurve | undefined, swap = false): ChartResiduals | undefined =>
    fitted
      ? {
          x: swap ? fitted.measured : fitted.x,
          y: fitted.residuals,
          unit: fitted.name === 'phase(f)' ? '°' : '%',
        }
      : undefined
  const fitNote = (fitted: FitCurve | undefined) => {
    if (!fitted) return null
    const unit = fitted.name === 'phase(f)' ? '°' : ' %'
    const tone =
      fitted.max_error < 3
        ? 'text-emerald-600'
        : fitted.max_error < 10
          ? 'text-amber-600'
          : 'text-destructive'
    return (
      <span className="px-1 text-[11px] text-muted-foreground" data-testid={`residuals-${fitted.name}`}>
        <span className={tone}>
          {fitted.error.toFixed(2)}
          {unit} RMS · worst point {fitted.max_error.toFixed(1)}
          {unit}
        </span>{' '}
        on this curve (residuals under it)
      </span>
    )
  }

  // Charts: model (preview or fitted) vs points, per characteristic that has either.
  const charts = PASSIVE.filter(
    (k) => chars.some((c) => c.name === k) || (mode === 'template' && preview.some((c) => c.name === k)),
  ).map((kind) => {
    const axes = CHART_AXES[kind]
    const series: ChartSeries[] = []
    const model = preview.find((c) => c.name === kind)
    if (mode === 'template' && model)
      series.push({ label: 'model', x: model.x, y: model.y, color: CHART_COLORS[0] })
    const fitted = result?.curves.find((c) => c.name === kind || (diodeFit && c.name === DIODE_ON[kind]))
    if (mode === 'sheet' && fitted)
      series.push({ label: 'fitted', x: fitted.x, y: fitted.model, color: CHART_COLORS[0] })
    const source = chars.find((c) => c.name === kind || c.name === (diodeFit ? DIODE_ON[kind] : undefined))
    const pointsKind = (source?.name ?? kind) as Kind
    const pts = source ? pointSeries(pointsKind) : null
    if (pts) series.push(pts)
    series.push(...ghostSeries(kind))
    const logY = axes.logY && series.every((s) => s.faint || s.y.every((v) => v > 0))
    return {
      name: kind,
      render: (height: number) => (
        <div key={kind} className="flex flex-col">
          <CurveChart
            title={kind}
            series={series}
            handles={chartTool ? undefined : handlesFor(kind)}
            onGrab={chartTool ? undefined : grabFor(kind)}
            grabReadout={dragText}
            xUnit={axes.x}
            yUnit={axes.y}
            logX={axes.logX}
            logY={logY}
            height={height}
            residuals={residualsOf(fitted)}
            highlight={highlightOn(kind)}
            onPointMove={movePoint(pointsKind)}
            onPointToggle={togglePoint(pointsKind)}
            range={rangeOf(pointsKind)}
            onRange={setRangeOf(pointsKind)}
            {...pointTools(pointsKind)}
          />
          {fitNote(fitted)}
        </div>
      ),
    }
  })

  // Datasheet curves of diodes and transistors (no points to type for them).
  const deviceCharts =
    mode === 'template'
      ? [...new Set(preview.map((c) => c.name))]
          .filter((name) => !(PASSIVE as readonly string[]).includes(name))
          .map((name) => {
            const axes = CHART_AXES[name] ?? { logX: false, logY: false, x: '', y: '' }
            const series = curveSeries(
              preview.filter((c) => c.name === name),
              'model',
              CHART_COLORS[0],
            )
            const on = semiFit ? ON_CURVE[name] : undefined
            const kind = on?.kind
            const source = kind && chars.find((c) => c.name === kind)
            // (I, V) points on an I(V) curve: drawn with x and y swapped.
            const pts = source && kind ? pointSeries(kind, on.swap) : null
            if (pts) series.push(pts)
            const fitted = kind ? result?.curves.find((c) => c.name === kind) : undefined
            series.push(...ghostSeries(name))
            return {
              name,
              render: (height: number) => (
                <div key={name} className="flex flex-col">
                  <CurveChart
                    title={name}
                    series={series}
                    handles={chartTool ? undefined : handlesFor(name)}
                    onGrab={chartTool ? undefined : grabFor(name)}
                    xUnit={axes.x}
                    yUnit={axes.y}
                    logX={axes.logX}
                    logY={axes.logY}
                    height={height}
                    residuals={residualsOf(fitted, on?.swap)}
                    highlight={highlightOn(name)}
                    onPointMove={kind ? movePoint(kind, on?.swap) : undefined}
                    onPointToggle={kind ? togglePoint(kind) : undefined}
                    range={kind && !on?.swap ? rangeOf(kind) : undefined}
                    onRange={kind && !on?.swap ? setRangeOf(kind) : undefined}
                    {...(kind ? pointTools(kind, on?.swap) : {})}
                  />
                  {fitNote(fitted)}
                </div>
              ),
            }
          })
      : []

  // On-resistance points have no card curve: the points with the fitted values at them.
  const ownCharts = (['RDS(Vgs)', 'VCEsat(Ic)'] as const).map((kind) => {
    if (!shownKinds.includes(kind)) return null
    const source = chars.find((c) => c.name === kind)
    const fitted = result?.curves.find((c) => c.name === kind)
    if (!source && !fitted) return null
    const axes = CHART_AXES[kind]
    const series: ChartSeries[] = []
    const live = kind === 'RDS(Vgs)' && mosFit ? rdsNow() : null // follows the values as they change
    if (live) series.push({ label: 'model', x: live.x, y: live.y, color: CHART_COLORS[0] })
    else if (fitted) series.push({ label: 'model', x: fitted.x, y: fitted.model, color: CHART_COLORS[0] })
    const own = source ? pointSeries(kind) : null
    if (own) series.push(own)
    return {
      name: kind as string,
      render: (height: number) => (
        <div key={kind} className="flex flex-col">
          <CurveChart
            title={kind}
            series={series}
            handles={chartTool ? undefined : handlesFor(kind)}
            xUnit={axes.x}
            yUnit={axes.y}
            logX={axes.logX}
            height={height}
            residuals={residualsOf(fitted)}
            onPointMove={movePoint(kind)}
            onPointToggle={togglePoint(kind)}
            range={rangeOf(kind)}
            onRange={setRangeOf(kind)}
            {...pointTools(kind)}
          />
          {fitNote(fitted)}
        </div>
      ),
    }
  })

  const fields =
    mode === 'template'
      ? inGroups(template?.fields ?? [])
      : Object.keys(ownSheet?.parameters ?? {}).map(
          (key): TemplateField => ({
            key,
            label: key,
            unit: '',
            default: '',
            description: 'sheet parameter',
            required: false,
          }),
        )

  // What saving still needs: shown by the Save button, a click on one goes to it.
  const missing: { text: string; go: () => void }[] = [
    ...(mode === 'template' && !name.trim()
      ? [{ text: 'Name the part (its part number)', go: () => nameRef.current?.focus() }]
      : []),
    ...(!library.trim() ? [{ text: 'Choose a library', go: () => libraryRef.current?.focus() }] : []),
    ...(mode === 'sheet' && !ownSheet
      ? [{ text: 'Choose the sheet of the circuit', go: () => setPage('model') }]
      : []),
    ...(mode === 'spice' && !spiceItem(spiceChoice)
      ? [{ text: 'Check the SPICE model and give every pin', go: () => setPage('model') }]
      : []),
  ]
  const steps: { label: string; page: Page; done: boolean; current: boolean; problem?: boolean }[] = [
    { label: '① Model', page: 'kind', done: page !== 'kind', current: page === 'kind' },
    {
      label: '② Values & points',
      page: 'model',
      done: chars.length > 0 || Object.keys(origin).length > 0,
      current: page === 'model' && !(result && mode !== 'spice'),
    },
    ...(mode === 'spice'
      ? []
      : [
          {
            label: '③ Fit',
            page: 'model' as Page,
            done: Boolean(result),
            current: page === 'model' && Boolean(result),
          },
        ]),
    { label: '④ Symbol', page: 'symbol', done: visited.has('symbol'), current: page === 'symbol' },
    {
      label: '⑤ Data & save',
      page: 'data',
      done: false,
      current: page === 'data',
      problem: missing.length > 0,
    },
  ]
  const go = (next: Page) => {
    setVisited((v) => new Set(v).add(next))
    setPage(next)
  }
  const hasHelpers =
    (diodeFit && /zener|led/i.test(template?.name ?? '')) ||
    mosFit ||
    bjtFit ||
    (mode === 'template' &&
      (template?.name === 'electrolytic' || ('Cnom' in form && shownKinds.includes('C(V)'))))
  const chartItems = [...deviceCharts, ...ownCharts.filter((c) => c !== null), ...charts]
  const chartNames = chartItems.map((c) => c.name).join('|')
  // One row of tabs (docs/projekt-modele.md §3): a chart and the datasheet points that go on it.
  // Only the characteristics that mean something for the part, unless it has points of another.
  const relevantKinds = shownKinds.filter((k) => {
    if (mode !== 'template' || parsePoints(points[k]).length) return true
    const part = template?.kind
    if (part === 'resistor') return k === '|Z|(f)' || k === 'phase(f)'
    if (k === 'C(V)') return part !== 'inductor'
    if (k === 'L(I)') return part !== 'capacitor'
    return true
  })
  const kindOfChart = (name: string): Kind | undefined => {
    const k = (diodeFit ? DIODE_ON[name] : undefined) ?? (semiFit ? ON_CURVE[name]?.kind : undefined) ?? name
    return relevantKinds.find((r) => r === k)
  }
  const tabItems: { name: string; kind?: Kind; chart?: (typeof chartItems)[number] }[] = [
    ...chartItems.map((chart) => ({ name: chart.name, kind: kindOfChart(chart.name), chart })),
    ...(device && !semiFit
      ? []
      : relevantKinds
          .filter((k) => !chartItems.some((c) => kindOfChart(c.name) === k))
          .map((k) => ({ name: k as string, kind: k }))),
  ]
  const tabNames = tabItems.map((t) => `${t.name}=${t.kind ?? ''}`).join('|')
  // The chart follows the points being worked on, and a parameter's card.
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a change of the points' kind or of the tabs
  useEffect(() => {
    const found = tabItems.find((t) => t.kind === tab)
    if (found) setChartTab(found.name)
  }, [tab, tabNames])
  // biome-ignore lint/correctness/useExhaustiveDependencies: on opening a parameter's card only
  useEffect(() => {
    if (help && chartNames.split('|').includes(help.chart)) setChartTab(help.chart)
  }, [help?.chart])
  const active =
    tabItems.find((t) => t.name === chartTab) ?? tabItems.find((t) => t.kind === tab) ?? tabItems[0]
  const shownChart = active?.chart
  // The charts' tabs in full screen: ‹ › go on from one to the next, as a click on its tab.
  const chartTabsOnly = tabItems.filter((t) => t.chart)
  const chartGroup: ChartGroupValue = {
    full: fullChart,
    setFull: setFullChart,
    step:
      chartTabsOnly.length > 1
        ? (direction) => {
            const n = chartTabsOnly.length
            const at = chartTabsOnly.findIndex((t) => t.name === fullChart)
            const next = chartTabsOnly[(at + direction + n) % n]
            setFullChart(next.name)
            setChartTab(next.name)
            if (next.kind) setTab(next.kind)
            else setChartTool(null)
          }
        : undefined,
    cursors: chartCursors,
    setCursors: (axis, cursors) => setChartCursors((c) => ({ ...c, [axis]: cursors })),
  }
  const dragsRange = active?.kind !== undefined && !(semiFit && ON_CURVE[active.name]?.swap)
  const modelOf = (kind: Kind): { x: number[]; y: number[] }[] => {
    const out: { x: number[]; y: number[] }[] = []
    if (mode === 'template') {
      for (const c of preview) {
        if (c.name === kind) out.push({ x: c.x, y: c.y })
        const on = ON_CURVE[c.name]
        if (on?.kind === kind) out.push(on.swap ? { x: c.y, y: c.x } : { x: c.x, y: c.y })
      }
    }
    const fitted = result?.curves.find((c) => c.name === kind)
    if (fitted && !out.length) out.push({ x: fitted.x, y: fitted.model })
    return out
  }
  const traceAxes = CHART_AXES[tab] ?? { logX: false, logY: false, x: '', y: '' }
  const tracer = (
    <PictureTrace
      kind={tab}
      xUnit={traceAxes.x}
      yUnit={traceAxes.y}
      logX={traceAxes.logX}
      logY={traceAxes.logY}
      swapDefault={tab === 'VF(IF)' || tab === 'VZ(IZ)'}
      points={chars.find((c) => c.name === tab)?.points ?? []}
      onPoints={(got) => setPoints((p) => ({ ...p, [tab]: pointsText(got) }))}
      model={modelOf(tab)}
      state={traces[tab] ?? null}
      onState={(next) =>
        setTraces((all) => {
          const { [tab]: _old, ...rest } = all
          return next ? { ...rest, [tab]: next } : rest
        })
      }
      onDone={() => setTracing(false)}
      height={420}
      file={traceFile}
    />
  )
  // Change the model's circuit (a user template: its next version) or start a new model from it,
  // with the values typed here; the circuit opens as a sheet beside the template editor.
  const ownTemplate = Boolean(template?.library && !template.library.startsWith('Standard'))
  const circuitActions = (onDone?: () => void) =>
    template && (
      <div className="flex flex-wrap gap-1">
        {ownTemplate && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 px-2 text-xs"
            title="Change this model's circuit, form and symbol (saved as its next version)"
            onClick={() => {
              onDone?.()
              void editTemplate(template.name, { fromPart: true })
            }}
          >
            Edit this circuit
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          className="h-6 px-2 text-xs"
          title="A new model from this circuit with the values typed here: change its schematic, then save it"
          onClick={() => {
            onDone?.()
            void editTemplate(template.name, {
              asNew: true,
              form: templateForm(template, form),
              fromPart: true,
            })
          }}
        >
          New model from this circuit
        </Button>
      </div>
    )
  // The tabs of the characteristics (in the editor and beside the enlarged equivalent circuit).
  const chartTabs = (grid: boolean, onlyCharts = false) =>
    tabItems
      .filter((t) => !onlyCharts || t.chart)
      .map((t) => {
        const count = t.kind ? parsePoints(points[t.kind]).length : 0
        const on = !grid && t.name === active?.name
        return (
          <button
            key={t.name}
            type="button"
            role="tab"
            aria-label={t.name}
            aria-selected={on}
            title={t.kind ? `${t.kind}: ${count} datasheet point${count === 1 ? '' : 's'}` : 'From the model'}
            className={`rounded border px-1.5 py-0.5 text-xs ${on ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
            onClick={() => {
              setChartTab(t.name)
              setChartGrid(false)
              if (t.kind) setTab(t.kind)
              else setChartTool(null)
            }}
          >
            {t.name}
            {count ? ` (${count})` : ''}
          </button>
        )
      })
  const shownTemplates = templates.filter((t) => {
    const q = templateQuery.trim().toLowerCase()
    return !q || [t.label, t.kind, t.category ?? '', t.description].some((f) => f.toLowerCase().includes(q))
  })
  const chooseTemplate = (nameOf: string) => {
    setTemplateName(nameOf)
    setForm({})
    resetHistory()
    setFree(new Set())
    setResult(null)
  }
  // A model saved in the model editor, chosen for this part from its bar; the points stay.
  const chooseRef = useRef(chooseTemplate)
  chooseRef.current = chooseTemplate
  useEffect(() => {
    const use = (e: Event) => {
      setMode('template')
      setPage('model')
      chooseRef.current(String((e as CustomEvent).detail))
    }
    window.addEventListener('bpt:use-model', use)
    return () => window.removeEventListener('bpt:use-model', use)
  }, [])
  const kinds: { mode: 'template' | 'sheet' | 'spice'; title: string; text: string }[] = [
    {
      mode: 'template',
      title: 'From a ready model',
      text: 'A form of values (C, ESR, IS…) fitted to the datasheet',
    },
    {
      mode: 'sheet',
      title: 'Own equivalent circuit',
      text: 'A schematic you draw on a sheet of this project',
    },
    {
      mode: 'spice',
      title: "Manufacturer's SPICE model",
      text: 'Paste the .model or .subckt from the datasheet page',
    },
  ]

  return (
    <ChartGroup.Provider value={chartGroup}>
      <div className="flex h-full min-h-0 flex-col bg-background text-sm" data-testid="component-wizard">
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
          <span className="font-medium">
            {editing ? (editing.standard ? 'Copy of a standard part' : 'Edit part') : 'New part'}
          </span>
          <Input
            ref={nameRef}
            aria-label="Part name"
            aria-invalid={mode === 'template' && !name.trim()}
            className={`h-7 w-56 ${mode === 'template' && !name.trim() ? 'border-destructive/70' : ''}`}
            placeholder="Part number from the datasheet"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            ref={libraryRef}
            aria-label="Library"
            className="h-7 w-36"
            placeholder="Library"
            value={library}
            onChange={(e) => setLibrary(e.target.value)}
          />
          <CategorySelect
            category={category}
            automatic={automaticCategory}
            onCategory={setCategory}
            className="max-w-56"
          />
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!history.current.past.length}
            aria-label="Undo"
            title="Undo the last change of the values (Ctrl+Z)"
            onClick={() => undoForm(true)}
          >
            <Undo2 className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            disabled={!history.current.future.length}
            aria-label="Redo"
            title="Redo"
            onClick={() => undoForm(false)}
          >
            <Redo2 className="size-4" />
          </Button>
          <span className="ml-auto flex items-center gap-2">
            <Button
              variant="outline"
              onClick={() => window.dispatchEvent(new CustomEvent('bpt:close-panel', { detail: PANEL }))}
            >
              Close
            </Button>
            {editing && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="icon" aria-label="More ways to save">
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => void saveAsNew()}>Save as a new part…</DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => void saveAsTemplate()}>Save as a model…</DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            <HoverCard openDelay={150}>
              <HoverCardTrigger asChild>
                <span tabIndex={missing.length ? 0 : -1} data-testid="save-wrap">
                  <Button disabled={missing.length > 0} onClick={() => void save()}>
                    {init?.replace && mode === 'template'
                      ? 'Save and use for the part'
                      : editing
                        ? editing.standard
                          ? 'Save a copy in my library'
                          : `Save version ${editing.version + 1}`
                        : 'Save to library'}
                  </Button>
                </span>
              </HoverCardTrigger>
              {missing.length > 0 && (
                <HoverCardContent align="end" className="w-64" data-testid="save-missing">
                  <p className="mb-1 font-medium">Before saving:</p>
                  {missing.map((m) => (
                    <button
                      key={m.text}
                      type="button"
                      className="block w-full rounded px-1 py-0.5 text-left hover:bg-accent"
                      onClick={m.go}
                    >
                      • {m.text}
                    </button>
                  ))}
                </HoverCardContent>
              )}
            </HoverCard>
          </span>
        </div>
        <div
          className="flex items-center gap-1 border-b px-4 py-1.5"
          role="tablist"
          aria-label="Part editor pages"
        >
          {editing
            ? PAGES.filter(([key]) => key !== 'kind').map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={page === key}
                  className={`rounded px-2 py-0.5 text-xs ${page === key ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
                  onClick={() => go(key)}
                >
                  {label}
                </button>
              ))
            : steps.map((step, n) => (
                <span key={step.label} className="flex items-center gap-1">
                  {n > 0 && <span className="h-px w-4 bg-border" />}
                  <button
                    type="button"
                    role="tab"
                    aria-selected={step.current}
                    className={`flex items-center gap-1 rounded px-2 py-0.5 text-xs ${step.current ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                    onClick={() => {
                      go(step.page)
                      if (step.label.startsWith('③'))
                        setTimeout(() => document.getElementById('fit-button')?.focus())
                    }}
                  >
                    {step.label}
                    {step.problem && !step.current ? (
                      <Tip text="Something is missing before saving">
                        <span className="text-amber-600">!</span>
                      </Tip>
                    ) : step.done && !step.current ? (
                      <span className="text-emerald-600">✓</span>
                    ) : null}
                  </button>
                </span>
              ))}
        </div>
        {page === 'kind' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4" data-testid="model-kind">
            <div className="mx-auto flex max-w-3xl flex-col gap-4">
              <p className="font-medium">How is the part modelled?</p>
              <div className="grid gap-2 sm:grid-cols-3">
                {kinds.map((k) => (
                  <button
                    key={k.mode}
                    type="button"
                    aria-pressed={mode === k.mode}
                    className={`flex flex-col gap-1 rounded-lg border p-3 text-left ${mode === k.mode ? 'border-primary ring-1 ring-primary' : 'hover:bg-accent'}`}
                    onClick={() => {
                      setMode(k.mode)
                      setResult(null)
                      setFree(new Set())
                      if (k.mode !== 'template') go('model')
                    }}
                  >
                    <span className="font-medium">{k.title}</span>
                    <span className="text-xs text-muted-foreground">{k.text}</span>
                  </button>
                ))}
              </div>
              {mode === 'template' && (
                <div className="flex flex-col gap-2">
                  <span className="text-xs text-muted-foreground">
                    The model: its equivalent circuit and the values of its form
                  </span>
                  <Input
                    aria-label="Search models"
                    placeholder="Search: MLCC, diode, op-amp…"
                    value={templateQuery}
                    onChange={(e) => setTemplateQuery(e.target.value)}
                  />
                  <select
                    aria-label="Model"
                    className="h-9 rounded-md border bg-background px-2"
                    value={templateName}
                    onChange={(e) => {
                      chooseTemplate(e.target.value)
                      go('model')
                    }}
                  >
                    {byCategory(shownTemplates).map(([group, items]) => (
                      <optgroup key={group} label={group}>
                        {items.map((t) => (
                          <option key={t.name} value={t.name}>
                            {t.label}
                            {t.library && !t.library.startsWith('Standard') ? ` (${t.library})` : ''}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                  {template && (
                    <p className="text-xs text-muted-foreground">
                      {template.label}: {template.description}
                    </p>
                  )}
                  <Button className="self-start" onClick={() => go('model')}>
                    Continue with {template?.label ?? 'it'}
                  </Button>
                </div>
              )}
            </div>
          </div>
        )}
        {page === 'model' && editing && !editing.template && (
          <p className="p-4 text-muted-foreground">
            This part's equivalent circuit is a schematic of its own: place the part, double-click it and
            “Make a copy” to change the circuit. Its data, symbol and versions are edited here.
          </p>
        )}
        {page === 'model' && mode === 'spice' && !editing && (
          <SpiceModelPage
            text={spiceText}
            onText={setSpiceText}
            choice={spiceChoice}
            onChoice={(choice) => {
              setSpiceChoice(choice)
              if (choice) setName(choice.item.name) // the part is named as its model
            }}
          />
        )}
        {page === 'characteristics' && (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {editing ? (
              <ComponentCard subject={{ component: editing.id }} kind={template?.kind ?? 'other'} />
            ) : (
              <p className="text-muted-foreground">
                The model's curves with your points are on the Model page; once saved, the part's card shows
                all its characteristics here.
              </p>
            )}
          </div>
        )}
        {page === 'symbol' && (
          <SymbolPage
            symbol={mode === 'template' && template?.symbol ? symbols.get(template.symbol) : undefined}
            look={look ?? (template?.name === 'electrolytic' ? 'polarized' : '')}
            onLook={setLook}
            partId={editing && !editing.standard ? editing.id : null}
            onRedrawn={(id) => {
              setEditing((e) => (e ? { ...e, version: e.version + 1 } : e))
              void offerUpdate(id)
            }}
          />
        )}
        {page === 'data' && (
          <DataPage
            category={category}
            automatic={automaticCategory}
            description={description}
            onDescription={setDescription}
            data={meta}
            onData={setMeta}
          />
        )}
        {page === 'usage' && (
          <UsagePage
            id={editing?.id ?? null}
            version={editing?.version ?? null}
            changes={changes}
            onChanges={setChanges}
          />
        )}
        <div
          className={`grid min-h-0 flex-1 gap-4 overflow-hidden p-4 ${device && !semiFit ? 'grid-cols-[19rem_1fr]' : pointsOpen ? 'grid-cols-[19rem_minmax(0,1fr)_19rem]' : 'grid-cols-[19rem_minmax(0,1fr)_2.25rem]'} ${page === 'model' && mode !== 'spice' && (!editing || editing.template) ? '' : 'hidden'}`}
        >
          <div className="flex min-h-0 flex-col gap-2 overflow-y-auto pr-1">
            {mode === 'template' ? (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Equivalent circuit</span>
                <select
                  aria-label="Model"
                  className="h-8 rounded-md border bg-background px-2"
                  value={templateName}
                  onChange={(e) => {
                    setTemplateName(e.target.value)
                    setForm({})
                    resetHistory()
                    setFree(new Set())
                    setResult(null)
                  }}
                >
                  {groupByLibrary(templates).map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((t) => (
                        <option key={t.name} value={t.name}>
                          {t.label}
                          {t.library ? ` (${t.kind})` : ''}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <span className="text-[11px] text-muted-foreground">
                  {template?.description}
                  {template?.library &&
                    ` · pins ${template.ports.join(', ')} · version ${template.version ?? 1}`}
                </span>
              </label>
            ) : (
              <>
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">Sheet with two ports</span>
                  <select
                    aria-label="Sheet"
                    className="h-8 rounded-md border bg-background px-2"
                    value={sheetName}
                    onChange={(e) => {
                      setSheetName(e.target.value)
                      setFree(new Set())
                      setResult(null)
                    }}
                  >
                    <option value="">—</option>
                    {sheets.map((s) => (
                      <option key={s.id} value={s.name}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                  <span className="text-[11px] text-muted-foreground">
                    Any circuit between two port labels; its sheet parameters (used as {'{name}'} in values)
                    can be fitted, e.g. a capacitor with several resonances.
                  </span>
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <span className="text-muted-foreground">Measure with</span>
                  <select
                    aria-label="Drive"
                    className="h-7 rounded-md border bg-background px-2"
                    value={drive}
                    onChange={(e) => setDrive(e.target.value as 'v' | 'i')}
                  >
                    <option value="v">voltage (capacitors, most parts)</option>
                    <option value="i">current (inductors)</option>
                  </select>
                </label>
                {ownSheet && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="self-start"
                    onClick={() => editSheetAsTemplate(ownSheet.name)}
                  >
                    Save this sheet as a model…
                  </Button>
                )}
                {ownSheet && !fields.length && (
                  <p className="text-[11px] text-destructive">
                    The sheet has no parameters: add some in the inspector (Block parameters) and use them in
                    values.
                  </p>
                )}
              </>
            )}
            {fields.map((f, i) => {
              const value = mode === 'template' ? (form[f.key] ?? '') : (ownSheet?.parameters?.[f.key] ?? '')
              const heading = f.group && f.group !== fields[i - 1]?.group ? f.group : ''
              const check = value.trim() && f.unit !== undefined ? valueHint(value, f.unit) : null
              const range = [f.minimum && `≥ ${f.minimum}`, f.maximum && `≤ ${f.maximum}`]
                .filter(Boolean)
                .join(', ')
              const fittable = !((device || fitSet) && !fitSet?.has(f.key))
              const fitted = free.has(f.key)
              const limits = bounds[f.key]
              const limitText =
                limits && (limits[0].trim() || limits[1].trim())
                  ? `${limits[0] || '…'} – ${limits[1] || '…'}`
                  : ''
              const atLimit = limits && atBound(value, limits)
              const e24 = ['Ω', 'F', 'H'].includes(f.unit) ? nearestE24(parseValue(value) ?? 0) : null
              const folded = f.group === ADVANCED && !showAdvanced && !moving.includes(f.key)
              const changed = fields.filter(
                (g) => g.group === ADVANCED && (form[g.key] ?? '').trim() !== (g.default ?? '').trim(),
              ).length
              return (
                <div key={f.key} className="flex flex-col gap-0.5" data-testid={`field-${f.key}`}>
                  {heading === ADVANCED ? (
                    <button
                      type="button"
                      className="mt-1 flex items-center gap-1 text-left text-[11px] font-medium text-muted-foreground uppercase hover:text-foreground"
                      aria-expanded={showAdvanced}
                      onClick={() => setShowAdvanced(!showAdvanced)}
                    >
                      {showAdvanced ? (
                        <ChevronDown className="size-3" />
                      ) : (
                        <ChevronRight className="size-3" />
                      )}
                      {ADVANCED}
                      <span className="font-normal normal-case">
                        {changed
                          ? `${changed} changed`
                          : `${fields.filter((g) => g.group === ADVANCED).length}`}
                      </span>
                    </button>
                  ) : (
                    heading && (
                      <span className="mt-1 text-[11px] font-medium text-muted-foreground uppercase">
                        {heading}
                      </span>
                    )
                  )}
                  {!folded && (
                    <>
                      <div className="grid grid-cols-[5.5rem_1fr_1.5rem] items-center gap-1.5">
                        <ParamHelp
                          fieldKey={f.key}
                          label={f.label}
                          unit={f.unit}
                          info={mode === 'template' ? paramInfo(templateName, f.key) : undefined}
                          description={f.description}
                          help={f.help}
                          value={value}
                          origin={origin[f.key] ? ORIGIN[origin[f.key]].title : 'template default'}
                          range={range}
                          limits={limits}
                          onLimits={
                            fittable && (!device || semiFit)
                              ? (pair) => setBounds({ ...bounds, [f.key]: pair })
                              : undefined
                          }
                          e24={
                            mode === 'template' && e24 !== null
                              ? {
                                  text: formatValue(e24, f.unit, 2),
                                  apply: () =>
                                    applyForm(
                                      { [f.key]: toSpice(formatValue(e24, f.unit, 3), f.unit) },
                                      'user',
                                    ),
                                }
                              : null
                          }
                          onOpenChange={(open) => setHelpKey((k) => (open ? f.key : k === f.key ? null : k))}
                        >
                          <span
                            className={`size-1.5 shrink-0 rounded-full ${origin[f.key] ? ORIGIN[origin[f.key]].color : 'bg-muted-foreground/30'}`}
                            data-testid={`origin-${f.key}`}
                            data-origin={origin[f.key] ?? 'default'}
                          />
                          <span
                            className={`truncate ${helpKey === f.key ? 'text-foreground' : ''} ${moving.includes(f.key) ? 'font-medium text-amber-600 dark:text-amber-400' : ''}`}
                          >
                            {f.label}
                          </span>
                        </ParamHelp>
                        {mode === 'template' ? (
                          <div className="flex min-w-0 items-center gap-1">
                            <Input
                              aria-label={f.label}
                              className={`h-7 min-w-0 font-mono ${check && !check.ok ? 'border-destructive' : ''} ${atLimit ? 'text-amber-600 dark:text-amber-400' : ''}`}
                              placeholder={f.required ? 'required' : 'none'}
                              value={value}
                              onChange={(e) => {
                                applyForm({ [f.key]: e.target.value }, 'user', f.key)
                                // A value typed by hand is the user's: the fit leaves it (unlock to fit it).
                                if (fitted) {
                                  const next = new Set(free)
                                  next.delete(f.key)
                                  setFree(next)
                                }
                              }}
                            />
                            {f.unit && (
                              <span className="w-5 shrink-0 text-[11px] text-muted-foreground">{f.unit}</span>
                            )}
                          </div>
                        ) : (
                          <span className="font-mono text-xs">
                            {value}
                            {result?.values[f.key] && (
                              <span className="text-emerald-600"> → {result.values[f.key]}</span>
                            )}
                          </span>
                        )}
                        {fittable ? (
                          <Tip
                            text={
                              fitted
                                ? 'Fitted: the fit and dragging may change it – click to lock it'
                                : 'Locked: the fit and dragging keep this value – click to let the fit change it'
                            }
                          >
                            {/* biome-ignore lint/a11y/useSemanticElements: a lock icon that reads as the "Fit" checkbox it replaces */}
                            <button
                              type="button"
                              role="checkbox"
                              aria-checked={fitted}
                              aria-label={`Fit ${f.label}`}
                              className={`flex size-6 items-center justify-center rounded hover:bg-accent ${fitted ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}
                              onClick={() => {
                                const next = new Set(free)
                                if (fitted) next.delete(f.key)
                                else next.add(f.key)
                                setFree(next)
                              }}
                            >
                              {fitted ? <LockOpen className="size-3.5" /> : <Lock className="size-3.5" />}
                            </button>
                          </Tip>
                        ) : (
                          <span />
                        )}
                      </div>
                      {limitText && (
                        <Tip
                          text={
                            atLimit
                              ? 'The fit stopped at a limit: widen it if the curve does not follow the points'
                              : 'Limits of the fit'
                          }
                        >
                          <span
                            className={`ml-[6rem] text-[10px] ${atLimit ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
                          >
                            fit within {limitText}
                            {atLimit ? ' – at the limit' : ''}
                          </span>
                        </Tip>
                      )}
                    </>
                  )}
                </div>
              )
            })}
            {mode === 'template' && (circuit || circuitError) && (
              <div className="mt-2 flex flex-col gap-1">
                <span className="flex items-center text-xs font-medium text-muted-foreground uppercase">
                  Equivalent circuit
                  <button
                    type="button"
                    className="ml-auto rounded p-0.5 hover:text-foreground"
                    aria-label="Enlarge the equivalent circuit"
                    onClick={() => setCircuitBig(true)}
                  >
                    <Maximize2 className="size-3.5" />
                  </button>
                </span>
                {circuitError ? (
                  <p className="text-xs text-destructive">{circuitError}</p>
                ) : (
                  circuit && (
                    <button
                      type="button"
                      data-testid="template-circuit"
                      title="Click to enlarge"
                      className="overflow-hidden rounded border bg-background [&>svg]:h-auto [&>svg]:max-h-40 [&>svg]:w-full"
                      onClick={() => setCircuitBig(true)}
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG drawn by the backend from the sheet
                      dangerouslySetInnerHTML={{ __html: circuit.svg }}
                    />
                  )
                )}
                {circuitActions()}
              </div>
            )}
          </div>
          {/* biome-ignore lint/a11y/noStaticElementInteractions: a picture dropped on the chart (also offered by its buttons) */}
          <div
            className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto"
            onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
            onDrop={dropPicture}
          >
            {mode === 'template' && template && !charted && (
              <p className="text-xs text-muted-foreground">
                This part has {template.ports.length} pins ({template.ports.join(', ')}): characteristics are
                computed for two-pin parts, diodes, transistors, transformers and op-amps. Place the component
                and simulate it in a circuit.
              </p>
            )}
            {tracing ? (
              tracer
            ) : tabItems.length ? (
              <>
                <div className="flex flex-wrap items-center gap-1">
                  <div
                    className="flex flex-wrap items-center gap-1"
                    role="tablist"
                    aria-label="Characteristics"
                  >
                    {chartTabs(chartGrid)}
                  </div>
                  <span className="ml-auto flex flex-wrap items-center gap-1">
                    {active?.kind && shownChart && !chartGrid && (
                      <>
                        <button
                          type="button"
                          aria-pressed={chartTool === 'add'}
                          className={`rounded border px-1.5 py-0.5 text-xs ${chartTool === 'add' ? 'border-primary bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                          title="Click the chart to add a datasheet point; right-click removes one"
                          onClick={() => setChartTool(chartTool === 'add' ? null : 'add')}
                        >
                          + Add points
                        </button>
                        <button
                          type="button"
                          aria-pressed={chartTool === 'range'}
                          className={`rounded border px-1.5 py-0.5 text-xs ${chartTool === 'range' ? 'border-primary bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                          title="Fit to a part of the curve only: the points outside stay, without a say"
                          onClick={() => setChartTool(chartTool === 'range' ? null : 'range')}
                        >
                          Fit range
                        </button>
                      </>
                    )}
                    {active?.kind && traces[active.kind] && (
                      <button
                        type="button"
                        aria-pressed={pictureShown}
                        className={`rounded border px-1.5 py-0.5 text-xs ${pictureShown ? 'bg-accent font-medium' : 'text-muted-foreground hover:text-foreground'}`}
                        title="The datasheet's picture under the chart"
                        onClick={() => setPictureShown(!pictureShown)}
                      >
                        Picture
                      </button>
                    )}
                    {active?.kind && (
                      <button
                        type="button"
                        className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                        title={`Trace the ${tab} chart from a datasheet picture (or drop a picture or a PDF on the chart)`}
                        onClick={() => fromPicture()}
                      >
                        Trace a picture…
                      </button>
                    )}
                    {chartItems.length > 1 && (
                      <button
                        type="button"
                        className={`rounded border px-1.5 py-0.5 text-xs ${chartGrid ? 'bg-accent' : 'text-muted-foreground'}`}
                        aria-pressed={chartGrid}
                        aria-label="All charts at once"
                        title="All charts at once, side by side"
                        onClick={() => setChartGrid(!chartGrid)}
                      >
                        ▦
                      </button>
                    )}
                  </span>
                </div>
                {chartTool && (
                  <p className="text-xs text-amber-600 dark:text-amber-400" data-testid="chart-tool-hint">
                    {chartTool === 'add'
                      ? `Click the chart to add a point of ${tab}, drag a point to move it, right-click removes it. Esc: done.`
                      : dragsRange
                        ? 'Drag across the chart: only the points inside it are fitted. Esc: cancel.'
                        : `Type the range of ${tab} to fit (this chart has its axes the other way round).`}
                  </p>
                )}
                {active?.kind && (chartTool === 'range' || ranges[active.kind]?.some((v) => v.trim())) && (
                  <div
                    className="flex items-center gap-1 text-xs text-muted-foreground"
                    data-testid="fit-range"
                  >
                    <span>Fit only from</span>
                    {(['from', 'to'] as const).map((side, k) => (
                      <Input
                        key={side}
                        aria-label={`Fit range ${side}`}
                        className="h-6 w-20 font-mono text-xs"
                        placeholder={k ? 'last' : 'first'}
                        value={ranges[tab]?.[k] ?? ''}
                        onChange={(e) => {
                          const pair: [string, string] = [...(ranges[tab] ?? ['', ''])] as [string, string]
                          pair[k] = e.target.value
                          setRanges({ ...ranges, [tab]: pair })
                        }}
                      />
                    ))}
                    <span>{CHART_AXES[tab]?.x}</span>
                    <button
                      type="button"
                      className="rounded px-1 hover:text-foreground"
                      aria-label="All the points: no fit range"
                      onClick={() => {
                        setRanges({ ...ranges, [tab]: ['', ''] })
                        setChartTool(null)
                      }}
                    >
                      ✕
                    </button>
                  </div>
                )}
                <div className={chartGrid ? 'grid gap-3 xl:grid-cols-2' : ''} data-testid="wizard-charts">
                  {chartGrid ? (
                    chartItems.map((c) => <Fragment key={c.name}>{c.render(210)}</Fragment>)
                  ) : shownChart ? (
                    shownChart.render(fitChange ? 250 : 360)
                  ) : (
                    <div
                      className="flex h-60 flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 text-center text-sm text-muted-foreground"
                      data-testid="chart-empty"
                    >
                      <p>
                        {active?.name} has no curve yet: it appears with its first points. Type them in the
                        table on the right or trace them from the datasheet.
                      </p>
                      <Button size="sm" variant="outline" onClick={() => fromPicture()}>
                        Trace a datasheet picture…
                      </Button>
                    </div>
                  )}
                </div>
                {!chartGrid && active?.kind && traces[active.kind] && pictureShown && (
                  <button
                    type="button"
                    className="mt-1 block w-full rounded border p-1 hover:bg-accent"
                    title="Back to tracing this picture"
                    onClick={() => fromPicture()}
                    data-testid="chart-picture"
                  >
                    <img
                      src={traces[active.kind].picture.image}
                      alt={`The datasheet's ${active.kind} chart`}
                      className="mx-auto max-h-64 object-contain"
                    />
                  </button>
                )}
                {active?.kind && !chars.some((c) => c.name === active.kind) && !result && (
                  <p className="text-xs text-muted-foreground" data-testid="points-guide">
                    <b>1.</b> Add the datasheet's {active.kind} points: on the chart (+ Add points), from its
                    picture (Trace a picture…) or in the table. <b>2.</b> Fit: the values below follow the
                    points.
                  </p>
                )}
              </>
            ) : (
              <p className="text-muted-foreground">
                Characteristics appear here as the form or the points are filled in.
              </p>
            )}
            {!(device && !semiFit) && fields.some((f) => !fitSet || fitSet.has(f.key)) && (
              <div className="flex flex-wrap items-center gap-1 text-xs" data-testid="fit-choice">
                <span className="text-muted-foreground">The fit may change:</span>
                {fields
                  .filter((f) => !fitSet || fitSet.has(f.key))
                  .map((f) => (
                    <button
                      key={f.key}
                      type="button"
                      aria-pressed={free.has(f.key)}
                      aria-label={`${f.label || f.key}: changed by the fit`}
                      title={
                        free.has(f.key)
                          ? 'The fit may change this value: click to keep it as it is'
                          : 'Kept as it is: click to let the fit change it'
                      }
                      className={`rounded-full border px-2 py-0.5 ${free.has(f.key) ? 'border-emerald-600 bg-emerald-600/15 font-medium' : 'text-muted-foreground line-through'}`}
                      onClick={() => {
                        const next = new Set(free)
                        if (free.has(f.key)) next.delete(f.key)
                        else next.add(f.key)
                        setFree(next)
                      }}
                    >
                      {f.label || f.key}
                    </button>
                  ))}
              </div>
            )}
            {!(device && !semiFit) && (
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  id="fit-button"
                  disabled={
                    busy ||
                    !fitKeys.length ||
                    !chars.length ||
                    (mode === 'sheet' && !ownSheet) ||
                    (mode === 'template' && !twoPins && !semiFit && !multiPin)
                  }
                  title={
                    !chars.length
                      ? 'Enter points from the datasheet first (on the right)'
                      : mode === 'template' && !twoPins && !semiFit && !multiPin
                        ? 'Fitting to characteristics needs a two-pin part'
                        : 'The unlocked values (🔓) are fitted to the points'
                  }
                  onClick={() => void runFit()}
                >
                  {busy
                    ? 'Fitting…'
                    : `Fit ${fitKeys.length} value${fitKeys.length === 1 ? '' : 's'} to the points`}
                </Button>
                {chars.length > 1 && chars.some((c) => c.name === tab) && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !fitKeys.length}
                    title="The chosen values to this curve alone; the other curves are left out of this pass"
                    onClick={() => void runFit(tab)}
                  >
                    Fit to {tab} only
                  </Button>
                )}
                {result && (
                  <span className="text-xs" data-testid="fit-result">
                    Fitted in {result.iterations} steps:{' '}
                    <b
                      className={
                        result.max_error < 3
                          ? 'text-emerald-600'
                          : result.max_error < 10
                            ? 'text-amber-600'
                            : 'text-destructive'
                      }
                    >
                      {result.error.toFixed(2)} % RMS, worst point {result.max_error.toFixed(1)} %
                    </b>
                    {mode === 'sheet' && (
                      <Button
                        size="sm"
                        variant="link"
                        className="h-auto px-1"
                        onClick={() => void applyToSheet()}
                      >
                        Apply to the sheet
                      </Button>
                    )}
                  </span>
                )}
              </div>
            )}
            {fitChange && (
              <div
                ref={(el) => el?.scrollIntoView({ block: 'nearest' })}
                className="flex flex-wrap items-start gap-3 rounded-md border p-2 text-xs"
                data-testid="fit-change"
              >
                {!Object.keys(fitChange.after).length && (
                  <p className="text-muted-foreground">
                    The fit changed no value: these already suit the points, or the chosen values cannot
                    improve them.
                  </p>
                )}
                <table className="w-fit border-separate border-spacing-x-3 font-mono">
                  <thead className="text-left font-sans text-muted-foreground">
                    <tr>
                      <th className="font-normal">Value</th>
                      <th className="font-normal">was</th>
                      <th className="font-normal">is now</th>
                      <th className="font-normal">change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(fitChange.after).map(([key, now]) => {
                      const f = fields.find((x) => x.key === key)
                      const was = fitChange.before[key] ?? ''
                      const [a, b] = [parseValue(was), parseValue(now)]
                      const text = (v: number | null, raw: string) =>
                        v === null ? raw || '–' : formatValue(v, f?.unit ?? '', 4)
                      return (
                        <tr key={key}>
                          <td className="font-sans">{f?.label || key}</td>
                          <td>{text(a, was)}</td>
                          <td>{text(b, now)}</td>
                          <td>
                            {a && b !== null
                              ? `${(100 * (b - a)) / a > 0 ? '+' : ''}${((100 * (b - a)) / a).toFixed(1)} %`
                              : ''}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
                <span className="ml-auto flex gap-1">
                  <Button size="sm" className="h-6 px-2 text-xs" onClick={() => setFitChange(null)}>
                    Keep
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-xs"
                    title="Back to the values before this fit"
                    onClick={() => {
                      undoForm(true)
                      setResult(null)
                      setFitChange(null)
                    }}
                  >
                    Undo the fit
                  </Button>
                </span>
              </div>
            )}
            {mode === 'template' && template?.main && (
              <p className="text-[11px] text-muted-foreground">
                Main value {template.fields.find((f) => f.key === template.main)?.label}{' '}
                {form[template.main] ? formatMain(form[template.main], template) : '—'}. Each placed part can
                override the values (they are parameters of its equivalent circuit).
              </p>
            )}
          </div>
          {!(device && !semiFit) &&
            (pointsOpen ? (
              <div className="flex min-h-0 flex-col gap-2 overflow-y-auto" data-testid="points-panel">
                <span className="flex items-center text-xs font-medium text-muted-foreground uppercase">
                  Points from the datasheet
                  <button
                    type="button"
                    className="ml-auto rounded px-1 hover:text-foreground"
                    aria-label="Hide the points"
                    title="Hide the points: more room for the chart"
                    onClick={() => setPointsOpen(false)}
                  >
                    ›
                  </button>
                </span>
                {!active?.kind && (
                  <p className="text-xs text-muted-foreground" data-testid="points-none">
                    {active?.name} comes from the model alone: no datasheet points are fitted to it. Choose a
                    characteristic with points in the tabs above the chart.
                  </p>
                )}
                <div className={active?.kind ? 'contents' : 'hidden'}>
                  <span className="text-xs font-medium" data-testid="points-kind">
                    {tab}
                  </span>
                  {(tab === 'hFE(Ic)' || tab === 'VBE(Ic)') && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span>at Vce</span>
                      <Input
                        aria-label="Vce of the points"
                        className="h-6 w-16 font-mono text-xs"
                        value={vce}
                        onChange={(e) => setVce(e.target.value)}
                      />
                      <span>V</span>
                    </div>
                  )}
                  {tab === 'VCEsat(Ic)' && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span>forced β = Ic / Ib</span>
                      <Input
                        aria-label="Forced beta of the points"
                        className="h-6 w-16 font-mono text-xs"
                        value={beta}
                        onChange={(e) => setBeta(e.target.value)}
                      />
                    </div>
                  )}
                  {(tab === 'Id(Vds)' || tab === 'Ic(Vce)') && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span>{tab === 'Id(Vds)' ? 'at Vgs' : 'at Ib'}</span>
                      <Input
                        aria-label={
                          tab === 'Id(Vds)' ? 'Vgs of the output points' : 'Ib of the output points'
                        }
                        className="h-6 w-20 font-mono text-xs"
                        value={tab === 'Id(Vds)' ? vgsStep : ibStep}
                        onChange={(e) => (tab === 'Id(Vds)' ? setVgsStep : setIbStep)(e.target.value)}
                      />
                      <span>
                        {tab === 'Id(Vds)' ? 'V' : 'A'} (one curve of the datasheet's output family; its slope
                        sets {tab === 'Id(Vds)' ? 'λ' : 'VAF'})
                      </span>
                    </div>
                  )}
                  {tab === 'Id(Vgs)' && (
                    <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
                      <span>at Vds</span>
                      <Input
                        aria-label="Vds of the transfer points"
                        className="h-6 w-20 font-mono text-xs"
                        placeholder="= Vgs"
                        value={vds}
                        onChange={(e) => setVds(e.target.value)}
                      />
                      <span>V (empty: Vds = Vgs, as for the threshold)</span>
                    </div>
                  )}
                  <PointsEditor
                    kind={tab}
                    text={points[tab]}
                    onText={(text) => setPoints({ ...points, [tab]: text })}
                    columns={AXIS_HINT[tab].split(/\s{2,}/) as [string, string]}
                    view={pointsView}
                    onView={choosePointsView}
                    onPicture={() => void fromPicture()}
                    onCsv={() => csvRef.current?.click()}
                  />
                  <Input
                    aria-label={`Where the ${tab} points come from`}
                    className="h-7 text-xs"
                    placeholder="Source: e.g. Vishay 1N4148 Fig. 2, 25 °C"
                    value={sources[tab] ?? ''}
                    onChange={(e) => setSources({ ...sources, [tab]: e.target.value })}
                  />
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="outline" onClick={() => fromPicture()}>
                      Trace a picture…
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => csvRef.current?.click()}>
                      Import CSV…
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => measurementRef.current?.click()}>
                      Open measurement…
                    </Button>
                    <Button size="sm" variant="outline" disabled={!chars.length} onClick={saveMeasurement}>
                      Save as measurement…
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!points[tab]}
                      onClick={() => setPoints({ ...points, [tab]: '' })}
                    >
                      Clear
                    </Button>
                  </div>
                  <input
                    ref={measurementRef}
                    type="file"
                    accept=".json"
                    aria-label="Measurement file"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void openMeasurement(file)
                      e.target.value = ''
                    }}
                  />
                  <CsvImport
                    text={csvText}
                    kind={tab}
                    onClose={() => setCsvText(null)}
                    onPoints={(got, notes) => {
                      setPoints((p) => ({ ...p, [tab]: pointsText(got) }))
                      if (notes.length) toast.info(notes.join('; '))
                    }}
                  />
                  <input
                    ref={csvRef}
                    type="file"
                    aria-label="CSV file"
                    accept=".csv,.txt,.tsv"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0]
                      if (file) void fromCsv(file)
                      e.target.value = ''
                    }}
                  />
                  {hasHelpers && (
                    <span className="mt-2 text-xs font-medium text-muted-foreground uppercase">
                      Values from the datasheet
                    </span>
                  )}
                  {diodeFit && /zener/i.test(template?.name ?? '') && (
                    <ZenerValues
                      n={Number(form.n) || 1}
                      remember={templateName}
                      onApply={(v) => applyForm(v, 'datasheet')}
                    />
                  )}
                  {mosFit && (
                    <MosfetValues remember={templateName} onApply={(v) => applyForm(v, 'datasheet')} />
                  )}
                  {mosFit && (
                    <GateChargeValues remember={templateName} onApply={(v) => applyForm(v, 'datasheet')} />
                  )}
                  {bjtFit && <BjtValues remember={templateName} onApply={(v) => applyForm(v, 'datasheet')} />}
                  {mode === 'template' && template?.name === 'electrolytic' && (
                    <ElectrolyticValues
                      cnom={form.Cnom ?? ''}
                      remember={templateName}
                      onApply={(v) => applyForm(v, 'datasheet')}
                    />
                  )}
                  {mode === 'template' && 'Cnom' in form && shownKinds.includes('C(V)') && (
                    <HelperCard title="DC bias curve in ΔC %" testid="percent-values" remember={templateName}>
                      <span className="text-[11px] text-muted-foreground">
                        Datasheets plot the DC bias as ΔC % (−20 = 20 % less than C): type the percentages as
                        the C(V) points, then turn them into farads of C.
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 self-start px-2 text-xs"
                        disabled={!points['C(V)'].trim()}
                        onClick={() => {
                          const c = parseValue(form.Cnom ?? '')
                          if (!c) {
                            toast.error('Give C first: the percentages are of it')
                            return
                          }
                          setPoints({ ...points, 'C(V)': percentToFarads(points['C(V)'], c) })
                          setTab('C(V)')
                        }}
                      >
                        ΔC % → F
                      </Button>
                    </HelperCard>
                  )}
                  {diodeFit && /led/i.test(template?.name ?? '') && (
                    <HelperCard title="LED from its colour" testid="led-values" remember={templateName}>
                      <span className="text-[11px] text-muted-foreground">
                        Typical values at 20 mA; fit to the datasheet's VF(IF) points after.
                      </span>
                      <select
                        aria-label="LED colour"
                        className="h-7 rounded-md border bg-background px-1 text-xs"
                        value={meta.color ?? ''}
                        onChange={(e) => {
                          const preset = LED_COLORS[e.target.value]
                          setMeta({ ...meta, color: e.target.value })
                          if (!preset) return
                          // IS so that the LED drops vf at 20 mA with this N and RS.
                          const is = 0.02 / Math.expm1((preset.vf - 0.02 * preset.rs) / (preset.n * VT))
                          applyForm(
                            { is: is.toPrecision(3), n: String(preset.n), rs: String(preset.rs) },
                            'datasheet',
                          )
                        }}
                      >
                        <option value="">—</option>
                        {Object.entries(LED_COLORS).map(([name, p]) => (
                          <option key={name} value={name}>
                            {name} ({p.vf} V at 20 mA)
                          </option>
                        ))}
                      </select>
                    </HelperCard>
                  )}
                </div>
              </div>
            ) : (
              <button
                type="button"
                className="flex min-h-0 flex-col items-center gap-2 rounded border py-2 text-xs text-muted-foreground hover:bg-accent [writing-mode:vertical-rl]"
                aria-label="Show the points"
                onClick={() => setPointsOpen(true)}
              >
                + Points from the datasheet
                {chars.length ? ` (${chars.length})` : ''}
              </button>
            ))}
        </div>
        {circuitBig && circuit && (
          <Dialog open onOpenChange={setCircuitBig}>
            <DialogContent className="sm:max-w-[min(96vw,1400px)]">
              <DialogHeader>
                <DialogTitle>Equivalent circuit – {template?.label}</DialogTitle>
              </DialogHeader>
              <div className={`grid gap-4 ${chartItems.length ? 'lg:grid-cols-2' : ''}`}>
                <div className="flex min-w-0 flex-col gap-1">
                  <div
                    data-testid="circuit-big"
                    className="max-h-[70vh] overflow-auto rounded border bg-background [&>svg]:h-auto [&>svg]:max-h-[68vh] [&>svg]:w-full"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG drawn by the backend from the sheet
                    dangerouslySetInnerHTML={{ __html: circuit.svg }}
                  />
                  <p className="text-xs text-muted-foreground">
                    Parts are named by the field that sets them, with its value; the circuit follows the form
                    as you type.
                  </p>
                  {circuitActions(() => setCircuitBig(false))}
                </div>
                {chartItems.length > 0 && (
                  <div className="flex min-w-0 flex-col gap-2" data-testid="circuit-charts">
                    <div
                      className="flex flex-wrap items-center gap-1"
                      role="tablist"
                      aria-label="Characteristics"
                    >
                      {chartTabs(false, true)}
                    </div>
                    {/* The chart over the one in the editor: its view, cursors and full screen its own. */}
                    <ChartGroup.Provider value={null}>{shownChart?.render(380)}</ChartGroup.Provider>
                  </div>
                )}
              </div>
            </DialogContent>
          </Dialog>
        )}
      </div>
    </ChartGroup.Provider>
  )
}

/** Templates under their categories (where the library offers them), in the categories' order. */
function byCategory(templates: TemplateInfo[]): [string, TemplateInfo[]][] {
  const groups = new Map<string, TemplateInfo[]>()
  for (const t of templates) {
    const group = (t.category || 'Other').split('/')[0]
    groups.set(group, [...(groups.get(group) ?? []), t])
  }
  return [...groups.entries()]
}

/** A component kind from a category path (where the library lists the part). */
function kindOfCategory(path: string): string | null {
  const top = path.split('/')[0]
  const kinds: Record<string, string> = {
    Resistors: 'resistor',
    Capacitors: 'capacitor',
    'Inductors & transformers': path.includes('Transformers') ? 'transformer' : 'inductor',
    Diodes: 'diode',
    Transistors: 'transistor',
    'Analog ICs': 'ic',
    Digital: 'ic',
    Power: path.includes('modules') ? 'module' : 'ic',
  }
  return path ? (kinds[top] ?? 'other') : null
}

/** The form as the backend takes it: the template's fields only, empty ones left out. */
function templateForm(
  template: TemplateInfo | undefined,
  form: Record<string, string>,
): Record<string, string> {
  if (!template) return {}
  return Object.fromEntries(
    template.fields.map((f) => [f.key, (form[f.key] ?? '').trim()]).filter(([, v]) => v),
  )
}

function formatMain(text: string, template: TemplateInfo): string {
  const unit = template.fields.find((f) => f.key === template.main)?.unit ?? ''
  const hint = valueHint(text, unit)
  return hint.ok ? hint.hint : text
}

const ADVANCED = 'Advanced'

/** A form's fields heading by heading, in the order the headings first come; Advanced last. */
export function inGroups<T extends { group?: string }>(fields: T[]): T[] {
  const groups = [...new Set(fields.map((f) => f.group ?? ''))]
  const ordered = [...groups.filter((g) => g !== ADVANCED), ...groups.filter((g) => g === ADVANCED)]
  return ordered.flatMap((g) => fields.filter((f) => (f.group ?? '') === g))
}

/** Built-in templates first, then one group per library. */
function groupByLibrary(templates: TemplateInfo[]): [string, TemplateInfo[]][] {
  const groups = new Map<string, TemplateInfo[]>()
  for (const t of templates) {
    const group = t.library || 'Built-in'
    groups.set(group, [...(groups.get(group) ?? []), t])
  }
  return [...groups.entries()]
}
