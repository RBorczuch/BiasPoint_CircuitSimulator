/**
 * Inspector rows of passive parts (FR-CMP-5). An ideal R, C or L shows its quick model (the
 * parasitic fields, filling them makes it "Real") beside a list of real parts from the
 * libraries with the chosen one's card; a placed real part shows its card and can go back to
 * an ideal one with the values the quick model keeps. A built-in diode or transistor offers
 * real parts drawn the same way and a component made from its SPICE model (FR-CMP-9).
 * Both show the part's characteristics as it is set (|Z|(f) from the values; I-V, output and
 * transfer curves from the model), updated when a value changes.
 */
import { type ReactNode, useState } from 'react'
import { toast } from 'sonner'
import type { Instance, SymbolDef } from '@/api/types'
import { CardCharts, ComponentCard, MetadataRows, useTemplateCurves } from '@/components/ComponentCard'
import { openComponentWizard } from '@/components/ComponentWizard'
import { Button } from '@/components/ui/button'
import { parasiticValues } from '@/lib/parasitics'
import { DEVICE_TEMPLATE, modelForm, QUICK, quickForm, toIdealPart, toRealPart } from '@/lib/realParts'
import { useProject } from '@/store/project'

/** Characteristics of the selected part as it is set (template ``template`` with ``form``). */
function PartCurves({
  template,
  form,
  only,
  note,
}: {
  template: string
  form: Record<string, string>
  only?: string[]
  note?: string
}) {
  const { data, error, isFetching } = useTemplateCurves(template, form)
  const curves = (data ?? []).filter((c) => !only || only.includes(c.name))
  return (
    <div className="flex flex-col gap-1" data-testid="part-curves">
      <span className="text-xs text-muted-foreground">
        Characteristics{isFetching ? ' (computing…)' : ''}
        {note ? ` · ${note}` : ''}
      </span>
      {error ? (
        <p className="text-xs text-destructive">{error instanceof Error ? error.message : String(error)}</p>
      ) : (
        curves.length > 0 && (
          <CardCharts
            card={{ curves, sources: [], notes: [], circuit: '', parameters: {} }}
            labels={['this part', '']}
            compact
          />
        )
      )}
    </div>
  )
}

/** Ideal part: quick model (``children``) and real parts of the same kind from the libraries. */
export function IdealPartRows({
  symbol,
  instances,
  children,
}: {
  symbol: SymbolDef
  instances: Instance[]
  children: ReactNode
}) {
  const { symbols, sheetName, execute } = useProject()
  const [picked, setPicked] = useState('')
  const quick = QUICK[symbol.id]
  const first = instances[0]
  const real = parasiticValues(symbol, first).length > 0
  const parts = quick
    ? [...symbols.values()].filter((s) => s.id.startsWith('cmp:') && s.kind === quick.kind)
    : []
  const use = async () => {
    const part = symbols.get(picked)
    await execute({
      type: 'transaction',
      label: `use ${part?.name ?? picked}`,
      commands: instances.flatMap((i) => toRealPart(sheetName, i, picked)),
    })
    setPicked('')
  }
  // Sources and other parts with parasitics but no real parts to choose: just the fields.
  if (!quick) return <>{children}</>
  const makeComponent = () =>
    quick &&
    openComponentWizard({
      template: quick.template,
      form: quickForm(
        symbol.id,
        { ...symbol.default_params, ...first.model.params },
        symbol.parasitics.map((p) => p.key),
      ),
      name: `${first.ref}_${(first.model.params[quick.param] ?? symbol.default_params[quick.param] ?? '').replace(/\W/g, '')}`,
      replace: instances.length === 1 ? { sheet: sheetName, id: first.id } : undefined,
    })
  return (
    <div className="@container">
      <div className="grid gap-3 @lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-xs">
            <span
              className={`mr-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase ${real ? 'bg-amber-500/15 text-amber-700 dark:text-amber-400' : 'bg-muted text-muted-foreground'}`}
            >
              {real ? 'Real' : 'Ideal'}
            </span>
            {real ? 'quick model of losses and resonance' : 'fill in a value below to make it real'}
          </p>
          {children}
          {quick && (
            <Button variant="outline" size="sm" className="self-start" onClick={makeComponent}>
              Make a part from these values…
            </Button>
          )}
          {quick && instances.length === 1 && (
            <PartCurves
              template={quick.template}
              form={quickForm(
                symbol.id,
                { ...symbol.default_params, ...first.model.params },
                symbol.parasitics.map((p) => p.key),
              )}
              only={['|Z|(f)', 'ESR(f)']}
            />
          )}
        </div>
        {quick && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs text-muted-foreground">Real part from a library</span>
              <select
                aria-label="Real part"
                className="h-8 w-full rounded-md border bg-background px-2"
                value={picked}
                onChange={(e) => setPicked(e.target.value)}
              >
                <option value="">
                  {parts.length ? 'choose a part…' : `no ${quick.kind}s in the libraries yet`}
                </option>
                {parts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.category}
                  </option>
                ))}
              </select>
            </label>
            {picked && (
              <>
                <Button size="sm" className="self-start" onClick={() => void use()}>
                  Use {symbols.get(picked)?.name}
                </Button>
                <ComponentCard subject={{ component: picked }} kind={quick.kind} compact />
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

/** Built-in diode / transistor: real parts drawn like it, or a component from its model. */
export function DevicePartRows({ symbol, instances }: { symbol: SymbolDef; instances: Instance[] }) {
  const { project, symbols, sheetName, execute, libraryModels } = useProject()
  const [picked, setPicked] = useState('')
  const first = instances[0]
  const template = DEVICE_TEMPLATE[symbol.id]
  if (!template) return null
  const drawing = JSON.stringify(symbol.graphics)
  const parts = [...symbols.values()].filter(
    (s) => s.id.startsWith('cmp:') && JSON.stringify(s.graphics) === drawing,
  )
  const modelName = first.model.model ?? symbol.default_model
  const card = modelName ? (project?.models[modelName] ?? libraryModels.models[modelName]) : undefined
  const makeComponent = () =>
    openComponentWizard({
      template,
      form: card ? modelForm(card.params, symbol.spice?.element) : {},
      name: modelName ? `${modelName}_part` : `${first.ref}_part`,
      replace: instances.length === 1 ? { sheet: sheetName, id: first.id } : undefined,
    })
  const use = async () => {
    await execute({
      type: 'transaction',
      label: `use ${symbols.get(picked)?.name ?? picked}`,
      commands: instances.flatMap((i) => toRealPart(sheetName, i, picked)),
    })
    setPicked('')
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        A real part has a card with its characteristics (I-V, output and transfer curves) and its values in a
        form.
      </p>
      <Button variant="outline" size="sm" className="self-start" onClick={makeComponent}>
        {card ? `Make a part from model ${modelName}…` : 'Make a part from a model…'}
      </Button>
      <label className="flex flex-col gap-1 text-sm">
        <span className="text-xs text-muted-foreground">Real part from a library</span>
        <select
          aria-label="Real part"
          className="h-8 w-full rounded-md border bg-background px-2"
          value={picked}
          onChange={(e) => setPicked(e.target.value)}
        >
          <option value="">{parts.length ? 'choose a part…' : 'no such parts in the libraries yet'}</option>
          {parts.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.category}
            </option>
          ))}
        </select>
      </label>
      {picked ? (
        <>
          <Button size="sm" className="self-start" onClick={() => void use()}>
            Use {symbols.get(picked)?.name}
          </Button>
          <ComponentCard
            subject={{ component: picked }}
            kind={symbols.get(picked)?.kind ?? undefined}
            compact
          />
        </>
      ) : (
        instances.length === 1 && (
          <PartCurves
            template={template}
            form={card ? modelForm(card.params, symbol.spice?.element) : {}}
            note={card ? `model ${modelName}` : 'typical part'}
          />
        )
      )}
    </div>
  )
}

