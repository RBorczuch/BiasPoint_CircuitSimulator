/**
 * Points from the datasheet for one characteristic (docs/projekt-kreator.md §7): a table (each
 * row checked, a point left out of the fit without deleting it, a bad value shown with why) or
 * the text as typed; paste whole columns from a spreadsheet, a CSV or a text file. The text stays
 * the source: the table edits its lines.
 */
import { X } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { pointRows, withLine } from '@/lib/points'

/** What the points of each characteristic are, as the datasheet gives them. */
export const POINTS_HELP: Record<string, { explain: string; example: string }> = {
  '|Z|(f)': {
    explain: 'Impedance magnitude against frequency, from the datasheet’s |Z|(f) chart.',
    example: '1k 16\n100k 0.17\n10meg 0.08',
  },
  'phase(f)': {
    explain: 'Phase of the impedance in degrees against frequency.',
    example: '1k -89\n1meg 0\n10meg 85',
  },
  'ESR(f)': {
    explain: 'ESR against frequency (the ESR chart or table).',
    example: '100 0.5\n1k 0.12\n100k 0.03',
  },
  'C(V)': {
    explain: 'Capacitance against DC bias. Given in ΔC %? Type the percentages and convert them below.',
    example: '0 10u\n5 6u\n10 3.5u',
  },
  'L(I)': { explain: 'Inductance against DC current (the saturation chart).', example: '0 10u\n1 9u\n2 6u' },
  'VF(IF)': {
    explain: 'Forward voltage at forward current, as in the datasheet’s VF(IF) figure.',
    example: '1m 0.62\n10m 0.75\n100m 0.95',
  },
  'Cj(VR)': { explain: 'Junction capacitance against reverse voltage.', example: '0 4p\n5 2p\n20 1.2p' },
  'VZ(IZ)': { explain: 'Zener voltage against Zener current.', example: '1m 5.0\n5m 5.1\n50m 5.3' },
  'Id(Vgs)': {
    explain: 'Drain current against gate voltage (the transfer characteristic).',
    example: '2 0.01\n3 0.2\n4 0.8',
  },
  'RDS(Vgs)': { explain: 'On-resistance against gate voltage.', example: '4.5 0.03\n10 0.022' },
  'hFE(Ic)': {
    explain: 'Current gain against collector current, at the Vce given.',
    example: '100u 250\n10m 300\n100m 200',
  },
  'VBE(Ic)': {
    explain: 'Base-emitter voltage against collector current.',
    example: '1m 0.62\n10m 0.7\n100m 0.82',
  },
  'VCEsat(Ic)': {
    explain: 'Saturation voltage against collector current, at the forced β given.',
    example: '10m 0.09\n100m 0.2',
  },
  'Id(Vds)': {
    explain: 'Drain current against drain voltage: one curve of the output family, at the Vgs given.',
    example: '1 0.8\n5 1.6\n10 1.7',
  },
  'Ic(Vce)': {
    explain: 'Collector current against collector voltage: one curve of the output family, at the Ib given.',
    example: '1 0.15\n5 0.16\n10 0.17',
  },
  'Ratio(f)': {
    explain: 'Secondary to primary voltage against frequency, the secondary open.',
    example: '100 0.5\n10k 0.5\n1meg 0.45',
  },
  '|Zin|(f)': {
    explain: 'Impedance of the primary against frequency, the secondary open.',
    example: '100 0.7\n1k 6.3\n10k 63',
  },
  'h21(f)': {
    explain: 'Small-signal current gain against frequency (|hfe|): β at low frequency, 1 at fT.',
    example: '1k 150\n10meg 28\n100meg 2.8',
  },
  'Aol(f)': {
    explain: 'Open-loop gain in dB against frequency, from the datasheet’s gain plot.',
    example: '1 106\n100 80\n10k 40\n1meg 0',
  },
}

// Prefixes a bare number typed in a column gets (SPICE suffixes).
const PREFIXES: [string, string][] = [
  ['', ''],
  ['k', 'k'],
  ['M', 'meg'],
  ['m', 'm'],
  ['µ', 'u'],
  ['n', 'n'],
  ['p', 'p'],
]
const BARE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i

