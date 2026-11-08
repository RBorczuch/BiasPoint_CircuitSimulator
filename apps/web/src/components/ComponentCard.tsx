/**
 * Component card (FR-CMP): metadata, ratings, the equivalent circuit and its characteristics
 * computed by simulation (|Z|(f), phase, ESR(f), C(V), L(I), I-V; for diodes and transistors
 * their datasheet curves) with the source points; another component of the same kind can be
 * overlaid for comparison.
 */
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { create } from 'zustand'
import { apiGet, apiPost } from '@/api/client'
import type { Characteristic } from '@/api/types'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTheme } from '@/lib/theme'
import { useProject } from '@/store/project'
import { CHART_AXES, CHART_COLORS, type ChartSeries, CurveChart, FAMILY_COLORS } from './CurveChart'

export interface CardCurve {
  name: string
  x_unit: string
  y_unit: string
  x: number[]
  y: number[]
  label?: string // member of a family ("Ib = 20 µA")
}

/** Chart series of the curves of one name: one line, or a family named at the line ends. */
export function curveSeries(
  curves: CardCurve[],
  label: string,
  color: string,
  dashed = false,
): ChartSeries[] {
  if (curves.length === 1 && !curves[0].label)
    return [{ label, x: curves[0].x, y: curves[0].y, color, dashed }]
  return curves.map((c, i) => ({
    label: dashed ? `${c.label} (${label})` : c.label || label,
    x: c.x,
    y: c.y,
    color: FAMILY_COLORS[i % FAMILY_COLORS.length],
    dashed,
    endLabel: !dashed,
  }))
}

export interface CardData {
  curves: CardCurve[]
  sources: Characteristic[]
  notes: string[]
  circuit: string
  parameters: Record<string, string>
  labels?: Record<string, string> // parameter -> form label
}

/** A library component, or a placed one (a sheet of the open project with its overrides). */
export type CardSubject =
  | { component: string }
  | { project_id: string; sheet: string; params: Record<string, string> }

export function useCard(subject: CardSubject | null) {
  const theme = useTheme((s) => s.theme)
  return useQuery({
    queryKey: ['card', subject, theme],
    queryFn: () => apiPost<CardData>('/api/components/card', { ...subject, theme }),
    enabled: subject !== null,
    staleTime: 60_000,
    retry: false,
  })
}

const ORDER = [
  '|Z|(f)',
  'phase(f)',
  'ESR(f)',
  'I-V forward',
  'I-V reverse',
  'Ic(Vce)',
  'Id(Vds)',
  'Ic(Vbe)',
  'Id(Vgs)',
  'Vgs(Qg)',
  'h21(f)',
  'hFE(Ic)',
  'C(V)',
  'L(I)',
  'I-V',
]

/** Curves of a filled-in template: from the formulas (built-in passives, instant) or by
 *  simulation (``tpl:`` templates: diodes, transistors...). Used by the inspector. */
export function useTemplateCurves(template: string | null, form: Record<string, string>) {
  return useQuery({
    queryKey: ['template-curves', template, form],
    queryFn: async () =>
      template?.startsWith('tpl:')
        ? (await apiPost<CardData>('/api/components/templates/card', { template, form })).curves
        : apiPost<CardCurve[]>('/api/components/templates/preview', { template, form }),
    enabled: template !== null,
    staleTime: 60_000,
    retry: false,
    placeholderData: (previous) => previous, // keep the old curves while the new ones come
  })
}

/** Charts of one card, optionally against a second one. */
export function CardCharts({
  card,
  other,
  labels = ['this part', 'compared'],
  compact = false,
}: {
  card: CardData
  other?: CardData
  labels?: [string, string]
  compact?: boolean
}) {
  const names = ORDER.filter((n) => card.curves.some((c) => c.name === n))
  return (
    <div className={compact ? 'flex flex-col gap-2' : 'grid gap-3 @2xl:grid-cols-2'}>
      {names.map((name) => {
        const axes = CHART_AXES[name]
        const mine = card.curves.filter((c) => c.name === name)
        const theirs = other?.curves.filter((c) => c.name === name) ?? []
        const series: ChartSeries[] = []
        if (mine.length) series.push(...curveSeries(mine, labels[0], CHART_COLORS[0]))
        if (theirs.length) series.push(...curveSeries(theirs, labels[1], CHART_COLORS[1], true))
        const source = card.sources.find((s) => s.name === name)
        if (source?.points.length)
          series.push({
            label: source.source || 'source points',
            x: source.points.map((p) => p[0]),
            y: source.points.map((p) => p[1]),
            color: CHART_COLORS[2],
            kind: 'points',
          })
        // Inductive/capacitive parts: |Z| and ESR over decades; ESR of a resistor too.
        const logY = axes.logY && series.every((s) => s.y.every((v) => v > 0))
        return (
          <CurveChart
            key={name}
            title={name}
            series={series}
            xUnit={axes.x}
            yUnit={axes.y}
            logX={axes.logX}
            logY={logY}
            height={compact ? 150 : 190}
          />
        )
      })}
    </div>
  )
}

const RATING_UNITS: Record<string, string> = {
  voltage: 'V',
  current: 'A',
  power: 'W',
  isat: 'A',
  tj_max: '°C',
  rth: 'K/W',
}

