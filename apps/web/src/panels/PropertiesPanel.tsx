/**
 * Inspector: properties of the selection (Altium / Blender style), project parameters when
 * nothing is selected. Values are validated as they are typed (4k7 = 4.7 kΩ).
 */
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, Plus, Tag, X } from 'lucide-react'
import { Fragment, type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/api/client'
import type {
  Command,
  Directive,
  Instance,
  Label,
  PortSide,
  Rotation,
  SubcktModel,
  SymbolDef,
  TextField,
} from '@/api/types'
import { withVariant } from '@/api/types'
import { openComponentWizard, type TemplateInfo } from '@/components/ComponentWizard'
import { ParamHelp } from '@/components/ParamHelp'
import { type CheckedModel, PasteModel } from '@/components/PasteModel'
import { SymbolPreview } from '@/components/SymbolPreview'
import { TransferPlot } from '@/components/TransferPlot'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { activeEditor } from '@/editor/controller'
import { pinPositions, placeOf, textSpot, valueText } from '@/editor/geometry'
import { t } from '@/lib/i18n'
import { restoreDrawing } from '@/lib/looks'
import { paramInfo, primitiveInfo, spiceParamInfo } from '@/lib/paramHelp'
import { canBeNonIdeal, parasiticValues } from '@/lib/parasitics'
import { DEVICE_TEMPLATE, QUICK } from '@/lib/realParts'
import {
  composeWave,
  dbmToPeak,
  parseWave,
  pwlPoints,
  WAVE_DEFAULTS,
  WAVE_FIELDS,
  WAVE_LABELS,
  type Wave,
  type WaveField,
  type WaveKind,
} from '@/lib/sources'
import {
  decimalPoint,
  formatValue,
  parseValue,
  quantityHint,
  spiceNumber,
  toSpice,
  valueHint,
} from '@/lib/units'
import { editSheetAsTemplate } from '@/panels/TemplatePanel'
import { useEditor } from '@/store/editor'
import { currentSheet, pendingEdits, useProject } from '@/store/project'
import { useSettings } from '@/store/settings'
import { useSimulation } from '@/store/simulation'
import { editBlockSymbol } from '@/symbol-editor/SymbolEditor'
import { DevicePartRows, IdealPartRows, RealPartRows } from './RealPart'

/** Unit of a numeric parameter (by element and key); undefined = free text (e.g. SIN(...)). */
function paramUnit(symbol: SymbolDef | undefined, key: string): string | undefined {
  const element = symbol?.spice?.element
  const units: Record<string, string> = { R: 'Ω', C: 'F', L: 'H', ic: element === 'L' ? 'A' : 'V' }
  if (key in units) return units[key]
  if (key === 'dc' || key === 'ac') return element === 'I' ? 'A' : 'V'
  if (['gain', 'acphase', 'area', 'w', 'l', 'm', 'tc1', 'tc2', 'temp'].includes(key.toLowerCase())) return ''
  return undefined
}

/** Text field: commits on Enter / blur, reverts on Escape, optional live validation. */
function Field({
  value,
  onCommit,
  unit,
  mono = true,
  autoFocus = false,
  label,
  validate,
  si = false,
  placeholder,
  list,
}: {
  value: string
  onCommit: (v: string) => void
  unit?: string
  mono?: boolean
  autoFocus?: boolean
  label: string
  validate?: (v: string) => string | null // message = the value is refused
  si?: boolean // unit written out means SI ("1 MHz" = mega), as in the analysis fields
  placeholder?: string
  list?: string // id of a <datalist> with suggestions
}) {
  const [draft, setDraft] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    setDraft(value)
  }, [value])
  useEffect(() => {
    if (!autoFocus) return
    ref.current?.focus() // select() alone does not move the keyboard focus
    ref.current?.select()
  }, [autoFocus])
  const problem = validate && draft !== value ? validate(draft.trim()) : null
  const check = problem
    ? { ok: false, hint: problem }
    : unit !== undefined && draft.trim()
      ? si
        ? quantityHint(draft, unit)
        : valueHint(draft, unit)
      : null
  const commit = () => {
    if (draft === value) return
    if (check && !check.ok) {
      setDraft(value) // never store an invalid number; the hint explained why
      return
    }
    // Values are stored with a decimal point whatever the user typed (1,5k -> 1.5k).
    onCommit(unit !== undefined ? decimalPoint(draft) : draft.trim())
  }
  return (
    <div className="flex flex-col gap-0.5">
      <Input
        ref={ref}
        value={draft}
        aria-label={label}
        placeholder={placeholder}
        list={list}
        aria-invalid={check ? !check.ok : undefined}
        className={`h-8 ${mono ? 'font-mono' : ''} ${check && !check.ok ? 'border-destructive' : ''}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') {
            setDraft(value)
            e.currentTarget.blur()
          }
        }}
      />
      {check && draft !== value && (
        <span className={`text-[11px] ${check.ok ? 'text-muted-foreground' : 'text-destructive'}`}>
          {check.hint}
        </span>
      )}
    </div>
  )
}

function Row({
  label,
  title,
  help,
  children,
}: {
  label: string
  title?: string
  help?: ReactNode // the label as a parameter card trigger
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[6rem_1fr] items-start gap-2 text-sm" title={help ? undefined : title}>
      {help ? (
        <span className="min-w-0 pt-1.5">{help}</span>
      ) : (
        <span className="truncate pt-1.5 text-muted-foreground">{label}</span>
      )}
      {children}
    </div>
  )
}

function Section({
  title,
  children,
  defaultOpen = true,
}: {
  title: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        className="flex items-center gap-1 text-xs font-medium tracking-wide text-muted-foreground uppercase"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <ChevronDown className={`size-3 transition-transform ${open ? '' : '-rotate-90'}`} />
        {title}
      </button>
      {open && children}
    </section>
  )
}

const mm = (units: number) => String(units / 100)
const fromMm = (text: string) => Math.round(Number.parseFloat(text.replace(',', '.')) * 100)

const SOURCE_KEYS = ['dc', 'ac', 'tran']
const isSource = (symbol: SymbolDef | undefined) =>
  symbol?.spice?.element === 'V' || symbol?.spice?.element === 'I'

/** DC value, AC magnitude and transient waveform of a V or I source, as a form. */
function SourceRows({ symbol, instances }: { symbol: SymbolDef; instances: Instance[] }) {
  const { sheetName, execute } = useProject()
  const unit = symbol.spice?.element === 'I' ? 'A' : 'V'
  const params = { ...symbol.default_params, ...instances[0].model.params }
  const wave = parseWave(params.tran)
  const csvRef = useRef<HTMLInputElement>(null)
  const [dbm, setDbm] = useState({ power: '', ohms: '50' })
  const setParams = (values: Record<string, string | null>) =>
    execute({
      type: 'transaction',
      label: 'set source',
      commands: instances.map((i) => ({ type: 'set_params', sheet: sheetName, id: i.id, params: values })),
    })
  const setWave = (next: Wave) => setParams({ tran: composeWave(next, unit) })
  const fieldUnit = (f: WaveField) => (f.unit === 'value' ? unit : f.unit === '1/s' ? '' : f.unit)
  const amplitudeKey = wave.kind === 'am' ? 'vmo' : wave.kind === 'sin' || wave.kind === 'sffm' ? 'va' : null
  const applyDbm = () => {
    const power = Number.parseFloat(dbm.power.replace(',', '.'))
    const ohms = parseValue(dbm.ohms)
    if (!amplitudeKey || !Number.isFinite(power) || !ohms || ohms <= 0) return
    const peak = dbmToPeak(power, ohms, unit)
    void setWave({ ...wave, fields: { ...wave.fields, [amplitudeKey]: spiceNumber(peak) } })
  }
  return (
    <>
      <Row label="DC value">
        <Field
          label="DC value"
          value={params.dc ?? ''}
          unit={unit}
          onCommit={(v) => setParams({ dc: v || null })}
        />
      </Row>
      <Row label="AC magnitude">
        <Field
          label="AC magnitude"
          si
          value={params.ac ?? ''}
          unit={unit}
          onCommit={(v) => setParams({ ac: v ? toSpice(v, unit) : null })}
        />
      </Row>
      <p className="-mt-1 text-[11px] text-muted-foreground">
        AC magnitude is used by the AC analysis (usually 1); leave empty otherwise.
      </p>
      <Row label="Waveform">
        <select
          aria-label="Transient waveform"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          value={wave.kind}
          onChange={(e) => {
            const kind = e.target.value as WaveKind
            if (kind === 'none') void setParams({ tran: null })
            else if (kind === 'custom') void setParams({ tran: params.tran || 'PWL(0 0 1m 1)' })
            else void setWave({ kind, fields: { ...WAVE_DEFAULTS[kind] } })
          }}
        >
          {WAVE_LABELS.map(([kind, label]) => (
            <option key={kind} value={kind}>
              {label}
            </option>
          ))}
        </select>
      </Row>
      {wave.kind !== 'none' &&
        wave.kind !== 'custom' &&
        wave.kind !== 'pwl' &&
        WAVE_FIELDS[wave.kind].map((f) => (
          <Row key={f.key} label={f.label}>
            {f.options ? (
              <select
                aria-label={f.label}
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={wave.fields[f.key] || f.options[0][0]}
                onChange={(e) => setWave({ ...wave, fields: { ...wave.fields, [f.key]: e.target.value } })}
              >
                {f.options.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            ) : (
              <div title={f.hint}>
                <Field
                  label={f.label}
                  si
                  value={wave.fields[f.key] ?? ''}
                  unit={fieldUnit(f)}
                  placeholder={f.optional ? 'none' : undefined}
                  onCommit={(v) => setWave({ ...wave, fields: { ...wave.fields, [f.key]: v } })}
                />
              </div>
            )}
          </Row>
        ))}
      {amplitudeKey && (
        <Row label="From power">
          <div className="flex items-center gap-1">
            <Input
              aria-label="Power in dBm"
              className="h-8 w-16 font-mono"
              placeholder="dBm"
              value={dbm.power}
              onChange={(e) => setDbm({ ...dbm, power: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && applyDbm()}
            />
            <span className="text-xs text-muted-foreground">dBm into</span>
            <Input
              aria-label="Load resistance"
              className="h-8 w-14 font-mono"
              value={dbm.ohms}
              onChange={(e) => setDbm({ ...dbm, ohms: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && applyDbm()}
            />
            <span className="text-xs text-muted-foreground">Ω</span>
            <Button
              variant="outline"
              size="sm"
              className="h-8"
              onClick={applyDbm}
              disabled={!dbm.power.trim()}
            >
              Set
            </Button>
          </div>
        </Row>
      )}
      {wave.kind === 'pwl' && (
        <>
          <Row label="Points">
            <div className="flex flex-col gap-1">
              <Textarea
                aria-label="PWL points"
                className="min-h-24 font-mono text-xs"
                defaultValue={wave.fields.points}
                key={wave.fields.points}
                placeholder={'time value\n0 0\n1m 5'}
                onBlur={(e) => {
                  if (e.target.value !== wave.fields.points)
                    void setWave({ ...wave, fields: { ...wave.fields, points: e.target.value } })
                }}
              />
              <span className="text-[11px] text-muted-foreground">
                {pwlPoints(wave.fields.points ?? '').length} points · one “time value” pair per line
              </span>
              <Button
                variant="outline"
                size="sm"
                className="self-start"
                onClick={() => csvRef.current?.click()}
              >
                Load from a CSV file / measurement…
              </Button>
              <input
                ref={csvRef}
                type="file"
                accept=".csv,.txt,.tsv"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  const pairs = pwlPoints(await file.text())
                  if (!pairs.length) return toast.error('No “time, value” pairs found in the file')
                  void setWave({
                    ...wave,
                    fields: { ...wave.fields, points: pairs.map((p) => p.join(' ')).join('\n') },
                  })
                  toast.success(`${pairs.length} points loaded from ${file.name}`)
                }}
              />
            </div>
          </Row>
          <Row label="Repeat from">
            <Field
              label="Repeat from"
              si
              unit="s"
              placeholder="no repeat"
              value={wave.fields.repeat ?? ''}
              onCommit={(v) => setWave({ ...wave, fields: { ...wave.fields, repeat: v } })}
            />
          </Row>
        </>
      )}
      {wave.kind === 'custom' && (
        <Row label="SPICE">
          <Field
            label="Transient waveform (SPICE)"
            value={params.tran ?? ''}
            onCommit={(v) => setParams({ tran: v || null })}
          />
        </Row>
      )}
    </>
  )
}

function ParamRows({
  symbol,
  instances,
  focus,
}: {
  symbol: SymbolDef | undefined
  instances: Instance[]
  focus: boolean
}) {
  const { sheetName, execute } = useProject()
  const [newKey, setNewKey] = useState('')
  const first = instances[0]
  const parasitic = new Set(symbol?.parasitics?.map((p) => p.key))
  if (isSource(symbol)) for (const key of SOURCE_KEYS) parasitic.add(key) // edited in "Source"
  const behavioural = symbol?.spice?.element === 'B'
  if (behavioural) for (const key of ['v', 'i']) parasitic.add(key) // edited in "Output"
  const params = Object.fromEntries(
    Object.entries({ ...symbol?.default_params, ...first.model.params }).filter(
      ([key]) => !parasitic.has(key),
    ),
  )
  const setParam = (key: string, value: string | null) =>
    execute({
      type: 'transaction',
      label: 'set parameter',
      commands: instances.map((i) => ({
        type: 'set_params',
        sheet: sheetName,
        id: i.id,
        params: { [key]: value },
      })),
    })
  // A B source is a voltage (V=) or a current (I=) source: an i parameter makes it a current one.
  const current = 'i' in first.model.params
  const expression = current
    ? first.model.params.i
    : ({ ...symbol?.default_params, ...first.model.params }.v ?? '')
  const setOutput = async (toCurrent: boolean) => {
    // An expression typed just before may still be on its way: taken from the document once it
    // is there, not from what this panel showed (it went back to the old one).
    await pendingEdits()
    const sheet = useProject.getState().project?.sheets.find((s) => s.name === sheetName)
    const now = sheet?.instances.find((i) => i.id === first.id)?.model.params ?? first.model.params
    const text = 'i' in now ? now.i : ({ ...symbol?.default_params, ...now }.v ?? '')
    return execute({
      type: 'transaction',
      label: toCurrent ? 'current source' : 'voltage source',
      commands: instances.map((inst) => ({
        type: 'set_params',
        sheet: sheetName,
        id: inst.id,
        params: toCurrent ? { i: text || '0', v: null } : { v: text || '0', i: null },
      })),
    })
  }
  return (
    <>
      {behavioural && (
        <>
          <Row
            label="Output"
            title="What the expression gives: the voltage between the pins or the current from + to − through the source"
          >
            <select
              aria-label="Behavioral output"
              className="h-8 w-full rounded-md border bg-background px-2 text-sm"
              value={current ? 'i' : 'v'}
              onChange={(e) => void setOutput(e.target.value === 'i')}
            >
              <option value="v">Voltage (V=)</option>
              <option value="i">Current (I=)</option>
            </select>
          </Row>
          <Row label={current ? 'I =' : 'V ='}>
            <Field
              label={current ? 'Current expression' : 'Voltage expression'}
              value={expression}
              onCommit={(v) => setParam(current ? 'i' : 'v', v)}
              autoFocus={focus}
            />
          </Row>
          <p className="-mt-1 text-[11px] text-muted-foreground">
            e.g. V(in)*2, I(V1)*10, time &gt; 1m ? 5 : 0
          </p>
        </>
      )}
      {Object.entries(params).map(([key, value], i) => {
        const mixed = instances.some(
          (inst) => ({ ...symbol?.default_params, ...inst.model.params })[key] !== value,
        )
        return (
          <Row
            key={key}
            label={key}
            help={
              <ParamHelp
                fieldKey={key}
                label={key}
                unit={paramUnit(symbol, key) ?? ''}
                info={primitiveInfo(key)}
                value={value}
              >
                {key}
              </ParamHelp>
            }
          >
            <div className="flex gap-1">
              <div className="flex-1">
                <Field
                  label={key}
                  value={mixed ? '' : value}
                  unit={paramUnit(symbol, key)}
                  onCommit={(v) => setParam(key, v)}
                  autoFocus={focus && !behavioural && i === 0}
                />
              </div>
              {!(key in (symbol?.default_params ?? {})) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8"
                  onClick={() => setParam(key, null)}
                  aria-label={`Remove ${key}`}
                >
                  <X />
                </Button>
              )}
            </div>
          </Row>
        )
      })}
      <div className="flex gap-1">
        <Input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder="add parameter (e.g. tc1)"
          aria-label="New parameter name"
          className="h-8 font-mono"
          onKeyDown={(e) => {
            if (e.key === 'Enter' && newKey.trim()) {
              void setParam(newKey.trim(), '0')
              setNewKey('')
            }
          }}
        />
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          disabled={!newKey.trim()}
          onClick={() => {
            void setParam(newKey.trim(), '0')
            setNewKey('')
          }}
          aria-label="Add parameter"
        >
          <Plus />
        </Button>
      </div>
      {symbol?.id === 'bpt:hs' && <TransferPlot h={params.h ?? first.model.params.h ?? ''} />}
    </>
  )
}

function OperatingPoint({ instance, symbol }: { instance: Instance; symbol: SymbolDef }) {
  const { opValues, nets } = useSimulation()
  if (!opValues || !nets) return null
  const rows: [string, string][] = []
  for (const pin of pinPositions(symbol, instance)) {
    const net = nets.pins[`${instance.id}:${pin.number}`]
    const v = net === '0' ? 0 : opValues[`V(${net})`]
    if (v !== undefined) rows.push([`V(${pin.number}) ${net}`, formatValue(v, 'V')])
    const i = opValues[`I(${instance.ref}.${pin.number})`]
    if (i !== undefined) rows.push([`I(${pin.number})`, formatValue(i, 'A')])
  }
  const current = opValues[`I(${instance.ref})`]
  if (current !== undefined) rows.push(['I', formatValue(current, 'A')])
  if (rows.length === 0) return null
  return (
    <Section title="Operating point">
      {rows.map(([name, value]) => (
        <div key={name} className="flex justify-between font-mono text-xs">
          <span className="text-muted-foreground">{name}</span>
          <span>{value}</span>
        </div>
      ))}
    </Section>
  )
}

/** ESR, ESL, DCR...: empty fields = ideal part; values become extra elements in the netlist. */
function ParasiticRows({ symbol, instances }: { symbol: SymbolDef; instances: Instance[] }) {
  const { sheetName, execute } = useProject()
  const first = instances[0]
  const setParams = (params: Record<string, string | null>, label: string) =>
    execute({
      type: 'transaction',
      label,
      commands: instances.map((i) => ({ type: 'set_params', sheet: sheetName, id: i.id, params })),
    })
  const set = parasiticValues(symbol, first)
  return (
    <>
      {!QUICK[symbol.id] && (
        <p className="text-xs text-muted-foreground">
          {set.length
            ? `Non-ideal: ${set.map((v) => v.label).join(', ')}.`
            : 'Ideal. Enter values below to model what a real one adds.'}
        </p>
      )}
      {symbol.parasitics.map((p) => {
        const mixed = instances.some(
          (inst) => (inst.model.params[p.key] ?? '') !== (first.model.params[p.key] ?? ''),
        )
        return (
          <Row key={p.key} label={p.label}>
            <div title={`${p.description} (${p.connection}, ${p.unit})`}>
              <Field
                label={p.label}
                value={mixed ? '' : (first.model.params[p.key] ?? '')}
                unit={p.unit}
                onCommit={(v) => setParams({ [p.key]: v || null }, `set ${p.label}`)}
              />
            </div>
          </Row>
        )
      })}
      {set.length > 0 && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() =>
            setParams(Object.fromEntries(symbol.parasitics.map((p) => [p.key, null])), 'make ideal')
          }
        >
          Make ideal
        </Button>
      )}
    </>
  )
}

function InstanceProperties({ instances, focus }: { instances: Instance[]; focus: boolean }) {
  const { symbols, sheetName, execute } = useProject()
  const drawnHere = useProject((s) => {
    const id = s.symbols.get(instances[0]?.symbol ?? '')?.id
    return Boolean(id && s.project?.default_looks?.[id])
  })
  const instance = instances[0]
  const base = symbols.get(instance.symbol)
  // As simulated: the chosen variant decides the element, the model and default parameters.
  const symbol = base && withVariant(base, instance.model.variant)
  const single = instances.length === 1
  const usesModel = symbol?.default_model || instance.model.model
  const isComponent = Boolean(
    useProject((s) => s.project?.sheets.find((sh) => `${BLOCK}${sh.name}` === instance.symbol)?.component),
  )
  const update = (fields: Partial<Pick<Instance, 'ref' | 'at' | 'rot' | 'mirror' | 'texts'>>) =>
    execute({ type: 'update_instance', sheet: sheetName, id: instance.id, ...fields })
  // Turn a text a quarter (or back), keeping where it starts; Reset puts it back on the symbol.
  const turnText = (field: TextField) => {
    if (!symbol) return
    const spot = textSpot(symbol, instance, field)
    const content = field === 'ref' ? instance.ref : valueText(symbol, instance)
    if (!spot || !content) return
    const place = placeOf(spot, instance, content.length, 110 * 0.62)
    update({ texts: { ...instance.texts, [field]: { ...place, rot: place.rot === 90 ? 0 : 90 } } })
  }
  const resetText = (field: TextField) => {
    const texts = { ...instance.texts }
    delete texts[field]
    update({ texts })
  }
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="font-medium">
          {single
            ? `${instance.ref} · ${symbol?.name ?? instance.symbol}`
            : `${instances.length} × ${symbol?.name}`}
        </p>
        <p className="text-xs text-muted-foreground">{symbol?.description || symbol?.id}</p>
      </div>
      <Section title="General">
        {symbol?.power_net != null && (
          <Row label="Net">
            <span className="pt-1.5 font-mono text-sm">
              {instance.model.params.net || symbol.default_params.net || symbol.power_net}
              {(instance.model.params.net || symbol.default_params.net || symbol.power_net) === '0' && (
                <span className="text-muted-foreground"> (ground – the 0 V reference)</span>
              )}
            </span>
          </Row>
        )}
        {single && symbol?.power_net === null && (
          <Row label="Reference">
            <Field
              label="Reference"
              value={instance.ref}
              onCommit={(ref) => update({ ref })}
              validate={(ref) => {
                if (!ref) return 'a reference is required'
                const taken = useProject
                  .getState()
                  .project?.sheets.some((sh) =>
                    sh.instances.some(
                      (i) => i.id !== instance.id && i.ref.toLowerCase() === ref.toLowerCase(),
                    ),
                  )
                return taken ? `${ref} is already used by another part` : null
              }}
            />
          </Row>
        )}
        {base?.looks && base.looks.length > 0 && (
          <Row label="Symbol">
            <div className="flex items-center gap-2">
              <SymbolPreview symbol={base} look={instance.look} size={32} />
              <select
                aria-label="Symbol look"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={instance.look ?? ''}
                onChange={(e) => {
                  const name = e.target.value
                  // A drawing from a library: the project keeps a copy (opens the same anywhere).
                  const look = base.looks?.find((l) => l.name === name)
                  const kept = useProject.getState().project?.looks?.[base.id]?.some((l) => l.name === name)
                  const copy: Command[] =
                    look && name.startsWith('user:') && !kept
                      ? [{ type: 'set_project_look', symbol: base.id, name, look }]
                      : []
                  void execute({
                    type: 'transaction',
                    label: 'set symbol look',
                    commands: [
                      ...copy,
                      ...instances.map(
                        (i): Command => ({ type: 'update_instance', sheet: sheetName, id: i.id, look: name }),
                      ),
                    ],
                  })
                }}
              >
                <option value="">Automatic (IEC / ANSI setting)</option>
                <option value="base">Basic drawing</option>
                {base.looks.map((look) => (
                  <option key={look.name} value={look.name}>
                    {look.label}
                  </option>
                ))}
              </select>
            </div>
          </Row>
        )}
        {base && drawnHere && (
          <Button
            variant="outline"
            size="sm"
            className="self-start"
            title="Every part of this kind in the project back to the built-in drawing"
            onClick={() => void restoreDrawing(base.id)}
          >
            Restore the built-in drawing here
          </Button>
        )}
        {base?.variants && base.variants.length > 1 && (
          <Row label="Simulate as">
            <div className="flex flex-col gap-1">
              <select
                aria-label="Variant"
                className="h-8 w-full rounded-md border bg-background px-2 text-sm"
                value={instance.model.variant ?? base.variants[0].name}
                onChange={(e) =>
                  execute({
                    type: 'transaction',
                    label: 'set variant',
                    commands: instances.map(
                      (i): Command => ({
                        type: 'set_params',
                        sheet: sheetName,
                        id: i.id,
                        params: {},
                        // The variant brings its own model; a chosen one would override it.
                        variant: e.target.value === base.variants?.[0].name ? null : e.target.value,
                        model: null,
                        pins: null,
                      }),
                    ),
                  })
                }
              >
                {base.variants.map((v) => (
                  <option key={v.name} value={v.name}>
                    {v.label}
                  </option>
                ))}
              </select>
              <span className="text-[11px] text-muted-foreground">
                {
                  base.variants.find((v) => v.name === (instance.model.variant ?? base.variants?.[0].name))
                    ?.description
                }
              </span>
            </div>
          </Row>
        )}
        {usesModel && symbol && <ModelRows symbol={symbol} instances={instances} />}
      </Section>
      {instance.symbol.startsWith(BLOCK) && (
        <Section title="Block">
          <BlockRows instances={instances} />
        </Section>
      )}
      {/* Ground and similar symbols have nothing to set. */}
      {!instance.symbol.startsWith(BLOCK) &&
        symbol?.spice?.element !== 'X' && // a subcircuit model's parameters are under Model
        (symbol?.spice || Object.keys(symbol?.default_params ?? {}).length > 0) && (
          <Section title="Parameters">
            <ParamRows symbol={symbol} instances={instances} focus={focus} />
          </Section>
        )}
      {symbol && isSource(symbol) && (
        <Section title="Source">
          <SourceRows symbol={symbol} instances={instances} />
        </Section>
      )}
      {symbol && canBeNonIdeal(symbol) && (
        <Section title={QUICK[symbol.id] ? 'Ideal / real part' : 'Parasitics'}>
          <IdealPartRows symbol={symbol} instances={instances}>
            <ParasiticRows symbol={symbol} instances={instances} />
          </IdealPartRows>
        </Section>
      )}
      {isComponent && (
        <Section title="Real part">
          <RealPartRows instances={instances} />
        </Section>
      )}
      {symbol && DEVICE_TEMPLATE[symbol.id] && (
        <Section title="Real part">
          <DevicePartRows symbol={symbol} instances={instances} />
        </Section>
      )}
      {single && symbol?.spice && !isSource(symbol) && (
        <Section
          title="Ratings"
          defaultOpen={Object.keys({ ...blockRatings(instance), ...instance.ratings }).length > 0}
        >
          <RatingRows instance={instance} />
        </Section>
      )}
      {single && (
        <Section title="Placement" defaultOpen={false}>
          <Row label="X / Y (mm)">
            <div className="grid grid-cols-2 gap-1">
              <Field
                label="X"
                value={mm(instance.at[0])}
                onCommit={(x) => update({ at: [fromMm(x), instance.at[1]] })}
              />
              <Field
                label="Y"
                value={mm(instance.at[1])}
                onCommit={(y) => update({ at: [instance.at[0], fromMm(y)] })}
              />
            </div>
          </Row>
          <Row label="Rotation">
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              value={instance.rot}
              aria-label="Rotation"
              onChange={(e) => update({ rot: Number(e.target.value) as Rotation })}
            >
              {[0, 90, 180, 270].map((r) => (
                <option key={r} value={r}>
                  {r}°
                </option>
              ))}
            </select>
          </Row>
          <Row label="Mirrored">
            <input
              type="checkbox"
              className="mt-2 size-4"
              checked={instance.mirror}
              aria-label="Mirrored"
              onChange={(e) => update({ mirror: e.target.checked })}
            />
          </Row>
          {(['ref', 'value'] as const).map((field) => (
            <Row key={field} label={field === 'ref' ? 'Reference text' : 'Value text'}>
              <div className="flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 px-2 text-xs"
                  aria-label={`Rotate the ${field === 'ref' ? 'reference' : 'value'} text`}
                  onClick={() => turnText(field)}
                >
                  {instance.texts?.[field]?.rot === 90 ? 'Horizontal' : 'Vertical'}
                </Button>
                {instance.texts?.[field] && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    aria-label={`Reset the ${field === 'ref' ? 'reference' : 'value'} text`}
                    onClick={() => resetText(field)}
                  >
                    Reset
                  </Button>
                )}
              </div>
            </Row>
          ))}
          <p className="text-[11px] text-muted-foreground">
            Drag the reference or value of a selected part to move it; R while dragging turns it.
          </p>
        </Section>
      )}
      {single && symbol && <OperatingPoint instance={instance} symbol={symbol} />}
    </div>
  )
}

/** Element of a model card type / subcircuit pin count, to offer only models that fit. */
const CARD_ELEMENT: Record<string, string> = {
  d: 'D',
  npn: 'Q',
  pnp: 'Q',
  nmos: 'M',
  pmos: 'M',
  vdmos: 'M',
  njf: 'J',
  pjf: 'J',
  sw: 'S',
}

/** The model of a part: a list of the models that fit, and the pin map of a subcircuit model. */
function ModelRows({ symbol, instances }: { symbol: SymbolDef; instances: Instance[] }) {
  const { project, sheetName, execute, libraryModels } = useProject()
  const [pasting, setPasting] = useState(false) // the Paste a model dialog
  const instance = instances[0]
  const name = instance.model.model ?? symbol.default_model ?? ''
  const cards = { ...libraryModels.models, ...project?.models }
  const subckts = { ...libraryModels.subcircuits, ...project?.subcircuits }
  const element = symbol.spice?.element
  const pinCount = symbol.pins.filter((p) => !p.implicit_net).length
  const options = [
    ...Object.entries(cards)
      .filter(([, card]) => CARD_ELEMENT[card.type] === element)
      .map(([n, card]) => [n, card.type] as const),
    ...Object.entries(subckts)
      .filter(([, sub]) => element === 'X' || sub.pins.length <= pinCount + 2)
      .map(([n, sub]) => [n, `subcircuit, ${sub.pins.length} pins`] as const),
  ].sort(([a], [b]) => a.localeCompare(b))
  const sub = subckts[name]
  const set = (fields: { model?: string | null; pins?: string[] | null }) =>
    execute({
      type: 'transaction',
      label: 'set model',
      commands: instances.map(
        (i): Command => ({ type: 'set_params', sheet: sheetName, id: i.id, params: {}, ...fields }),
      ),
    })
  // A model only in a library is copied into the project with the change (like a placed part).
  const select = (model: string) => {
    const commands: Command[] = []
    if (model && libraryModels.subcircuits[model] && !project?.subcircuits?.[model])
      commands.push({ type: 'set_subcircuit', name: model, subckt: libraryModels.subcircuits[model] })
    else if (model && libraryModels.models[model] && !project?.models[model])
      commands.push({ type: 'set_model', name: model, card: libraryModels.models[model] })
    for (const i of instances)
      commands.push({
        type: 'set_params',
        sheet: sheetName,
        id: i.id,
        params: {},
        model: model || null,
        pins: null,
      })
    return execute({ type: 'transaction', label: 'set model', commands })
  }
  const listId = `models-${instance.id}`
  // A pasted model: into the project (replacing one of its name), then the part uses it.
  const applyPasted = (item: CheckedModel) => {
    const commands: Command[] = []
    if (item.subckt) commands.push({ type: 'set_subcircuit', name: item.name, subckt: item.subckt })
    else if (item.card) commands.push({ type: 'set_model', name: item.name, card: item.card })
    for (const i of instances)
      commands.push({
        type: 'set_params',
        sheet: sheetName,
        id: i.id,
        params: {},
        model: item.name,
        pins: null,
      })
    return execute({ type: 'transaction', label: `paste model ${item.name}`, commands })
  }
  const fits = (item: CheckedModel): string => {
    if (item.kind === 'subckt')
      return element === 'X' || item.pins.length <= pinCount + 2
        ? ''
        : `it has ${item.pins.length} pins, the part ${pinCount}`
    return CARD_ELEMENT[item.type.toLowerCase()] === element
      ? ''
      : `a ${item.type.toUpperCase()} model does not fit this part`
  }
  return (
    <>
      <Row label="Model">
        <div className="flex flex-col gap-1">
          <div className="flex gap-1">
            <div className="min-w-0 flex-1">
              <Field label="Model" value={name} onCommit={(model) => void select(model)} list={listId} />
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-8 shrink-0 px-2 text-xs"
              onClick={() => setPasting(true)}
            >
              Paste…
            </Button>
          </div>
          <PasteModel
            open={pasting}
            onOpenChange={setPasting}
            fits={fits}
            taken={(model) => Boolean(project?.models[model] || project?.subcircuits?.[model])}
            onUse={(item) => void applyPasted(item)}
          />
          <datalist id={listId}>
            {options.map(([n, kind]) => (
              <option key={n} value={n}>
                {kind}
              </option>
            ))}
          </datalist>
          {name && !cards[name] && !sub && (
            <span className="text-[11px] text-destructive">
              No model “{name}” – import one (File → Import SPICE models…) or pick from the list.
            </span>
          )}
        </div>
      </Row>
      {name && cards[name] && Object.keys(cards[name].params).length > 0 && (
        <details className="px-1 text-xs" data-testid="model-params">
          <summary className="cursor-pointer text-muted-foreground">
            Model parameters ({Object.keys(cards[name].params).length})
          </summary>
          <div className="mt-1 grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-0.5">
            {Object.entries(cards[name].params).map(([key, value]) => (
              <Fragment key={key}>
                <ParamHelp
                  fieldKey={key}
                  label={key.toUpperCase()}
                  unit=""
                  info={spiceParamInfo(cards[name].type, key)}
                  value={value}
                >
                  {key.toUpperCase()}
                </ParamHelp>
                <span className="truncate font-mono">{value}</span>
              </Fragment>
            ))}
          </div>
        </details>
      )}
      {sub &&
        Object.entries(sub.params).map(([key, fallback]) => {
          const values = new Set(instances.map((i) => i.model.params[key] ?? ''))
          return (
            <Row key={key} label={key}>
              <Field
                label={key}
                value={values.size === 1 ? [...values][0] : ''}
                placeholder={values.size === 1 ? `${fallback} (model default)` : 'several values'}
                unit=""
                onCommit={(v) =>
                  execute({
                    type: 'transaction',
                    label: 'set model parameter',
                    commands: instances.map(
                      (i): Command => ({
                        type: 'set_params',
                        sheet: sheetName,
                        id: i.id,
                        params: { [key]: v || null },
                      }),
                    ),
                  })
                }
              />
            </Row>
          )
        })}
      {sub && (
        <PinMapRows
          symbol={symbol}
          sub={sub}
          pins={instance.model.pins ?? null}
          onSet={(pins) => void set({ pins })}
        />
      )}
    </>
  )
}

/** Which symbol pin goes to each pin of a subcircuit model ("=0" ground, "=VCC" a net). */
function PinMapRows({
  symbol,
  sub,
  pins,
  onSet,
}: {
  symbol: SymbolDef
  sub: SubcktModel
  pins: string[] | null
  onSet: (pins: string[] | null) => void
}) {
  const byName = new Map<string, string>()
  for (const pin of symbol.pins) {
    if (pin.name) byName.set(pin.name.toLowerCase(), pin.number)
    byName.set(pin.number.toLowerCase(), pin.number)
  }
  const automatic = sub.pins.map((p) => byName.get(p.toLowerCase()))
  const order =
    symbol.spice?.element === 'X'
      ? (symbol.spice?.nodes ?? [])
      : (symbol.spice?.nodes ?? []).filter((n) => n !== '=0')
  const shown =
    pins ?? (automatic.every(Boolean) ? (automatic as string[]) : sub.pins.map((_p, i) => order[i] ?? ''))
  const listId = `pins-${symbol.id}`
  return (
    <Row label="Pins">
      <div className="flex flex-col gap-1">
        {sub.pins.map((pin, i) => (
          <div key={pin} className="grid grid-cols-[5rem_1fr] items-center gap-1 font-mono text-xs">
            <span className="truncate" title={`model pin ${pin}`}>
              {pin} →
            </span>
            <Input
              aria-label={`Model pin ${pin}`}
              className="h-7 font-mono text-xs"
              list={listId}
              defaultValue={shown[i] ?? ''}
              key={`${pin}-${shown[i]}`}
              onBlur={(e) => {
                const value = e.target.value.trim()
                if (value === (shown[i] ?? '')) return
                onSet(shown.map((p, j) => (j === i ? value : p)))
              }}
            />
          </div>
        ))}
        <datalist id={listId}>
          {symbol.pins.map((p) => (
            <option key={p.number} value={p.number}>
              {p.name || p.number}
            </option>
          ))}
          <option value="=0">ground</option>
        </datalist>
        <p className="text-[11px] text-muted-foreground">
          Symbol pin for each pin of the model; “=0” ties it to ground, “=VCC” to the net VCC.
          {pins && (
            <button type="button" className="ml-1 underline" onClick={() => onSet(null)}>
              Automatic
            </button>
          )}
        </p>
      </div>
    </Row>
  )
}

function LabelProperties({ label }: { label: Label }) {
  const { sheetName, execute } = useProject()
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">
        {label.kind === 'global'
          ? 'Global label'
          : label.kind === 'port'
            ? 'Port (hierarchical label)'
            : 'Net label'}
      </p>
      <Row label="Net">
        <Field
          label="Net"
          value={label.text}
          onCommit={(text) => execute({ type: 'update_label', sheet: sheetName, id: label.id, text })}
        />
      </Row>
      <Row label="Kind">
        <select
          aria-label="Label kind"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          value={label.kind}
          onChange={(e) =>
            execute({
              type: 'update_label',
              sheet: sheetName,
              id: label.id,
              kind: e.target.value as Label['kind'],
            })
          }
        >
          <option value="local">Local – this sheet</option>
          <option value="global">Global – all sheets</option>
          <option value="port">Port – pin of this sheet as a block</option>
        </select>
      </Row>
      <p className="text-[11px] text-muted-foreground">
        {label.kind === 'port'
          ? 'A sheet with ports appears in the Library under “Sheets” and can be placed as a block in other sheets.'
          : label.kind === 'global'
            ? 'Joins every net of this name on every sheet.'
            : 'Joins nets of this name on this sheet only.'}
      </p>
    </div>
  )
}

function WireProperties({ wireId }: { wireId: string }) {
  const nets = useSimulation((s) => s.nets)
  const wire = useProject((s) => currentSheet(s)?.wires.find((w) => w.id === wireId))
  const net = nets?.wires[wireId]
  const value = useSimulation((s) => (net ? s.opValues?.[`V(${net})`] : undefined))
  if (!wire) return null
  const [a, b] = wire.points
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">Wire</p>
      <Row label="Net">
        <span className="pt-1.5 font-mono text-sm">{net ?? '—'}</span>
      </Row>
      {value !== undefined && (
        <Row label="Voltage">
          <span className="pt-1.5 font-mono text-sm">{formatValue(value, 'V')}</span>
        </Row>
      )}
      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          activeEditor?.addLabelAt([
            Math.round((a[0] + b[0]) / 2 / 127) * 127,
            a[1] === b[1] ? a[1] : Math.round((a[1] + b[1]) / 2 / 127) * 127,
          ])
        }
      >
        <Tag /> Add net label…
      </Button>
      <Button
        variant="outline"
        size="sm"
        onClick={() => net && useEditor.getState().setHighlightNet(net)}
        disabled={!net}
      >
        Highlight net
      </Button>
    </div>
  )
}

function DirectiveProperties({ directive }: { directive: Directive }) {
  const { sheetName, execute } = useProject()
  const [text, setText] = useState(directive.text)
  useEffect(() => {
    setText(directive.text)
  }, [directive.text])
  return (
    <div className="flex flex-col gap-3">
      <p className="font-medium">SPICE directive</p>
      <Textarea
        value={text}
        className="font-mono"
        rows={5}
        aria-label="Directive text"
        onChange={(e) => setText(e.target.value)}
        onBlur={() =>
          text !== directive.text &&
          execute({ type: 'update_directive', sheet: sheetName, id: directive.id, text })
        }
      />
    </div>
  )
}

const BLOCK = 'sheet:'
const PARAM_NAME = /^[A-Za-z_]\w*$/

/** Editable name = value list with an "add" field (project .param, block parameters). */
function ParamTable({
  params,
  onSet,
  what,
  example,
}: {
  params: Record<string, string>
  onSet: (name: string, value: string | null) => void
  what: string // "project parameter" / "block parameter"
  example: string
}) {
  const [name, setName] = useState('')
  const add = () => {
    if (!PARAM_NAME.test(name.trim())) return
    onSet(name.trim(), '1')
    setName('')
  }
  return (
    <>
      {Object.entries(params).map(([key, value]) => (
        <Row key={key} label={key}>
          <div className="flex gap-1">
            <div className="flex-1">
              <Field label={key} value={value} unit="" onCommit={(v) => onSet(key, v)} />
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              aria-label={`Remove ${key}`}
              onClick={() => onSet(key, null)}
            >
              <X />
            </Button>
          </div>
        </Row>
      ))}
      <div className="flex gap-1">
        <Input
          value={name}
          placeholder={`new ${what} (e.g. ${example})`}
          aria-label={`New ${what}`}
          className="h-8 font-mono"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          aria-label={`Add ${what}`}
          disabled={!PARAM_NAME.test(name.trim())}
          onClick={add}
        >
          <Plus />
        </Button>
      </div>
    </>
  )
}

/** A block (sheet placed as a part): its parameters, overridden per block, and a way inside. */
function BlockRows({ instances }: { instances: Instance[] }) {
  const { project, sheetName, execute, setSheet } = useProject()
  const { data: templates = [] } = useQuery({
    queryKey: ['templates'],
    queryFn: () => apiGet<TemplateInfo[]>('/api/components/templates'),
    staleTime: Number.POSITIVE_INFINITY,
  })
  const name = instances[0].symbol.slice(BLOCK.length)
  const sheet = project?.sheets.find((s) => s.name === name)
  if (!sheet) return <p className="text-xs text-destructive">Sheet “{name}” no longer exists.</p>
  const defaults = sheet.parameters ?? {}
  // A part made from a template: its form's labels and units (C, ESR) instead of the keys.
  const template = templates.find((t) => t.name === sheet.component?.template?.name)
  const fields = new Map((template?.fields ?? []).map((f) => [f.key, f]))
  const set = (key: string, value: string | null) =>
    execute({
      type: 'transaction',
      label: 'set block parameter',
      commands: instances.map((i) => ({
        type: 'set_params',
        sheet: sheetName,
        id: i.id,
        params: { [key]: value },
      })),
    })
  return (
    <>
      {Object.entries(defaults).map(([key, fallback]) => {
        const values = new Set(instances.map((i) => i.model.params[key] ?? ''))
        const field = fields.get(key)
        return (
          <Row
            key={key}
            label={field?.label || key}
            help={
              <ParamHelp
                fieldKey={key}
                label={field?.label || key}
                unit={field?.unit ?? ''}
                info={sheet.component?.template ? paramInfo(sheet.component.template.name, key) : undefined}
                description={field?.description}
                help={field?.help}
                value={values.size === 1 ? [...values][0] || fallback : ''}
              >
                {field?.label || key}
              </ParamHelp>
            }
          >
            <Field
              label={field?.label || key}
              value={values.size === 1 ? [...values][0] : ''}
              placeholder={values.size === 1 ? `${fallback} (sheet default)` : 'several values'}
              unit={field?.unit ?? ''}
              onCommit={(v) => set(key, v || null)} // empty = back to the sheet default
            />
          </Row>
        )
      })}
      <p className="text-[11px] text-muted-foreground">
        {Object.keys(defaults).length
          ? 'Empty = the default set on the sheet. Inside the sheet values use {name}.'
          : `Sheet “${name}” has no parameters. Add them on the sheet (nothing selected) and use them in values as {name}.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setSheet(name)}>
          {sheet.owner ? 'Open the equivalent circuit' : `Open sheet “${name}”`}
        </Button>
        {/* A library part's drawing is its own: changed in the library, or after Make a copy. */}
        {!sheet.owner && (
          <Button variant="outline" size="sm" onClick={() => editBlockSymbol(name)}>
            {sheet.symbol ? 'Edit block symbol…' : 'Draw block symbol…'}
          </Button>
        )}
      </div>
    </>
  )
}