export function PointsEditor({
  kind,
  text,
  onText,
  columns,
  view,
  onView,
  onPicture,
  onCsv,
}: {
  kind: string
  text: string
  onText: (text: string) => void
  columns: [string, string] // "frequency [Hz]", "impedance [Ω]"
  view: 'table' | 'text'
  onView: (view: 'table' | 'text') => void
  onPicture: () => void
  onCsv: () => void
}) {
  const help = POINTS_HELP[kind]
  const rows = pointRows(text)
  const [prefix, setPrefix] = useState<[string, string]>(['', ''])
  const [draft, setDraft] = useState<[string, string]>(['', ''])
  const [askWeights, setAskWeights] = useState(false)
  // Hidden unless asked for, or some point has one that means something (0 is the "fit" box).
  const weights = askWeights || rows.some((r) => r.weight !== 0 && r.weight !== 1)
  const unit = (col: string) => /\[(.*)\]/.exec(col)?.[1] ?? ''
  const name = (col: string) => col.replace(/\s*\[.*\]/, '')
  const withPrefix = (value: string, k: 0 | 1) =>
    BARE.test(value.trim()) ? value.trim() + prefix[k] : value.trim()
  const setCell = (line: number, cols: string[], k: number, value: string) => {
    const next = [...cols]
    next[k] = k < 2 ? withPrefix(value, k as 0 | 1) : value
    onText(withLine(text, line, next.filter((c, i) => i < 2 || c !== '').join(' ')))
  }
  const toggle = (line: number, cols: string[], fitted: boolean) => {
    const next = cols.slice(0, 2)
    if (fitted) next.push('0') // left out of the fit, still shown
    onText(withLine(text, line, next.join(' ')))
  }
  const append = (lines: string) => onText(text.trim() ? `${text.replace(/\s+$/, '')}\n${lines}` : lines)
  const addDraft = () => {
    if (!draft[0].trim() || !draft[1].trim()) return
    append(`${withPrefix(draft[0], 0)} ${withPrefix(draft[1], 1)}`)
    setDraft(['', ''])
  }
  const paste = async () => {
    try {
      const clip = await navigator.clipboard.readText()
      if (clip.trim()) append(clip.trim())
    } catch {
      // no clipboard access: Ctrl+V in the table works
    }
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1.5" data-testid={`points-${kind}`}>
      <div className="flex items-center gap-1 text-[11px]">
        <span className="text-muted-foreground">{help?.explain}</span>
        {view === 'table' && rows.length > 0 && (
          <button
            type="button"
            aria-pressed={weights}
            className={`ml-auto shrink-0 rounded border px-1.5 py-0.5 ${weights ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
            title="A column of weights: how much the fit minds each point"
            onClick={() => setAskWeights(!weights)}
          >
            Weights
          </button>
        )}
        <span
          className={`flex shrink-0 rounded border p-0.5 ${view === 'table' && rows.length > 0 ? '' : 'ml-auto'}`}
        >
          {(['table', 'text'] as const).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              className={`rounded px-1.5 ${view === v ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
              onClick={() => onView(v)}
            >
              {v === 'table' ? 'Table' : 'Text'}
            </button>
          ))}
        </span>
      </div>
      {view === 'text' ? (
        <Textarea
          aria-label={`Points ${kind}`}
          className="min-h-40 flex-1 font-mono text-xs"
          placeholder={help?.example ?? 'x y'}
          value={text}
          onChange={(e) => onText(e.target.value)}
        />
      ) : (
        // biome-ignore lint/a11y/noStaticElementInteractions: Ctrl+V of whole columns anywhere in the table
        <div
          className="min-h-0 flex-1 overflow-y-auto rounded-md border"
          onPaste={(e) => {
            const clip = e.clipboardData.getData('text')
            if (!clip.includes('\n') && !/[\t;]/.test(clip)) return // one value into one cell
            e.preventDefault()
            append(clip.trim())
          }}
        >
          <table className="w-full text-xs" aria-label={`Points ${kind} table`}>
            <thead className="sticky top-0 bg-background text-left text-[11px] text-muted-foreground">
              <tr>
                {columns.map((col, k) => (
                  <th key={col} className="px-1 py-0.5 font-normal">
                    <span className="flex items-center gap-1">
                      {name(col)}
                      <select
                        aria-label={`Unit of ${name(col)}`}
                        title="A number typed without a suffix gets this prefix"
                        className="rounded border bg-background px-0.5 text-[10px]"
                        value={prefix[k]}
                        onChange={(e) => {
                          const next: [string, string] = [...prefix] as [string, string]
                          next[k] = e.target.value
                          setPrefix(next)
                        }}
                      >
                        {PREFIXES.map(([shown, suffix]) => (
                          <option key={suffix} value={suffix}>
                            {shown}
                            {unit(col)}
                          </option>
                        ))}
                      </select>
                    </span>
                  </th>
                ))}
                {weights && (
                  <th
                    className="w-12 px-1 text-left font-normal"
                    title="How much the fit minds this point (1: as the others)"
                  >
                    weight
                  </th>
                )}
                <th className="w-6 font-normal" title="Fitted (unchecked: shown, left out of the fit)">
                  fit
                </th>
                <th className="w-5" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.line}
                  className={`border-t ${r.error ? 'bg-destructive/10' : r.weight === 0 ? 'opacity-50' : ''}`}
                  title={r.error || undefined}
                >
                  {[0, 1].map((k) => (
                    <td key={k} className="px-0.5">
                      <Input
                        aria-label={`Point ${rows.indexOf(r) + 1} ${k ? 'y' : 'x'}`}
                        className={`h-6 border-0 bg-transparent px-1 font-mono text-xs shadow-none ${r.error && ((k === 0 && r.x === null) || (k === 1 && r.y === null)) ? 'text-destructive' : ''}`}
                        defaultValue={r.cols[k] ?? ''}
                        key={`${r.line}:${r.cols[k]}`}
                        onBlur={(e) =>
                          e.target.value !== (r.cols[k] ?? '') && setCell(r.line, r.cols, k, e.target.value)
                        }
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      />
                    </td>
                  ))}
                  {weights && (
                    <td className="px-0.5">
                      <Input
                        aria-label={`Point ${rows.indexOf(r) + 1} weight`}
                        className="h-6 border-0 bg-transparent px-1 font-mono text-xs shadow-none"
                        placeholder="1"
                        defaultValue={r.cols[2] ?? ''}
                        key={`w${r.line}:${r.cols[2]}`}
                        disabled={Boolean(r.error)}
                        onBlur={(e) =>
                          e.target.value !== (r.cols[2] ?? '') &&
                          setCell(r.line, r.cols, 2, e.target.value.trim())
                        }
                        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      />
                    </td>
                  )}
                  <td className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`Fit point ${rows.indexOf(r) + 1}`}
                      checked={r.weight !== 0}
                      disabled={Boolean(r.error)}
                      onChange={() => toggle(r.line, r.cols, r.weight !== 0)}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="rounded p-0.5 text-muted-foreground hover:text-destructive"
                      aria-label={`Remove point ${rows.indexOf(r) + 1}`}
                      onClick={() => onText(withLine(text, r.line, null))}
                    >
                      <X className="size-3" />
                    </button>
                  </td>
                </tr>
              ))}
              <tr className="border-t">
                {[0, 1].map((k) => (
                  <td key={k} className="px-0.5">
                    <Input
                      aria-label={`New point ${k ? 'y' : 'x'}`}
                      className="h-6 px-1 font-mono text-xs"
                      placeholder={k ? 'y' : 'x'}
                      value={draft[k]}
                      onChange={(e) => {
                        const next: [string, string] = [...draft] as [string, string]
                        next[k] = e.target.value
                        setDraft(next)
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && addDraft()}
                    />
                  </td>
                ))}
                <td colSpan={weights ? 3 : 2}>
                  <button
                    type="button"
                    className="rounded px-1 text-muted-foreground hover:text-foreground"
                    onClick={addDraft}
                  >
                    + add
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
          {rows.length === 0 && (
            <div className="flex flex-col gap-2 p-2 text-[11px] text-muted-foreground">
              <span>
                No points yet. Paste columns from a spreadsheet or the datasheet (Ctrl+V here), read them off
                the chart, or import a CSV. For example:
              </span>
              <pre className="rounded bg-muted px-2 py-1 font-mono">{help?.example}</pre>
              <span className="flex flex-wrap gap-1">
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => void paste()}>
                  Paste
                </Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onPicture}>
                  Trace a picture…
                </Button>
                <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={onCsv}>
                  Import CSV…
                </Button>
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