const META_LABELS: Record<string, string> = {
  manufacturer: 'Manufacturer',
  part_number: 'Part number',
  technology: 'Technology',
  package: 'Package',
  datasheet: 'Datasheet',
  voltage: 'Rated voltage',
  current: 'Rated current',
  power: 'Rated power',
  isat: 'Saturation current',
  tj_max: 'Max. temperature',
  rth: 'Thermal resistance',
}

/** The whole card: header, metadata, circuit, charts and a comparison picker. */
export function ComponentCard({
  subject,
  kind,
  compact = false,
}: {
  subject: CardSubject
  kind?: string // components of this kind are offered for comparison
  compact?: boolean
}) {
  const symbols = useProject((s) => s.symbols)
  const [compare, setCompare] = useState('')
  const { data, error, isFetching } = useCard(subject)
  const other = useCard(compare ? { component: compare } : null)
  const own = 'component' in subject ? subject.component : null
  const candidates = [...symbols.values()].filter(
    (s) => s.id.startsWith('cmp:') && s.id !== own && (!kind || s.kind === kind),
  )
  const info = own ? symbols.get(own) : undefined
  return (
    <div className="@container flex flex-col gap-3 text-sm">
      {info && !compact && <p className="text-xs text-muted-foreground">{info.description}</p>}
      {error && (
        <p className="text-xs text-destructive">{error instanceof Error ? error.message : String(error)}</p>
      )}
      {isFetching && !data && <p className="text-xs text-muted-foreground">Computing the characteristics…</p>}
      {data && (
        <>
          <div className={compact ? 'flex flex-col gap-2' : 'grid gap-3 @2xl:grid-cols-[1fr_1.4fr]'}>
            <div className="flex flex-col gap-2">
              {Object.keys(data.parameters).length > 0 && (
                <table className="w-fit text-xs">
                  <tbody>
                    {Object.entries(data.parameters).map(([k, v]) => (
                      <tr key={k}>
                        <td className="pr-3 text-muted-foreground" title={k}>
                          {data.labels?.[k] ?? k}
                        </td>
                        <td className="font-mono">{v}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {data.circuit && (
                <div
                  className="overflow-hidden rounded border bg-background [&>svg]:h-auto [&>svg]:max-h-48 [&>svg]:w-full"
                  title="Equivalent circuit"
                  // biome-ignore lint/security/noDangerouslySetInnerHtml: SVG drawn by the backend from the sheet
                  dangerouslySetInnerHTML={{ __html: data.circuit }}
                />
              )}
            </div>
            <CardCharts
              card={data}
              other={compare ? other.data : undefined}
              labels={[info?.name ?? 'this part', symbols.get(compare)?.name ?? 'compared']}
              compact={compact}
            />
          </div>
          {data.notes.map((note) => (
            <p key={note} className="text-[11px] text-muted-foreground">
              {note}
            </p>
          ))}
          {candidates.length > 0 && (
            <label className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground">Compare with</span>
              <select
                aria-label="Compare with"
                className="h-7 min-w-0 flex-1 rounded-md border bg-background px-2"
                value={compare}
                onChange={(e) => setCompare(e.target.value)}
              >
                <option value="">—</option>
                {candidates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.category})
                  </option>
                ))}
              </select>
            </label>
          )}
          {other.error && compare && <p className="text-xs text-destructive">{String(other.error)}</p>}
        </>
      )}
    </div>
  )
}

/** Metadata and ratings as rows (empty values left out). */
export function MetadataRows({
  metadata,
  ratings,
}: {
  metadata: Record<string, string>
  ratings: Record<string, string>
}) {
  const withUnit = ([k, v]: [string, string]): [string, string] =>
    RATING_UNITS[k] && /^[\d.,]+[a-zµ]?$/i.test(v.trim()) ? [k, `${v} ${RATING_UNITS[k]}`] : [k, v]
  const rows = [...Object.entries(metadata), ...Object.entries(ratings).map(withUnit)].filter(([, v]) => v)
  if (!rows.length) return null
  return (
    <table className="w-fit text-xs">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <td className="pr-3 text-muted-foreground">{META_LABELS[k] ?? k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

interface LibraryComponent {
  id: string
  name: string
  kind: string
  description: string
  metadata: Record<string, string>
  ratings: Record<string, string>
  version: number
  updated: string
  template?: { name: string } | null
}

const useCardDialog = create<{ id: string | null; show: (id: string | null) => void }>((set) => ({
  id: null,
  show: (id) => set({ id }),
}))

/** Show the card of library component ``id`` in a dialog. */
export const showComponentCard = (id: string) => useCardDialog.getState().show(id)

export function ComponentCardDialog() {
  const id = useCardDialog((s) => s.id)
  const { data: components } = useQuery({
    queryKey: ['library-components', id],
    queryFn: () => apiGet<Record<string, LibraryComponent>>('/api/library/components'),
    enabled: id !== null,
  })
  if (!id) return null
  const info = components?.[id]
  return (
    <Dialog open onOpenChange={(open) => !open && useCardDialog.getState().show(null)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <DialogHeader>
          <DialogTitle>{info?.name ?? id}</DialogTitle>
          <DialogDescription>
            {info
              ? `${info.kind} · version ${info.version}${info.updated ? ` (${info.updated})` : ''}${info.template ? ` · from the ${info.template.name} template` : ''}`
              : 'Loading…'}
          </DialogDescription>
        </DialogHeader>
        {info && <MetadataRows metadata={info.metadata} ratings={info.ratings} />}
        <ComponentCard subject={{ component: id }} kind={info?.kind} />
      </DialogContent>
    </Dialog>
  )
}
