import { Crosshair, Eye, EyeOff, Loader2, Play, Square } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { AnalysisKind, Simulation } from '@/api/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { runAction, useKeymap } from '@/keymap/keymap'
import { buildCard, FIELDS, type FieldDef, fieldUnit, parseCard } from '@/lib/cards'
import { formatDuration, quantityHint, toSpice } from '@/lib/units'
import { cn } from '@/lib/utils'
import { IssueList } from '@/panels/IssueList'
import { useEditor } from '@/store/editor'
import { useProject } from '@/store/project'
import { useSettings } from '@/store/settings'
import { useSimulation } from '@/store/simulation'

const KINDS: { kind: AnalysisKind; label: string; hint: string }[] = [
  { kind: 'op', label: 'OP', hint: 'DC operating point' },
  { kind: 'dc', label: 'DC', hint: 'DC sweep of a source' },
  { kind: 'ac', label: 'AC', hint: 'Small-signal frequency response' },
  { kind: 'tran', label: 'TRAN', hint: 'Time-domain (transient)' },
]

/** Simulator options with a field of their own; others go in "Other" as name=value. */
const OPTIONS: {
  key: string
  label: string
  hint: string
  placeholder: string
  unit?: string
  choices?: string[]
}[] = [
  {
    key: 'reltol',
    label: 'Rel. tolerance',
    hint: 'Relative accuracy of voltages and currents',
    placeholder: '0.001',
  },
  {
    key: 'abstol',
    label: 'Abs. current',
    hint: 'Smallest current that matters',
    placeholder: '1 pA',
    unit: 'A',
  },
  {
    key: 'vntol',
    label: 'Abs. voltage',
    hint: 'Smallest voltage that matters',
    placeholder: '1 µV',
    unit: 'V',
  },
  {
    key: 'gmin',
    label: 'Gmin',
    hint: 'Conductance added across junctions (larger helps a stubborn operating point)',
    placeholder: '1e-12',
    unit: 'S',
  },
  {
    key: 'itl1',
    label: 'OP iterations',
    hint: 'Newton iterations allowed for the operating point',
    placeholder: '100',
  },
  { key: 'itl4', label: 'Step iterations', hint: 'Iterations per transient time step', placeholder: '10' },
  {
    key: 'method',
    label: 'Integration',
    hint: 'Transient: trapezoidal (accurate) or Gear (damps numerical ringing)',
    placeholder: 'trap',
    choices: ['', 'trap', 'gear'],
  },
]

/** Commit pending form edits to the project (one undo step); returns the simulation used. */
export async function commitSimulation(draft: Simulation): Promise<void> {
  const current = useProject.getState().project?.simulation
  if (current && JSON.stringify(current) === JSON.stringify(draft)) return
  await useProject.getState().execute({ type: 'set_simulation', simulation: draft })
}

/** Value with a unit ("10 ms", "1 MHz"): edited as text, applied on Enter or when leaving. */
function QuantityField({
  value,
  unit,
  placeholder,
  label,
  onCommit,
}: {
  value: string
  unit: string
  placeholder?: string
  label: string
  onCommit: (text: string, run: boolean) => void
}) {
  const [text, setText] = useState(value)
  useEffect(() => {
    setText(value)
  }, [value])
  const { ok, hint } = quantityHint(text, unit)
  return (
    <div>
      <div className="relative">
        <Input
          aria-label={label}
          className={cn('h-8 pr-9 font-mono', !ok && 'border-destructive')}
          value={text}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text !== value && onCommit(text, false)}
          onKeyDown={(e) => e.key === 'Enter' && onCommit(text, true)}
        />
        {unit && (
          <span className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
            {unit}
          </span>
        )}
      </div>
      {hint && (
        <p className={cn('mt-0.5 text-[11px]', ok ? 'text-muted-foreground' : 'text-destructive')}>{hint}</p>
      )}
    </div>
  )
}

