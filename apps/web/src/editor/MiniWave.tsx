/** A small picture of a net's waveform next to the cursor (after a transient, DC or AC run). */
import { useEffect, useState } from 'react'
import { apiPost } from '@/api/client'
import type { QueryResult } from '@/api/types'
import { formatValue } from '@/lib/units'

const W = 150
const H = 44
const cache = new Map<string, QueryResult | null>()

export function MiniWave({ runId, signal, ac }: { runId: string; signal: string; ac: boolean }) {
  const key = `${runId}|${signal}`
  const [data, setData] = useState<QueryResult | null | undefined>(cache.get(key))
  useEffect(() => {
    if (cache.has(key)) {
      setData(cache.get(key))
      return
    }
    setData(undefined)
    // Wait a moment: moving over the sheet should not fire a query per wire passed.
    const timer = setTimeout(() => {
      apiPost<QueryResult>(`/api/runs/${runId}/query`, { signals: [signal], pixels: W })
        .then((result) => {
          cache.set(key, result)
          setData(result)
        })
        .catch(() => {
          cache.set(key, null)
          setData(null)
        })
    }, 250)
    return () => clearTimeout(timer)
  }, [key, runId, signal])
  if (!data) return null
  const series = data.series[signal]
  let ys: number[] = []
  if (series?.min && series.max) ys = series.min.flatMap((v, i) => [v, series.max?.[i] ?? v])
  else if (series?.re && series.im) {
    const im = series.im
    ys = series.re.map((re, i) => 20 * Math.log10(Math.max(Math.hypot(re, im[i]), 1e-30)))
  }
  if (ys.length < 2) return null
  const xs = series?.min ? data.x.flatMap((x) => [x, x]) : data.x
  const logX = ac
  const fx = (x: number) => (logX ? Math.log10(Math.max(x, 1e-30)) : x)
  const [x0, x1] = [fx(xs[0]), fx(xs[xs.length - 1])]
  const [lo, hi] = [Math.min(...ys), Math.max(...ys)]
  const span = hi - lo || 1
  const points = ys
    .map(
      (y, i) =>
        `${(((fx(xs[i]) - x0) / (x1 - x0 || 1)) * W).toFixed(1)},${(H - 2 - ((y - lo) / span) * (H - 4)).toFixed(1)}`,
    )
    .join(' ')
  const unit = ac ? 'dB' : 'V'
  return (
    <div className="mt-0.5" data-testid="mini-wave">
      <svg width={W} height={H} className="block text-primary" role="img" aria-label={`${signal} waveform`}>
        <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.2} />
      </svg>
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{formatValue(lo, unit, 3)}</span>
        <span>{formatValue(hi, unit, 3)}</span>
      </div>
    </div>
  )
}