const SIDE_OF: Record<string, PortSide> = { left: 'left', right: 'right', up: 'top', down: 'bottom' }

/** Side and order of the pins of this sheet's block symbol (wires on placed blocks follow). */
function BlockPinRows({ sheetName }: { sheetName: string }) {
  const symbol = useProject((s) => s.symbols.get(`sheet:${sheetName}`))
  const drawn = useProject((s) => Boolean(s.project?.sheets.find((x) => x.name === sheetName)?.symbol))
  const execute = useProject((s) => s.execute)
  if (!symbol) return null
  if (drawn)
    return (
      <Section title="Block symbol">
        <div className="flex items-start gap-3">
          <SymbolPreview symbol={symbol} size={72} />
          <div className="flex flex-1 flex-col items-start gap-2">
            <p className="text-[11px] text-muted-foreground">
              Drawn by hand: pins are where the drawing puts them ({symbol.pins.length} ports).
            </p>
            <Button variant="outline" size="sm" onClick={() => editBlockSymbol(sheetName)}>
              Edit block symbol…
            </Button>
          </div>
        </div>
      </Section>
    )
  const pins = symbol.pins.map((p) => ({ name: p.number, side: SIDE_OF[p.orientation] }))
  const apply = (next: { name: string; side: PortSide }[]) =>
    execute({
      type: 'set_port_layout',
      sheet: sheetName,
      sides: Object.fromEntries(next.map((p) => [p.name, p.side])),
      order: next.map((p) => p.name),
    })
  const move = (i: number, by: number) => {
    const next = [...pins]
    const [pin] = next.splice(i, 1)
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, pin)
    void apply(next)
  }
  return (
    <Section title="Block pins">
      <div className="flex items-start gap-3">
        <SymbolPreview symbol={symbol} size={72} />
        <div className="flex flex-1 flex-col gap-1">
          {pins.map((pin, i) => (
            <div key={pin.name} className="flex items-center gap-1 text-sm">
              <span className="w-16 truncate font-mono" title={pin.name}>
                {pin.name}
              </span>
              <select
                aria-label={`Side of ${pin.name}`}
                className="h-7 flex-1 rounded-md border bg-background px-1 text-xs"
                value={pin.side}
                onChange={(e) =>
                  void apply(
                    pins.map((p) => (p.name === pin.name ? { ...p, side: e.target.value as PortSide } : p)),
                  )
                }
              >
                <option value="left">left</option>
                <option value="right">right</option>
                <option value="top">top</option>
                <option value="bottom">bottom</option>
              </select>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Move ${pin.name} up`}
                disabled={i === 0}
                onClick={() => move(i, -1)}
              >
                <ChevronDown className="rotate-180" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Move ${pin.name} down`}
                disabled={i === pins.length - 1}
                onClick={() => move(i, 1)}
              >
                <ChevronDown />
              </Button>
            </div>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">
        Labels and wires on the pins of placed blocks move with them.
      </p>
      <Button variant="outline" size="sm" className="self-start" onClick={() => editBlockSymbol(sheetName)}>
        Draw block symbol…
      </Button>
    </Section>
  )
}

/** Nothing selected: project-wide parameters (.param) and, on a block sheet, its parameters. */
function ProjectProperties() {
  const project = useProject((s) => s.project)
  const settingsStandard = useSettings((s) => s.symbolStandard)
  const sheet = useProject((s) => currentSheet(s))
  const execute = useProject((s) => s.execute)
  if (!project) return null
  const isBlock =
    sheet?.labels.some((l) => l.kind === 'port') || Object.keys(sheet?.parameters ?? {}).length > 0
  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="font-medium">{project.name}</p>
        <p className="text-xs text-muted-foreground">{t('properties.none')} – project settings</p>
      </div>
      {sheet && isBlock && (
        <Section title={`Block parameters (sheet ${sheet.name})`}>
          <p className="text-xs text-muted-foreground">
            Defaults of this sheet as a block; each block can change them. Use them in values here as{' '}
            {'{name}'}.
          </p>
          <ParamTable
            params={sheet.parameters ?? {}}
            what="block parameter"
            example="R"
            onSet={(name, value) => execute({ type: 'set_parameter', sheet: sheet.name, name, value })}
          />
        </Section>
      )}
      {sheet && isBlock && <BlockPinRows sheetName={sheet.name} />}
      {sheet && isBlock && !sheet.owner && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => openComponentWizard({ sheet: sheet.name, page: 'data' })}
        >
          Save as a part…
        </Button>
      )}
      {sheet && isBlock && !sheet.owner && (
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => editSheetAsTemplate(sheet.name)}
        >
          Save as model…
        </Button>
      )}
      <Row label="Symbols" title="Drawing of parts without a look of their own, in this project">
        <select
          aria-label="Symbol standard of the project"
          className="h-8 w-full rounded-md border bg-background px-2 text-sm"
          value={project.symbol_standard ?? ''}
          onChange={(e) =>
            void execute({
              type: 'set_symbol_standard',
              standard: (e.target.value || null) as 'iec' | 'ansi' | null,
            })
          }
        >
          <option value="">As in Settings ({settingsStandard.toUpperCase()})</option>
          <option value="iec">IEC (box resistor)</option>
          <option value="ansi">ANSI (zigzag resistor)</option>
        </select>
      </Row>
      <Section title="Stress margins" defaultOpen={false}>
        <StressRuleRows />
      </Section>
      <Section title="Parameters (.param)">
        {Object.entries(project.parameters).length === 0 && (
          <p className="text-xs text-muted-foreground">
            Use parameters in values as {'{name}'}, e.g. R = {'{Rload*2}'}.
          </p>
        )}
        <ParamTable
          params={project.parameters}
          what="project parameter"
          example="Rload"
          onSet={(name, value) => execute({ type: 'set_parameter', name, value })}
        />
      </Section>
    </div>
  )
}