export function SimulationPanel() {
  const project = useProject((s) => s.project)
  const simulation = project?.simulation
  const { job, meta, log, showOp, setShowOp } = useSimulation()
  const last = log ?? meta // last finished run, failed ones included
  const problems = last?.messages?.filter((m) => m.severity !== 'info').length ?? 0
  const tool = useEditor((s) => s.tool.kind)
  const runKey = useKeymap((s) => s.bindings)()['sim.run']?.[0]
  const [draft, setDraft] = useState<Simulation | undefined>(simulation)
  useEffect(() => {
    setDraft(simulation)
  }, [simulation])

  // What a DC sweep can vary: sources and resistors of the top-level sheets, the temperature.
  const sweepChoices = useMemo(() => {
    const parts = (project?.sheets ?? [])
      .filter((s) => !s.owner && !s.labels.some((l) => l.kind === 'port'))
      .flatMap((s) => s.instances)
    const refs = (symbol: string) => parts.filter((i) => i.symbol === symbol).map((i) => i.ref)
    return {
      Sources: [...refs('bpt:vsource'), ...refs('bpt:isource')],
      Resistors: refs('bpt:resistor'),
      Other: ['TEMP'],
    }
  }, [project])
  const { opVoltages, opCurrents, opPower, update: updateSettings } = useSettings()

  if (!draft) return null
  const kind = draft.active
  const fields = parseCard(kind, draft.cards[kind] ?? '')
  const withField = (key: string, value: string): Simulation => ({
    ...draft,
    cards: { ...draft.cards, [kind]: buildCard(kind, { ...fields, [key]: value }) },
  })
  const setField = (key: string, value: string) => setDraft(withField(key, value))
  const commitDraft = (next: Simulation) => {
    setDraft(next)
    void commitSimulation(next)
  }
  const family = kind === 'dc' && Boolean(fields.source2)
  const toggleFamily = (on: boolean) => {
    const others = [...sweepChoices.Sources, ...sweepChoices.Resistors].filter((r) => r !== fields.source)
    const second = on
      ? {
          source2: others.find((r) => r.startsWith('I')) ?? others[0] ?? 'TEMP',
          start2: '0',
          stop2: '1',
          step2: '0.5',
        }
      : { source2: '', start2: '', stop2: '', step2: '' }
    commitDraft({ ...draft, cards: { ...draft.cards, dc: buildCard('dc', { ...fields, ...second }) } })
  }
  const options = draft.options ?? {}
  const otherOptions = Object.entries(options)
    .filter(([k]) => !OPTIONS.some((o) => o.key === k))
    .map(([k, v]) => `${k}=${v}`)
    .join(' ')
  const setOption = (key: string, value: string) => {
    const next = { ...options, [key]: value }
    if (!value) delete next[key]
    commitDraft({ ...draft, options: next })
  }
  const setOtherOptions = (text: string) => {
    const kept = Object.fromEntries(Object.entries(options).filter(([k]) => OPTIONS.some((o) => o.key === k)))
    for (const pair of text.split(/\s+/).filter(Boolean)) {
      const [key, ...rest] = pair.split('=')
      kept[key] = rest.join('=')
    }
    commitDraft({ ...draft, options: kept })
  }
  const sweepSelect = (field: FieldDef) => (
    <select
      aria-label={field.label}
      className="h-8 rounded-md border bg-background px-2 font-mono text-sm"
      value={fields[field.key]}
      // A choice is final: committed at once (a refresh in between would undo a draft).
      onChange={(e) => commitDraft(withField(field.key, e.target.value))}
    >
      {Object.values(sweepChoices).flat().includes(fields[field.key]) ? null : (
        <option>{fields[field.key]}</option>
      )}
      {Object.entries(sweepChoices).map(([group, refs]) =>
        refs.length ? (
          <optgroup key={group} label={group}>
            {refs.map((ref) => (
              <option key={ref} value={ref}>
                {ref === 'TEMP' ? 'TEMP (temperature)' : ref}
              </option>
            ))}
          </optgroup>
        ) : null,
      )}
    </select>
  )
  const running = job?.status === 'queued' || job?.status === 'running'
  // Stopped before simulating (ERC errors, empty circuit): explain until the next run.
  const blocked =
    job?.status === 'error' && !job.run_id
      ? job.issues.filter((i) => i.severity === 'error').length
        ? job.issues.filter((i) => i.severity === 'error')
        : [{ severity: 'error' as const, code: 'other', message: job.error ?? 'not simulated', refs: [] }]
      : null

  const run = async (next: Simulation = draft) => {
    await commitSimulation(next)
    runAction('sim.run')
  }
  const commitField = (key: string, text: string, andRun: boolean) => {
    const next = withField(key, text)
    setDraft(next)
    void (andRun ? run(next) : commitSimulation(next))
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-auto p-3 text-sm">
      <div className="grid grid-cols-4 gap-1 rounded-md bg-muted p-0.5">
        {KINDS.map((k) => (
          <button
            type="button"
            key={k.kind}
            title={k.hint}
            onClick={() => {
              // The chosen analysis is what F5 and the toolbar run: save it right away.
              const next = { ...draft, active: k.kind }
              setDraft(next)
              void commitSimulation(next)
            }}
            className={`rounded px-2 py-1 text-xs font-medium ${kind === k.kind ? 'bg-background shadow-sm' : 'text-muted-foreground'}`}
          >
            {k.label}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">{KINDS.find((k) => k.kind === kind)?.hint}</p>

      {FIELDS[kind].map((field) => (
        <div
          key={field.key}
          className={cn('grid grid-cols-[6.5rem_1fr] items-start gap-2', field.second && !family && 'hidden')}
        >
          <span className="pt-1.5 text-muted-foreground">{field.label}</span>
          {field.key === 'source' || field.key === 'source2' ? (
            sweepSelect(field)
          ) : field.options ? (
            <select
              className="h-8 rounded-md border bg-background px-2 font-mono text-sm"
              value={fields[field.key]}
              onChange={(e) => setField(field.key, e.target.value)}
              onBlur={() => commitSimulation(draft)}
            >
              {field.options.map((option) => (
                <option key={option}>{option}</option>
              ))}
            </select>
          ) : (
            <QuantityField
              label={field.label}
              value={fields[field.key] ?? ''}
              unit={fieldUnit(field, fields)}
              placeholder={field.placeholder}
              onCommit={(text, andRun) => commitField(field.key, text, andRun)}
            />
          )}
        </div>
      ))}
      {kind === 'dc' && (
        <label
          className="flex items-center gap-2 text-xs"
          title="Repeat the sweep for each value of a second source: one curve per value (e.g. Ic(Vce) for several base currents)"
        >
          <input type="checkbox" checked={family} onChange={(e) => toggleFamily(e.target.checked)} />
          Family of curves (sweep a second source)
        </label>
      )}
      {kind === 'op' && (
        <div
          className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs"
          title="What the operating point overlay shows"
        >
          <span className="text-muted-foreground">Show</span>
          {(
            [
              ['opVoltages', 'Voltages', opVoltages],
              ['opCurrents', 'Currents', opCurrents],
              ['opPower', 'Power', opPower],
            ] as const
          ).map(([key, label, on]) => (
            <label key={key} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={on}
                onChange={(e) => updateSettings({ [key]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      )}
      <div
        className="grid grid-cols-[6.5rem_1fr] items-start gap-2"
        title="Circuit temperature for every analysis"
      >
        <span className="pt-1.5 text-muted-foreground">Temperature</span>
        <QuantityField
          label="Temperature"
          value={draft.temperature ?? ''}
          unit="°C"
          placeholder="27"
          onCommit={(text, andRun) => {
            const next = { ...draft, temperature: text.replace(/\s*°?C$/i, '').trim() }
            setDraft(next)
            void (andRun ? run(next) : commitSimulation(next))
          }}
        />
      </div>
      <details className="rounded-md border px-2 py-1 text-xs" data-testid="sim-options">
        <summary className="cursor-pointer text-muted-foreground">
          Simulator options{Object.keys(options).length ? ` (${Object.keys(options).length} set)` : ''}
        </summary>
        <p className="mt-1 mb-2 text-muted-foreground">
          Empty = ngspice default. They apply to every analysis started here (.options).
        </p>
        <div className="flex flex-col gap-1.5">
          {OPTIONS.map((o) => (
            <div key={o.key} className="grid grid-cols-[6.5rem_1fr] items-start gap-2" title={o.hint}>
              <span className="pt-1.5 text-muted-foreground">{o.label}</span>
              {o.choices ? (
                <select
                  aria-label={o.label}
                  className="h-8 rounded-md border bg-background px-2 font-mono text-sm"
                  value={options[o.key] ?? ''}
                  onChange={(e) => setOption(o.key, e.target.value)}
                >
                  {o.choices.map((c) => (
                    <option key={c} value={c}>
                      {c || 'default'}
                    </option>
                  ))}
                </select>
              ) : (
                <QuantityField
                  label={o.label}
                  value={options[o.key] ?? ''}
                  unit={o.unit ?? ''}
                  placeholder={o.placeholder}
                  onCommit={(text) => setOption(o.key, text.trim() ? toSpice(text, o.unit ?? '') : '')}
                />
              )}
            </div>
          ))}
          <div className="grid grid-cols-[6.5rem_1fr] items-start gap-2">
            <span className="pt-1.5 text-muted-foreground">Other</span>
            <Input
              aria-label="Other options"
              className="h-8 font-mono"
              defaultValue={otherOptions}
              key={otherOptions}
              placeholder="name=value …"
              onBlur={(e) => e.target.value !== otherOptions && setOtherOptions(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setOtherOptions(e.currentTarget.value)}
            />
          </div>
        </div>
      </details>
      <code className="truncate rounded bg-muted px-2 py-1 text-xs">{draft.cards[kind]}</code>

      <div className="flex gap-2">
        {running ? (
          <Button variant="destructive" className="flex-1" onClick={() => runAction('sim.cancel')}>
            <Square /> Stop
          </Button>
        ) : (
          <Button className="flex-1" onClick={() => run()}>
            <Play /> Run {runKey && <kbd className="ml-1 text-xs opacity-70">{runKey}</kbd>}
          </Button>
        )}
        <Button
          variant={tool === 'probe' ? 'secondary' : 'outline'}
          size="icon"
          title="Probe tool: click a wire (voltage) or a part (current)"
          onClick={() => runAction(tool === 'probe' ? 'tool.select' : 'sim.probe')}
        >
          <Crosshair />
        </Button>
        <Button
          variant="outline"
          size="icon"
          title="Show operating point on the schematic"
          onClick={() => setShowOp(!showOp)}
        >
          {showOp ? <Eye /> : <EyeOff />}
        </Button>
      </div>

      <div className="rounded-md border p-2 text-xs">
        {blocked ? (
          <div>
            <p className="mb-1 font-medium text-destructive">Not simulated – fix the circuit first:</p>
            <IssueList issues={blocked} hints />
          </div>
        ) : running ? (
          <p className="flex items-center gap-2">
            <Loader2 className="size-3 animate-spin" /> {job?.progress || 'starting…'}
          </p>
        ) : last ? (
          <p className={last.status === 'ok' ? '' : 'text-destructive'}>
            {last.analysis.kind.toUpperCase()} · {last.status} · {last.points}{' '}
            {last.points === 1 ? 'point' : 'points'} · {formatDuration(last.duration_s)}
            {last.error ? ` · ${last.error}` : ''}
          </p>
        ) : (
          <p className="text-muted-foreground">No results yet.</p>
        )}
        {last && last.log.length > 0 && (
          <button
            type="button"
            className="mt-1 text-muted-foreground underline"
            onClick={() => window.dispatchEvent(new CustomEvent('bpt:open-panel', { detail: 'log' }))}
          >
            Simulator log
            {problems > 0 ? ` (${problems} ${problems === 1 ? 'message' : 'messages'})` : ''}
          </button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Probe: click a wire for its voltage, a part for its current, Alt+click a two-terminal part for its
        power, Shift+click a net to set the reference of a differential probe.
      </p>
    </div>
  )
}
