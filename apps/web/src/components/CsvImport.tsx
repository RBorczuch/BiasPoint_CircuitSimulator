/**
 * A CSV file (an instrument's export, a spreadsheet) into a characteristic's points: the columns
 * with the units found in their headers, the two to use, the first rows, and what was assumed
 * (a header's kHz scaled to Hz) before the points are taken.
 */
import { useEffect, useState } from 'react'
import { apiPost } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface Column {
  name: string
  unit: string
  scale: number
}

interface Summary {
  columns: Column[]
  rows: number
  preview: number[][]
  delimiter: string
  decimal_comma: boolean
  skipped: number
}

const DELIMITERS: Record<string, string> = { '\t': 'tab', ';': 'semicolon', ',': 'comma', ' ': 'spaces' }

export function CsvImport({
  text,
  kind,
  onClose,
  onPoints,
}: {
  text: string | null // the file's text; null: closed
  kind: string // the characteristic ("|Z|(f)")
  onClose: () => void
  onPoints: (points: [number, number][], notes: string[]) => void
}) {
  const [summary, setSummary] = useState<Summary | null>(null)
  const [error, setError] = useState('')
  const [x, setX] = useState(0)
  const [y, setY] = useState(1)
  useEffect(() => {
    if (text === null) return
    setSummary(null)
    setError('')
    setX(0)
    setY(1)
    apiPost<Summary>('/api/measurements/csv', { text })
      .then(setSummary)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [text])
  const take = async () => {
    if (text === null) return
    try {
      const got = await apiPost<{ points: [number, number][]; notes: string[] }>(
        '/api/measurements/csv/points',
        {
          text,
          kind,
          x,
          y,
        },
      )
      onPoints(got.points, got.notes)
      onClose()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  const label = (c: Column, k: number) =>
    `${k + 1}: ${c.name}${c.unit ? ` (${c.scale !== 1 ? `×${c.scale} ` : ''}${c.unit})` : ''}`
  return (
    <Dialog open={text !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl" data-testid="csv-import">
        <DialogHeader>
          <DialogTitle>Points from a CSV file</DialogTitle>
          <DialogDescription>
            Choose the columns for {kind}: units in the headers (f [kHz], |Z| (mOhm)) are converted.
          </DialogDescription>
        </DialogHeader>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {summary && (
          <div className="flex flex-col gap-2 text-xs">
            <p className="text-muted-foreground">
              {summary.rows} rows, {DELIMITERS[summary.delimiter] ?? summary.delimiter} between columns
              {summary.decimal_comma ? ', decimal comma' : ''}
              {summary.skipped ? `, ${summary.skipped} lines of text left out` : ''}.
            </p>
            <div className="flex flex-wrap gap-3">
              {(['x', 'y'] as const).map((axis) => (
                <label key={axis} className="flex items-center gap-1">
                  {axis === 'x' ? 'X column' : 'Y column'}
                  <select
                    aria-label={axis === 'x' ? 'X column' : 'Y column'}
                    className="h-7 rounded border bg-background px-1"
                    value={axis === 'x' ? x : y}
                    onChange={(e) => (axis === 'x' ? setX : setY)(Number(e.target.value))}
                  >
                    {summary.columns.map((c, k) => (
                      <option key={c.name + String(k)} value={k}>
                        {label(c, k)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
            <table className="w-full border text-left font-mono">
              <thead>
                <tr className="bg-muted/50">
                  {summary.columns.map((c, k) => (
                    <th
                      key={c.name + String(k)}
                      className={`px-1 font-normal ${k === x || k === y ? 'text-foreground' : 'text-muted-foreground'}`}
                    >
                      {c.name}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {summary.preview.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview rows in their file order
                  <tr key={r} className="border-t">
                    {row.map((v, k) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the columns in their order
                      <td key={k} className={`px-1 ${k === x || k === y ? '' : 'text-muted-foreground'}`}>
                        {v}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!summary || x === y} onClick={() => void take()}>
            Use {summary?.rows ?? 0} points
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
