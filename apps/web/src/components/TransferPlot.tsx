/**
 * The Bode plot of a transfer function block H(s) (FR-MOD-8), from its expression as typed:
 * the magnitude and phase the simulator will give it, or why the expression cannot be read.
 */
import { useEffect, useState } from 'react'
import { apiPost } from '@/api/client'
import { CHART_COLORS, CurveChart } from './CurveChart'

interface Preview {
  num: number[]
  den: number[]
  error: string
  f: number[]
  magnitude_db: number[]
  phase: number[]
}

const poly = (c: number[]) =>
  c
    .map((v, i) => {
      const power = c.length - 1 - i
      const coefficient = Number(v.toPrecision(4))
      return power === 0 ? `${coefficient}` : `${coefficient}·s${power > 1 ? `^${power}` : ''}`
    })
    .join(' + ')
    .replace(/\+ -/g, '− ')

export function TransferPlot({ h }: { h: string }) {
  const [preview, setPreview] = useState<Preview | null>(null)
  useEffect(() => {
    let current = true
    const timer = setTimeout(() => {
      apiPost<Preview>('/api/components/transfer', { h })
        .then((p) => current && setPreview(p))
        .catch(
          (e) =>
            current && setPreview({ num: [], den: [], error: String(e), f: [], magnitude_db: [], phase: [] }),
        )
    }, 150)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [h])
  if (!preview) return null
  if (preview.error)
    return (
      <p className="px-1 text-xs text-destructive" data-testid="transfer-error">
        H(s): {preview.error}
      </p>
    )
  return (
    <div className="flex flex-col gap-1 px-1" data-testid="transfer-plot">
      <p className="font-mono text-[11px] break-all text-muted-foreground">
        ({poly(preview.num)}) / ({poly(preview.den)})
      </p>
      <CurveChart
        title="|H|(f)"
        series={[{ label: '|H|', x: preview.f, y: preview.magnitude_db, color: CHART_COLORS[0] }]}
        xUnit="Hz"
        yUnit="dB"
        logX
        height={140}
      />
      <CurveChart
        title="phase(f)"
        series={[{ label: 'phase', x: preview.f, y: preview.phase, color: CHART_COLORS[1] }]}
        xUnit="Hz"
        yUnit="°"
        logX
        height={110}
      />
    </div>
  )
}