export function PropertiesPanel() {
  const selection = useEditor((s) => s.selection)
  const sheet = useProject((s) => currentSheet(s))
  const [focus, setFocus] = useState(0)
  useEffect(() => {
    const onEdit = () => setFocus((n) => n + 1)
    window.addEventListener('bpt:edit-properties', onEdit)
    return () => window.removeEventListener('bpt:edit-properties', onEdit)
  }, [])

  let content: ReactNode = <ProjectProperties />
  if (sheet && selection.size > 0) {
    const instances = sheet.instances.filter((i) => selection.has(i.id))
    const sameSymbol = instances.length > 0 && instances.every((i) => i.symbol === instances[0].symbol)
    const [id] = selection
    const label = sheet.labels.find((l) => l.id === id)
    const directive = sheet.directives.find((d) => d.id === id)
    const wire = sheet.wires.find((w) => w.id === id)
    if (instances.length === selection.size && sameSymbol) {
      content = (
        <InstanceProperties
          key={`${[...selection].join()}-${focus}`}
          instances={instances}
          focus={focus > 0}
        />
      )
    } else if (selection.size === 1 && label) content = <LabelProperties label={label} />
    else if (selection.size === 1 && directive) content = <DirectiveProperties directive={directive} />
    else if (selection.size === 1 && wire) content = <WireProperties wireId={wire.id} />
    else
      content = (
        <p className="text-sm text-muted-foreground">{t('properties.multiple', { count: selection.size })}</p>
      )
  }
  return <div className="h-full overflow-auto p-3">{content}</div>
}