/** A placed library component: metadata, card, change to another part or back to ideal. */
export function RealPartRows({ instances }: { instances: Instance[] }) {
  const { project, symbols, sheetName, execute, info } = useProject()
  const [picked, setPicked] = useState('')
  const inst = instances[0]
  const block = project?.sheets.find((s) => `sheet:${s.name}` === inst.symbol)
  const component = block?.component
  if (!project || !block || !component || !info) return null
  const others = [...symbols.values()].filter(
    (s) => s.id.startsWith('cmp:') && s.kind === component.kind && s.id !== component.id,
  )
  const ideal = () => {
    const out = instances.map((i) =>
      toIdealPart(sheetName, i, project, (id) => (symbols.get(id)?.parasitics ?? []).map((p) => p.key)),
    )
    if (out.some((o) => o === null)) return
    const dropped = [...new Set(out.flatMap((o) => o?.dropped ?? []))]
    void execute({
      type: 'transaction',
      label: 'make ideal',
      commands: out.flatMap((o) => o?.commands ?? []),
    })
    if (dropped.length)
      toast.info(`The ideal part has no ${dropped.join(', ')}`, {
        description: 'Undo (Ctrl+Z) brings the real part back.',
      })
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs">
        <span className="mr-1.5 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 uppercase dark:text-emerald-400">
          Library part
        </span>
        {component.name} · {component.kind} · v{component.version}
      </p>
      {component.description && <p className="text-xs text-muted-foreground">{component.description}</p>}
      <MetadataRows metadata={component.metadata} ratings={component.ratings} />
      <ComponentCard
        subject={{ project_id: info.id, sheet: block.name, params: inst.model.params }}
        kind={component.kind}
      />
      <div className="flex flex-wrap items-center gap-2">
        {others.length > 0 && (
          <select
            aria-label="Change part"
            className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2 text-sm"
            value={picked}
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">change to another part…</option>
            {others.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} · {s.category}
              </option>
            ))}
          </select>
        )}
        {picked && (
          <Button
            size="sm"
            onClick={() =>
              void execute({
                type: 'transaction',
                label: `use ${symbols.get(picked)?.name ?? picked}`,
                commands: instances.flatMap((i) => toRealPart(sheetName, i, picked)),
              }).then(() => setPicked(''))
            }
          >
            Use it
          </Button>
        )}
        {component.kind in { resistor: 1, capacitor: 1, inductor: 1 } && (
          <Button variant="outline" size="sm" onClick={ideal}>
            Make ideal
          </Button>
        )}
      </div>
    </div>
  )
}
