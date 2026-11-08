/** Charts at their extremes, without the rest of the program (chart-extremes.spec.ts). */
import { createRoot } from 'react-dom/client'
import { CHART_COLORS, type ChartSeries, CurveChart } from '@/components/CurveChart'
import { TooltipProvider } from '@/components/ui/tooltip'
import '@/index.css'

const decades = (from: number, to: number, perDecade = 10) => {
  const n = Math.round((to - from) * perDecade)
  return Array.from({ length: n + 1 }, (_x, i) => 10 ** (from + i / perDecade))
}
const line = (label: string, x: number[], y: number[], k = 0): ChartSeries => ({
  label,
  x,
  y,
  color: CHART_COLORS[k % CHART_COLORS.length],
})

const hertz = decades(1, 9)
const impedance = hertz.map((f) => Math.hypot(1 / (2 * Math.PI * f * 1e-6) - 2 * Math.PI * f * 1e-9, 0.01))
const volts = Array.from({ length: 60 }, (_x, i) => 0.3 + i * 0.012)
const amps = volts.map((v) => Math.min(1, 1e-9 * 10 ** ((v - 0.3) / 0.0576)))
const vce = Array.from({ length: 40 }, (_x, i) => (i * 12) / 39)
const family = [20e-6, 60e-6, 140e-6, 260e-6, 400e-6, 540e-6].map((ib, k) => ({
  ...line(
    `Ib = ${Math.round(ib * 1e6)} µA`,
    vce,
    vce.map((v) => ib * 150 * (1 - Math.exp(-v / 0.2)) * (1 + v / 80)),
    k,
  ),
  endLabel: true,
}))
const degrees = hertz.map((f) => -90 + 180 / (1 + (5e6 / f) ** 2))

function Case({ name, width, children }: { name: string; width: number; children: React.ReactNode }) {
  return (
    <div style={{ width }} data-testid={`case-${name}`}>
      {children}
    </div>
  )
}

const root = document.getElementById('root')
if (!root) throw new Error('#root element missing')
createRoot(root).render(
  <TooltipProvider>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, padding: 16, background: 'var(--background)' }}>
      <Case name="wide-frequency" width={560}>
        <CurveChart
          title="10 Hz to 1 GHz"
          series={[line('model', hertz, impedance)]}
          xUnit="Hz"
          yUnit="Ω"
          logX
          logY
        />
      </Case>
      <Case name="nine-decades" width={560}>
        <CurveChart title="1 nA to 1 A" series={[line('model', volts, amps)]} xUnit="V" yUnit="A" logY />
      </Case>
      <Case name="family" width={560}>
        <CurveChart title="Six curves" series={family} xUnit="V" yUnit="A" height={260} />
      </Case>
      <Case name="narrow" width={280}>
        <CurveChart
          title="Narrow"
          series={[
            line('model', hertz, impedance),
            line(
              'other',
              hertz,
              impedance.map((z) => z * 3),
              1,
            ),
          ]}
          xUnit="Hz"
          yUnit="Ω"
          logX
          logY
        />
      </Case>
      <Case name="narrow-family" width={280}>
        <CurveChart title="Narrow family" series={family} xUnit="V" yUnit="A" height={260} />
      </Case>
      <Case name="residuals" width={420}>
        <CurveChart
          title="Phase with residuals"
          series={[line('model', hertz, degrees)]}
          xUnit="Hz"
          yUnit="°"
          logX
          residuals={{ x: hertz, y: hertz.map((_f, i) => 12 * Math.sin(i / 4)), unit: '°' }}
        />
      </Case>
    </div>
  </TooltipProvider>,
)