const RATINGS: { key: string; label: string; unit: string; hint: string }[] = [
  { key: 'voltage', label: 'Voltage', unit: 'V', hint: 'Rated voltage (peak)' },
  { key: 'current', label: 'Current', unit: 'A', hint: 'Rated current (RMS)' },
  { key: 'power', label: 'Power', unit: 'W', hint: 'Rated power dissipation' },
  { key: 'isat', label: 'Isat', unit: 'A', hint: 'Saturation current of an inductor (peak)' },
  { key: 'tj_max', label: 'Tj max', unit: '°C', hint: 'Maximum junction / hot-spot temperature' },
  { key: 'rth', label: 'Rth', unit: 'K/W', hint: 'Thermal resistance to ambient (Tj = Ta + P·Rth)' },
]

/** Ratings of a placed library component (the instance's own values override them). */
function blockRatings(instance: Instance): Record<string, string> {
  const { project } = useProject.getState()
  const block = project?.sheets.find((s) => `${BLOCK}${s.name}` === instance.symbol)
  return block?.component?.ratings ?? {}
}

/** Rated values checked by the stress analysis after an OP or transient run (FR-SIM-7). */
function RatingRows({ instance }: { instance: Instance }) {
  const { sheetName, execute } = useProject()
  const stress = useSimulation((s) => s.stress)
  const inherited = blockRatings(instance)
  const own = instance.ratings ?? {}
  // The checked quantity of each rating (the temperature check uses Tj max).
  const used = new Map(
    (stress?.items ?? [])
      .filter((i) => i.ref === instance.ref)
      .map((i) => [i.quantity === 'temperature' ? 'tj_max' : (i.quantity as string), i]),
  )
  const set = (key: string, value: string) => {
    const ratings = { ...own }
    if (value.trim()) ratings[key] = value.trim()
    else delete ratings[key]
    void execute({ type: 'update_instance', sheet: sheetName, id: instance.id, ratings })
  }
  return (
    <>
      {RATINGS.map(({ key, label, unit, hint }) => {
        const item = used.get(key)
        return (
          <Row key={key} label={label} title={hint}>
            <div className="flex items-center gap-2">
              <Field
                label={`Rated ${label}`}
                value={own[key] ?? ''}
                placeholder={inherited[key] ? `${inherited[key]} (part)` : 'not rated'}
                unit={unit}
                onCommit={(v) => set(key, v)}
              />
              {item && (
                <span
                  className={`shrink-0 font-mono text-xs ${item.status === 'over' ? 'text-destructive' : item.status === 'margin' ? 'text-orange-500' : 'text-muted-foreground'}`}
                  title={item.message}
                >
                  {Math.round(item.usage)} %
                </span>
              )}
            </div>
          </Row>
        )
      })}
      <p className="text-[11px] text-muted-foreground">
        After an operating point or transient run, parts used beyond the margin (project settings) are marked
        orange, beyond the rating red.
      </p>
    </>
  )
}

/** How much of each rating a design may use (project settings, FR-SIM-7). */
function StressRuleRows() {
  const { project, execute } = useProject()
  const rules = project?.stress ?? { voltage: 80, current: 80, power: 50, temperature: 25, ambient: 25 }
  const rows: { key: keyof typeof rules; label: string; unit: string; hint: string }[] = [
    { key: 'voltage', label: 'Voltage', unit: '%', hint: 'Part of the rated voltage a design may use' },
    { key: 'current', label: 'Current', unit: '%', hint: 'Part of the rated current (and Isat)' },
    { key: 'power', label: 'Power', unit: '%', hint: 'Part of the rated power' },
    { key: 'temperature', label: 'Tj below max', unit: 'K', hint: 'Kelvins below the maximum temperature' },
    { key: 'ambient', label: 'Ambient', unit: '°C', hint: 'Ambient temperature for Tj = Ta + P·Rth' },
  ]
  return (
    <>
      {rows.map(({ key, label, unit, hint }) => (
        <Row key={key} label={label} title={hint}>
          <Field
            label={`Stress margin ${label}`}
            value={String(rules[key])}
            unit={unit}
            validate={(v) => (Number.isFinite(Number(v.replace(',', '.'))) ? null : 'a number')}
            onCommit={(v) =>
              void execute({
                type: 'set_stress_rules',
                rules: { ...rules, [key]: Number(v.replace(',', '.')) },
              })
            }
          />
        </Row>
      ))}
    </>
  )
}
