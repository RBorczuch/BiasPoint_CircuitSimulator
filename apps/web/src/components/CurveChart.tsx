/**
 * Characteristic charts (|Z|(f), ESR(f), C(V), I-V, Ic(Vce)…), the same everywhere: the part
 * editor, the part's card, the template preview, the inspector (docs/projekt-kreator.md §5).
 *
 * - Drawn in real pixels: labels are measured, margins follow them, ticks are as many as fit and
 *   the edge labels are aligned with the edge – no text leaves the chart.
 * - Title and legend (click: hide / show a series) in a bar above; members of a family are named
 *   at the end of their line, apart from each other, or in the legend when they do not fit.
 * - Residuals under the chart on the same x axis.
 * - Reading: the values under the mouse; cursors A (click) and B (Shift+click) with Δ, ratio and
 *   slope (per decade on log axes); A / B keys, arrows move the active one, Esc hides them.
 * - Zoom: wheel (Ctrl+wheel in a panel, wheel alone in full screen; over an axis only that axis),
 *   Ctrl+drag a box, middle-drag or Space+drag to pan, double-click to fit; a click on an axis
 *   types its range.
 * - Alt+drag: the fitting range (when the chart offers one; its edges drag); a highlighted band
 *   (a parameter's part of the curve).
 * - Handles (points that set values when dragged): Esc cancels a drag, the axes grow when the
 *   handle nears an edge, one drag is one undo step for the caller (onStart / onEnd).
 * - ⤢ (or F, or a double click on the title) opens the chart in full screen with the same view,
 *   cursors and handles, a toolbar for log / linear axes and export to PNG, SVG and CSV.
 * - Charts in a ChartGroup (the tabs of one editor) stay in full screen from one to the next
 *   (‹ ›, PgUp / PgDn) and keep their cursors on the same x axis.
 */
import { Download, Maximize2, Minimize2, X } from 'lucide-react'
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'
import {
  FONT,
  FONT_FAMILY,
  niceRange,
  panRange,
  placeEndLabels,
  placeXLabels,
  resonanceOf,
  slope,
  textWidth,
  valueAt,
  yTicks,
  zoomRange,
} from '@/lib/chartAxes'
import { formatValue, parseQuantity } from '@/lib/units'
import { Tip } from './Tip'

export interface ChartSeries {
  label: string
  x: number[]
  y: number[]
  color: string
  kind?: 'line' | 'points'
  dashed?: boolean
  endLabel?: boolean // label written at the curve's last point (families)
  faint?: boolean // drawn thin and grey (the curve before a drag)
  ids?: number[] // points that can be moved / left out (onPointMove, onPointToggle)
  weights?: number[] // 0: a point left out of the fit (drawn hollow)
}

/** A point of a curve the user can drag (e.g. the self-resonance: ESL and ESR follow). */
export interface ChartHandle {
  label: string
  x: number
  y: number
  onDrag: (x: number, y: number) => void
  hint?: string // what dragging it changes ("sideways ESL, up / down ESR")
  readout?: string // the values it is changing, shown while dragging
  disabled?: string // why it cannot be dragged (its values are locked)
  onStart?: () => void
  onEnd?: (cancelled: boolean) => void
  onHover?: (on: boolean) => void // the mouse is over it (the editor shows what it changes)
}

export interface ChartResiduals {
  x: number[]
  y: number[]
  unit: string // "%" or "°"
}

interface Props {
  series: ChartSeries[]
  handles?: ChartHandle[]
  xUnit: string
  yUnit: string
  logX?: boolean
  logY?: boolean
  height?: number // px of the chart (residuals add their own strip)
  title?: string
  residuals?: ChartResiduals
  highlight?: [number, number] | null // x range shaded (what a parameter acts on)
  range?: [number | null, number | null] // the fitting range (outside it greyed)
  onRange?: (range: [number | null, number | null]) => void
  /** Pulling the model's curve (the first line) to a point: the values follow. */
  onGrab?: (x: number, y: number, phase: 'start' | 'move' | 'end' | 'cancel') => void
  grabReadout?: string // what the pull is changing, shown while pulling
  /** A datasheet point (of a series with ids) dragged to (x, y): its reading corrected. */
  onPointMove?: (id: number, x: number, y: number) => void
  /** Right click on a datasheet point: left out of the fit, or back in. */
  onPointToggle?: (id: number) => void
  /** What a plain mouse does on the chart: `add` a click adds a point and a right click removes
   *  one; `range` a drag selects the fitting range (as Alt+drag). */
  tool?: 'add' | 'range' | null
  onPointAdd?: (x: number, y: number) => void
  onPointRemove?: (id: number) => void
}

type Range = [number, number]
interface Domain {
  x: Range
  y: Range
}
export interface Cursors {
  a: number | null
  b: number | null
  active: 'a' | 'b'
}

const NO_CURSORS: Cursors = { a: null, b: null, active: 'a' }

/** What the charts of one editor share, one tab at a time: full screen and the cursors. */
export interface ChartGroupValue {
  full: string | null // the title of the chart in full screen
  setFull: (title: string | null) => void
  step?: (direction: 1 | -1) => void // to the next chart (none: only one)
  cursors: Record<string, Cursors> // per x axis
  setCursors: (axis: string, cursors: Cursors) => void
}

export const ChartGroup = createContext<ChartGroupValue | null>(null)

/** What both views of a chart (in its panel and in full screen) share. */
interface View {
  domain: Domain | null
  setDomain: (d: Domain | null) => void
  cursors: Cursors
  setCursors: (c: Cursors) => void
  hidden: Set<string>
  toggle: (label: string) => void
  logX: boolean
  logY: boolean
  setLog: (axis: 'x' | 'y', log: boolean) => void
}

const fmt = (v: number, unit: string) => formatValue(v, unit, 3)

export function CurveChart(props: Props) {
  const group = useContext(ChartGroup)
  const shared = group && props.title ? group : null
  const [domain, setDomain] = useState<Domain | null>(null)
  const [ownCursors, setOwnCursors] = useState<Cursors>(NO_CURSORS)
  const xAxis = `${props.xUnit}:${Boolean(props.logX)}`
  const cursors = shared ? (shared.cursors[xAxis] ?? NO_CURSORS) : ownCursors
  const setCursors = (c: Cursors) => (shared ? shared.setCursors(xAxis, c) : setOwnCursors(c))
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [log, setLogState] = useState<{ x: boolean | null; y: boolean | null }>({ x: null, y: null })
  const [ownFull, setOwnFull] = useState(false)
  const full = shared ? shared.full === props.title : ownFull
  const setFull = (on: boolean) =>
    shared ? shared.setFull(on ? (props.title ?? null) : null) : setOwnFull(on)
  // A new set of axes (another characteristic, log switched by the caller): the view starts over.
  const axes = `${props.logX}:${props.logY}:${props.xUnit}:${props.yUnit}`
  const [seen, setSeen] = useState(axes)
  if (seen !== axes) {
    setSeen(axes)
    setDomain(null)
    setOwnCursors(NO_CURSORS)
  }
  const view: View = {
    domain,
    setDomain,
    cursors,
    setCursors,
    hidden,
    toggle: (label) =>
      setHidden((h) => {
        const next = new Set(h)
        if (next.has(label)) next.delete(label)
        else next.add(label)
        return next
      }),
    logX: log.x ?? Boolean(props.logX),
    logY: log.y ?? Boolean(props.logY),
    setLog: (axis, value) => {
      setLogState((l) => ({ ...l, [axis]: value }))
      setDomain(null)
    },
  }
  return (
    <>
      <Plot {...props} view={view} onFull={() => setFull(true)} />
      {full &&
        createPortal(
          <FullScreen title={props.title} onClose={() => setFull(false)} onStep={shared?.step}>
            <Plot {...props} view={view} full onFull={() => setFull(false)} onStep={shared?.step} />
          </FullScreen>,
          document.body,
        )}
    </>
  )
}

function FullScreen({
  title,
  onClose,
  onStep,
  children,
}: {
  title?: string
  onClose: () => void
  onStep?: (direction: 1 | -1) => void
  children: ReactNode
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      } else if (onStep && (e.key === 'PageDown' || e.key === 'PageUp')) {
        e.preventDefault()
        onStep(e.key === 'PageDown' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', key, true)
    return () => window.removeEventListener('keydown', key, true)
  }, [onClose, onStep])
  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-background p-4"
      role="dialog"
      aria-modal="true"
      aria-label={`${title ?? 'Chart'} – full screen`}
      data-testid="chart-full"
    >
      {children}
    </div>
  )
}

/** A handle or the curve being dragged: where it started (px and data). */
interface Session {
  kind: 'handle' | 'curve' | 'point'
  label: string
  px: { x: number; y: number }
  moved: boolean
  shift: boolean
}

interface Drag {
  kind: 'pan' | 'box' | 'range' | 'edge' | 'cursor' | 'click'
  edge?: 0 | 1 // which end of the fitting range
  x0: number
  y0: number
  x: number
  y: number
  start?: Domain
  cursor?: 'a' | 'b'
  shift?: boolean
}

function Plot({
  series,
  handles = [],
  xUnit,
  yUnit,
  height = 180,
  title,
  residuals,
  highlight,
  range,
  onRange,
  onGrab,
  grabReadout,
  onPointMove,
  onPointToggle,
  tool,
  onPointAdd,
  onPointRemove,
  view,
  full = false,
  onFull,
  onStep,
}: Props & {
  view: View
  full?: boolean
  onFull: () => void
  onStep?: (direction: 1 | -1) => void
}) {
  const wrap = useRef<HTMLDivElement>(null)
  const area = useRef<HTMLDivElement>(null)
  const svg = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const [frozen, setFrozen] = useState<Domain | null>(null)
  const [session, setSession] = useState<Session | null>(null) // a handle or the curve dragged
  const grab = session?.kind === 'handle' ? session.label : null
  const [pull, setPull] = useState<{ x: number; y: number } | null>(null) // where the curve is pulled to (px)
  const [entry, setEntry] = useState<{ label: string; x: string; y: string } | null>(null)
  const [near, setNear] = useState<string | null>(null) // the handle under the mouse
  const [axisEntry, setAxisEntry] = useState<{
    axis: 'x' | 'y'
    lo: string
    hi: string
    bad: boolean
    at: { x: number; y: number }
  } | null>(null)
  const axisInput = useRef<HTMLInputElement>(null)
  const axisOpen = axisEntry?.axis
  useEffect(() => {
    if (axisOpen) axisInput.current?.select()
  }, [axisOpen])
  const [space, setSpace] = useState(false) // Space held over the chart: a drag moves the view
  const over = useRef(false)
  useEffect(() => {
    const typing = (t: EventTarget | null) =>
      t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))
    const press = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !over.current || typing(e.target)) return
      e.preventDefault() // (Space would scroll the panel, or press the button in focus)
      setSpace(true)
    }
    const release = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpace(false)
    }
    window.addEventListener('keydown', press)
    window.addEventListener('keyup', release)
    return () => {
      window.removeEventListener('keydown', press)
      window.removeEventListener('keyup', release)
    }
  }, [])
  const clip = `chart-clip-${useId().replace(/:/g, '')}`
  const { logX, logY } = view

  useLayoutEffect(() => {
    const el = area.current
    if (!el) return
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // -- layout ---------------------------------------------------------------------------------
  const visible = series.filter((s) => !view.hidden.has(s.label))
  const auto: Domain = {
    x: niceRange(
      visible.flatMap((s) => s.x),
      logX,
    ),
    y: niceRange(
      visible.flatMap((s) => s.y),
      logY,
    ),
  }
  const dom = frozen ?? view.domain ?? auto
  const [x0, x1] = dom.x
  const [y0, y1] = dom.y
  const width = Math.max(220, size.w || 360)
  const resH = residuals ? (full ? Math.max(90, Math.round(size.h * 0.22)) : 64) : 0
  const total = full ? Math.max(240, size.h) : height + (residuals ? resH + 8 : 0)
  const top = 8
  const mainBottom = total - 18 - (residuals ? resH + 8 : 0)
  const yVals = yTicks(y0, y1, logY, mainBottom - top)
  const rRange: Range = residuals ? residualRange(residuals.y) : [-1, 1]
  const rVals = residuals ? yTicks(rRange[0], rRange[1], false, resH) : []
  const yText = (v: number) => fmt(v, yUnit)
  const rText = (v: number) => fmt(v, residuals?.unit ?? '')
  const left = Math.ceil(
    Math.max(28, ...yVals.map((v) => textWidth(yText(v))), ...rVals.map((v) => textWidth(rText(v)))) + 10,
  )
  const right = 10
  const plotW = Math.max(40, width - left - right)
  const tx = (v: number) =>
    logX ? (Math.log10(v) - Math.log10(x0)) / Math.log10(x1 / x0) : (v - x0) / (x1 - x0)
  const ty = (v: number) =>
    logY ? (Math.log10(v) - Math.log10(y0)) / Math.log10(y1 / y0) : (v - y0) / (y1 - y0)
  const fx = (v: number) => left + tx(v) * plotW
  const fy = (v: number) => mainBottom - ty(v) * (mainBottom - top)
  const resTop = mainBottom + 8
  const fr = (v: number) => resTop + ((rRange[1] - v) / (rRange[1] - rRange[0])) * resH
  const ix = (px: number) => {
    const t = (px - left) / plotW
    return logX ? x0 * (x1 / x0) ** t : x0 + t * (x1 - x0)
  }
  const iy = (py: number) => {
    const t = (mainBottom - py) / (mainBottom - top)
    return logY ? y0 * (y1 / y0) ** t : y0 + t * (y1 - y0)
  }
  const ok = (v: number, isLog: boolean) => Number.isFinite(v) && (!isLog || v > 0)
  const xLabels = placeXLabels(x0, x1, logX, fx, (v) => fmt(v, xUnit), width, plotW)
  const bottom = residuals ? resTop + resH : mainBottom

  // Family labels at the ends of their lines, apart; the ones that do not fit go to the legend.
  const ends = visible.filter((s) => s.endLabel && s.kind !== 'points')
  const endAt = placeEndLabels(
    ends.flatMap((s) => {
      const i = lastIndex(s, logX, logY)
      return i < 0 ? [] : [{ key: s.label, y: fy(s.y[i]) - 3 }]
    }),
    top + FONT,
    mainBottom - 3,
  )
  const legend = series.filter((s) => !s.faint && (!s.endLabel || !endAt))
  const primary = visible.find((s) => s.kind !== 'points' && !s.faint) ?? visible[0]

  // -- reading --------------------------------------------------------------------------------
  const at = (s: ChartSeries, x: number) => valueAt(s.x, s.y, x, logX, logY)
  const readout = (() => {
    if (!hover || drag?.kind === 'box' || grab) return null
    const inside = hover.x >= left && hover.x <= left + plotW && hover.y >= top && hover.y <= bottom
    if (!inside) return null
    const x = ix(hover.x)
    const lines: { label: string; text: string; color: string }[] = []
    // A datasheet point under the mouse: its value, the model's and the difference.
    for (const s of visible.filter((v) => v.kind === 'points')) {
      let best = -1
      let dist = 10
      s.x.forEach((px, i) => {
        if (!ok(px, logX) || !ok(s.y[i], logY)) return
        const d = Math.hypot(fx(px) - hover.x, fy(s.y[i]) - hover.y)
        if (d < dist) {
          dist = d
          best = i
        }
      })
      if (best >= 0) {
        const model = primary && primary !== s ? at(primary, s.x[best]) : null
        const error =
          model !== null && s.y[best] !== 0 ? (100 * (model - s.y[best])) / Math.abs(s.y[best]) : null
        return {
          x: s.x[best],
          px: fx(s.x[best]),
          lines: [
            { label: s.label, text: fmt(s.y[best], yUnit), color: s.color },
            ...(model !== null && primary
              ? [{ label: primary.label, text: fmt(model, yUnit), color: primary.color }]
              : []),
            ...(error !== null
              ? [{ label: 'difference', text: `${error >= 0 ? '+' : ''}${error.toFixed(1)} %`, color: '' }]
              : []),
          ],
        }
      }
    }
    for (const s of visible.filter((v) => v.kind !== 'points' && !v.faint)) {
      const v = at(s, x)
      if (v !== null) lines.push({ label: s.label, text: fmt(v, yUnit), color: s.color })
    }
    if (residuals) {
      const i = nearestIndex(residuals.x, x, logX)
      if (i >= 0 && Math.abs(fx(residuals.x[i]) - hover.x) < 8)
        lines.push({ label: 'residual', text: rText(residuals.y[i]), color: '' })
    }
    return lines.length ? { x, px: hover.x, lines } : null
  })()

  const cursorValue = (c: number | null) => (c === null || !primary ? null : at(primary, c))
  const [a, b] = [view.cursors.a, view.cursors.b]
  const va = cursorValue(a)
  const vb = cursorValue(b)

  // -- interaction ----------------------------------------------------------------------------
  const local = (e: { clientX: number; clientY: number }) => {
    const box = svg.current?.getBoundingClientRect()
    return box ? { x: e.clientX - box.left, y: e.clientY - box.top } : { x: 0, y: 0 }
  }
  // A double-click fits the view: the cursors stay as they were before its two clicks.
  const beforeClicks = useRef<{ at: number; cursors: Cursors }>({ at: 0, cursors: view.cursors })
  const setCursor = (which: 'a' | 'b', x: number | null) =>
    view.setCursors({ ...view.cursors, [which]: x, active: which })

  // Wheel zoom: a native listener (React's is passive and cannot keep the page from scrolling).
  const latest = useRef({
    dom,
    left,
    plotW,
    mainBottom,
    top,
    full,
    logX,
    logY,
    ix,
    iy,
    setDomain: view.setDomain,
  })
  latest.current = { dom, left, plotW, mainBottom, top, full, logX, logY, ix, iy, setDomain: view.setDomain }
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const wheel = (e: WheelEvent) => {
      const l = latest.current
      if (!l.full && !e.ctrlKey) return // in a panel the wheel scrolls the panel
      e.preventDefault()
      const box = el.getBoundingClientRect()
      const px = e.clientX - box.left
      const py = e.clientY - box.top
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2
      const onlyY = px < l.left
      const onlyX = py > l.mainBottom
      const next: Domain = {
        x: onlyY
          ? l.dom.x
          : zoomRange(
              l.dom.x[0],
              l.dom.x[1],
              l.ix(Math.min(Math.max(px, l.left), l.left + l.plotW)),
              factor,
              l.logX,
            ),
        y: onlyX
          ? l.dom.y
          : zoomRange(
              l.dom.y[0],
              l.dom.y[1],
              l.iy(Math.min(Math.max(py, l.top), l.mainBottom)),
              factor,
              l.logY,
            ),
      }
      l.setDomain(next)
    }
    el.addEventListener('wheel', wheel, { passive: false })
    return () => el.removeEventListener('wheel', wheel)
  }, [])

  const down = (e: React.PointerEvent<SVGRectElement>) => {
    const p = local(e)
    e.currentTarget.setPointerCapture(e.pointerId)
    const near = (c: number | null) => c !== null && Math.abs(fx(c) - p.x) < 6 && p.y <= bottom
    const base = { x0: p.x, y0: p.y, x: p.x, y: p.y, start: dom }
    const edge = e.altKey ? null : rangeEdgeAt(p)
    if (e.button === 1 || (e.button === 0 && space)) setDrag({ ...base, kind: 'pan' })
    else if (e.button !== 0) return
    else if (edge !== null) setDrag({ ...base, kind: 'edge', edge })
    else if ((e.altKey || tool === 'range') && onRange) setDrag({ ...base, kind: 'range' })
    else if (e.ctrlKey || e.metaKey) setDrag({ ...base, kind: 'box' })
    else if (tool !== 'add' && near(a)) setDrag({ ...base, kind: 'cursor', cursor: 'a' })
    else if (tool !== 'add' && near(b)) setDrag({ ...base, kind: 'cursor', cursor: 'b' })
    else if (onPointMove && pointAt(p) !== null) {
      // A datasheet point grabbed: its reading is corrected where it is dropped.
      setFrozen(dom)
      setSession({ kind: 'point', label: String(pointAt(p)), px: p, moved: false, shift: e.shiftKey })
    } else if (onGrab && onCurve(p)) {
      // The model's curve grabbed: pulled to where the mouse goes (a click places a cursor).
      setFrozen(dom)
      setSession({ kind: 'curve', label: 'curve', px: p, moved: false, shift: e.shiftKey })
      const x = ix(p.x)
      const y = primary ? at(primary, x) : null
      if (y !== null) onGrab(x, y, 'start')
    } else {
      const now = performance.now()
      if (now - beforeClicks.current.at > 500) beforeClicks.current.cursors = view.cursors
      beforeClicks.current.at = now
      setDrag({ ...base, kind: 'click', shift: e.shiftKey })
    }
  }
  const move = (e: React.PointerEvent<SVGRectElement>) => {
    const p = local(e)
    setHover(p)
    if (session?.kind === 'point') {
      const t = dragTarget(
        {
          ...e,
          altKey: true,
          clientX: e.clientX,
          clientY: e.clientY,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        },
        session,
      )
      if (!t) return
      if (!session.moved && Math.hypot(p.x - session.px.x, p.y - session.px.y) > 3)
        setSession({ ...session, moved: true })
      setPull(t.px)
      return
    }
    if (session?.kind === 'curve' && onGrab) {
      const t = dragTarget(e, session)
      if (!t) return
      if (!session.moved && Math.hypot(p.x - session.px.x, p.y - session.px.y) > 4)
        setSession({ ...session, moved: true })
      setPull(t.px)
      onGrab(t.x, t.y, 'move')
      return
    }
    if (!drag) return
    setDrag({ ...drag, x: p.x, y: p.y })
    if (drag.kind === 'pan' && drag.start) {
      const s = drag.start
      view.setDomain({
        x: panRange(s.x[0], s.x[1], -(p.x - drag.x0) / plotW, logX),
        y: panRange(s.y[0], s.y[1], (p.y - drag.y0) / (mainBottom - top), logY),
      })
    }
    if (drag.kind === 'cursor' && drag.cursor)
      setCursor(drag.cursor, ix(Math.min(Math.max(p.x, left), left + plotW)))
    if (drag.kind === 'edge' && drag.edge !== undefined && range && onRange) {
      const x = ix(Math.min(Math.max(p.x, left), left + plotW))
      const other = range[drag.edge === 0 ? 1 : 0]
      if (other === null || (drag.edge === 0 ? x < other : x > other))
        onRange(drag.edge === 0 ? [x, other] : [other, x])
    }
  }
  const up = (e: React.PointerEvent<SVGRectElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId)
    const p = local(e)
    if (session?.kind === 'point') {
      const t = dragTarget(
        {
          ...e,
          altKey: true,
          clientX: e.clientX,
          clientY: e.clientY,
          shiftKey: e.shiftKey,
          ctrlKey: e.ctrlKey,
          metaKey: e.metaKey,
        },
        session,
      )
      if (session.moved && t) onPointMove?.(Number(session.label), t.x, t.y)
      else if (tool !== 'add') setCursor(session.shift ? 'b' : 'a', ix(p.x)) // a click on a point: a cursor
      setFrozen(null)
      setSession(null)
      setPull(null)
      return
    }
    if (session?.kind === 'curve' && onGrab) {
      const t = dragTarget(e, session)
      if (session.moved && t) {
        if (frozen) view.setDomain(frozen)
        onGrab(t.x, t.y, 'end')
      } else {
        onGrab(0, 0, 'cancel') // a click on the curve: a cursor, as anywhere else
        setCursor(session.shift ? 'b' : 'a', ix(p.x))
      }
      setFrozen(null)
      setSession(null)
      setPull(null)
      return
    }
    const d = drag
    setDrag(null)
    if (!d) return
    const moved = Math.hypot(p.x - d.x0, p.y - d.y0) > 4
    const clampX = (px: number) => Math.min(Math.max(px, left), left + plotW)
    if (d.kind === 'click' && !moved && p.x >= left && p.x <= left + plotW && p.y > bottom)
      setAxisEntry({
        axis: 'x',
        lo: fmt(x0, xUnit),
        hi: fmt(x1, xUnit),
        bad: false,
        at: { x: Math.min(p.x, width - 250), y: bottom - 30 },
      })
    else if (d.kind === 'click' && !moved && p.x < left && p.y >= top && p.y <= mainBottom)
      setAxisEntry({
        axis: 'y',
        lo: fmt(y0, yUnit),
        hi: fmt(y1, yUnit),
        bad: false,
        at: { x: left + 4, y: Math.min(p.y, mainBottom - 30) },
      })
    else if (d.kind === 'click' && !moved && p.x >= left && p.x <= left + plotW) {
      if (tool !== 'add' || !onPointAdd) setCursor(d.shift ? 'b' : 'a', ix(p.x))
      else if (p.y >= top && p.y <= mainBottom) onPointAdd(ix(p.x), iy(p.y))
    }
    if (d.kind === 'box' && moved && Math.abs(p.x - d.x0) > 6 && Math.abs(p.y - d.y0) > 6) {
      const xs = [ix(clampX(d.x0)), ix(clampX(p.x))].sort((m, n) => m - n) as Range
      const ys = [
        iy(Math.min(Math.max(d.y0, top), mainBottom)),
        iy(Math.min(Math.max(p.y, top), mainBottom)),
      ].sort((m, n) => m - n) as Range
      view.setDomain({ x: xs, y: ys })
    }
    if (d.kind === 'range' && onRange) {
      if (!moved) onRange([null, null])
      else {
        const xs = [ix(clampX(d.x0)), ix(clampX(p.x))].sort((m, n) => m - n)
        onRange([xs[0], xs[1]])
      }
    }
  }

  const key = (e: React.KeyboardEvent) => {
    if (e.target !== wrap.current) return
    const { a: ca, b: cb, active } = view.cursors
    const current = active === 'a' ? ca : cb
    const step = (from: number, dir: number) =>
      logX ? from * (x1 / x0) ** (dir * 0.01) : from + dir * 0.01 * (x1 - x0)
    if (e.key === 'f' || e.key === 'F') onFull()
    else if (e.key === 'a' || e.key === 'b') {
      const which = e.key
      const value = view.cursors[which] ?? ix(left + plotW * (which === 'a' ? 0.33 : 0.66))
      view.setCursors({ ...view.cursors, [which]: value, active: which })
    } else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && current !== null) {
      e.preventDefault()
      setCursor(active, step(current, (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 10 : 1)))
    } else if (e.key === 'Escape' && !full && (ca !== null || cb !== null)) {
      view.setCursors({ a: null, b: null, active: 'a' })
    } else return
    e.stopPropagation()
  }

  /** The end of the fitting range under the mouse (5 px), if any. */
  const rangeEdgeAt = (p: { x: number; y: number }): 0 | 1 | null => {
    if (!onRange || !range || tool === 'add' || p.y < top || p.y > bottom) return null
    for (const k of [0, 1] as const) {
      const v = range[k]
      if (v !== null && ok(v, logX) && Math.abs(fx(v) - p.x) <= 5) return k
    }
    return null
  }

  /** The range typed for an axis: both ends in its unit, low to high, positive on a log axis. */
  const applyAxis = () => {
    if (!axisEntry) return
    const unit = axisEntry.axis === 'x' ? xUnit : yUnit
    const lo = parseQuantity(axisEntry.lo, unit)
    const hi = parseQuantity(axisEntry.hi, unit)
    const log = axisEntry.axis === 'x' ? logX : logY
    if (lo === null || hi === null || lo >= hi || (log && lo <= 0)) {
      setAxisEntry({ ...axisEntry, bad: true })
      return
    }
    view.setDomain({ ...dom, [axisEntry.axis]: [lo, hi] })
    setAxisEntry(null)
  }

  /** The id of a movable datasheet point under the mouse (6 px), if any. */
  const pointAt = (p: { x: number; y: number }): number | null => {
    let best: number | null = null
    let dist = 6
    for (const s of visible.filter((v) => v.kind === 'points' && v.ids))
      s.x.forEach((x, i) => {
        if (!ok(x, logX) || !ok(s.y[i], logY) || s.ids?.[i] === undefined) return
        const d = Math.hypot(fx(x) - p.x, fy(s.y[i]) - p.y)
        if (d < dist) {
          dist = d
          best = s.ids[i]
        }
      })
    return best
  }

  /** Whether the mouse is on the model's curve (6 px). */
  const onCurve = (p: { x: number; y: number }) => {
    if (!primary || p.x < left || p.x > left + plotW || p.y < top || p.y > mainBottom) return false
    const y = at(primary, ix(p.x))
    return y !== null && ok(y, logY) && Math.abs(fy(y) - p.y) <= 6
  }

  /**
   * Where a dragged handle or curve goes: Ctrl moves a tenth as far (fine), Shift keeps it on one
   * axis, a datasheet point within 8 px catches it (Alt: not); the axes grow near an edge (the
   * scale stays otherwise: the curve moves, not the axes).
   */
  const dragTarget = (
    e: {
      clientX: number
      clientY: number
      shiftKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      altKey: boolean
    },
    from: Session,
  ) => {
    if (!frozen) return null
    let p = local(e)
    const s0 = from.px
    if (e.ctrlKey || e.metaKey) p = { x: s0.x + (p.x - s0.x) / 10, y: s0.y + (p.y - s0.y) / 10 }
    if (e.shiftKey) p = Math.abs(p.x - s0.x) > Math.abs(p.y - s0.y) ? { ...p, y: s0.y } : { ...p, x: s0.x }
    let g = frozen
    const edge = 16
    if (p.x > left + plotW - edge) g = { ...g, x: growRange(g.x, 'hi', logX) }
    if (p.x < left + edge) g = { ...g, x: growRange(g.x, 'lo', logX) }
    if (p.y < top + edge) g = { ...g, y: growRange(g.y, 'hi', logY) }
    if (p.y > mainBottom - edge) g = { ...g, y: growRange(g.y, 'lo', logY) }
    if (g !== frozen) setFrozen(g)
    const toPx = (x: number, y: number) => {
      const t = logX ? Math.log10(x / g.x[0]) / Math.log10(g.x[1] / g.x[0]) : (x - g.x[0]) / (g.x[1] - g.x[0])
      const u = logY ? Math.log10(y / g.y[0]) / Math.log10(g.y[1] / g.y[0]) : (y - g.y[0]) / (g.y[1] - g.y[0])
      return { x: left + t * plotW, y: mainBottom - u * (mainBottom - top) }
    }
    if (!e.altKey) {
      let best: { x: number; y: number } | null = null
      let dist = 8
      for (const s of visible.filter((v) => v.kind === 'points'))
        s.x.forEach((x, i) => {
          if (!ok(x, logX) || !ok(s.y[i], logY)) return
          const q = toPx(x, s.y[i])
          const d = Math.hypot(q.x - p.x, q.y - p.y)
          if (d < dist) {
            dist = d
            best = q
          }
        })
      if (best) p = best
    }
    const t = (p.x - left) / plotW
    const u = (mainBottom - p.y) / (mainBottom - top)
    return {
      x: logX ? g.x[0] * (g.x[1] / g.x[0]) ** t : g.x[0] + t * (g.x[1] - g.x[0]),
      y: logY ? g.y[0] * (g.y[1] / g.y[0]) ** u : g.y[0] + u * (g.y[1] - g.y[0]),
      px: p,
    }
  }

  const handleDown = (h: ChartHandle) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (h.disabled || e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    setFrozen(dom)
    setSession({ kind: 'handle', label: h.label, px: { x: fx(h.x), y: fy(h.y) }, moved: false, shift: false })
    h.onStart?.()
  }
  const handleMove = (h: ChartHandle) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (grab !== h.label || !session) return
    setHover(local(e))
    const t = dragTarget(e, session)
    if (t) h.onDrag(t.x, t.y)
  }
  const handleUp = (h: ChartHandle) => (e: React.PointerEvent<SVGCircleElement>) => {
    if (grab !== h.label) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    // Keep the grown axes: the handle stays where it was dropped.
    if (frozen) view.setDomain(frozen)
    setFrozen(null)
    setSession(null)
    h.onEnd?.(false)
  }
  /** Arrow keys on a focused handle: 1 % of the axis a press (Shift: 10 %). */
  const handleKey = (h: ChartHandle) => (e: React.KeyboardEvent<SVGCircleElement>) => {
    const dirs: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    }
    if (e.key === 'Enter') {
      setEntry({ label: h.label, x: fmt(h.x, xUnit), y: fmt(h.y, yUnit) })
      e.preventDefault()
      return
    }
    const d = dirs[e.key]
    if (!d || h.disabled) return
    e.preventDefault()
    e.stopPropagation()
    const k = e.shiftKey ? 0.1 : 0.01
    const px = fx(h.x) + d[0] * k * plotW
    const py = fy(h.y) + d[1] * k * (mainBottom - top)
    h.onStart?.()
    h.onDrag(ix(px), iy(py))
    h.onEnd?.(false)
  }
  const applyEntry = (h: ChartHandle, x: string, y: string) => {
    const vx = parseQuantity(x, xUnit)
    const vy = parseQuantity(y, yUnit)
    setEntry(null)
    if (vx === null || vy === null) return
    h.onStart?.()
    h.onDrag(vx, vy)
    h.onEnd?.(false)
  }
  useEffect(() => {
    if (!session) return
    const cancel = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (session.kind === 'handle') handles.find((h) => h.label === session.label)?.onEnd?.(true)
      else if (session.kind === 'curve') onGrab?.(0, 0, 'cancel')
      setFrozen(null)
      setSession(null)
      setPull(null)
    }
    window.addEventListener('keydown', cancel, true)
    return () => window.removeEventListener('keydown', cancel, true)
  }, [session, handles, onGrab])

  // -- export (full screen) -------------------------------------------------------------------
  const exportAs = async (kind: 'png' | 'svg' | 'csv' | 'copy') => {
    const name = (title ?? 'chart').replace(/[^\w.-]+/g, '_')
    if (kind === 'csv') {
      const rows = ['series,x,y', ...series.flatMap((s) => s.x.map((x, i) => `"${s.label}",${x},${s.y[i]}`))]
      save(new Blob([rows.join('\n')], { type: 'text/csv' }), `${name}.csv`)
      return
    }
    const text = svg.current && wrap.current ? standalone(svg.current, wrap.current) : null
    if (!text) return
    if (kind === 'svg') {
      save(new Blob([text], { type: 'image/svg+xml' }), `${name}.svg`)
      return
    }
    const png = await toPng(text, width, total, getComputedStyle(wrap.current as Element).backgroundColor)
    if (!png) return
    if (kind === 'copy' && navigator.clipboard && 'ClipboardItem' in window)
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
    else save(png, `${name}.png`)
  }

  // -- drawing --------------------------------------------------------------------------------
  const pathOf = (s: ChartSeries) => {
    const pts = s.x.map((x, i) => [x, s.y[i]] as const).filter(([x, y]) => ok(x, logX) && ok(y, logY))
    return pts.map(([x, y], i) => `${i ? 'L' : 'M'}${fx(x).toFixed(1)},${fy(y).toFixed(1)}`).join('')
  }
  const band = (from: number | null, to: number | null) => {
    const l = from === null ? left : Math.max(left, fx(from))
    const r = to === null ? left + plotW : Math.min(left + plotW, fx(to))
    return r > l ? { x: l, w: r - l } : null
  }
  const cursorLine = (c: number | null, name: 'A' | 'B') => {
    if (c === null || !ok(c, logX)) return null
    const px = fx(c)
    if (px < left - 0.5 || px > left + plotW + 0.5) return null
    return (
      <g key={name} className="text-sky-500">
        <line x1={px} x2={px} y1={top} y2={bottom} stroke="currentColor" strokeWidth={1.2} />
        <text
          x={Math.min(px + 3, left + plotW - 9)}
          y={top + FONT}
          fontSize={FONT}
          fill="currentColor"
          fontWeight={600}
        >
          {name}
        </text>
      </g>
    )
  }
  const tooltipLeft = readout ? (readout.px > left + plotW / 2 ? readout.px - 8 : readout.px + 8) : 0
  const grabbed = handles.find((h) => h.label === grab)

  return (
    <div
      ref={wrap}
      role="application"
      aria-label={`${title ?? 'Chart'} – F: full screen, click: cursor A, Shift+click: cursor B`}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the keys F, A, B, arrows and Esc work on the focused chart
      tabIndex={0}
      onKeyDown={key}
      className={`flex min-w-0 flex-col rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${full ? 'min-h-0 flex-1' : ''}`}
      data-testid={title ? `chart-${title}` : undefined}
    >
      <div className="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-0.5 px-1 text-[11px]">
        {full && onStep && (
          <span className="flex items-center gap-0.5">
            <button
              type="button"
              className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent"
              aria-label="Previous chart"
              title="Previous chart (PgUp)"
              onClick={() => onStep(-1)}
            >
              ‹
            </button>
            <button
              type="button"
              className="rounded border px-1.5 py-0.5 text-xs hover:bg-accent"
              aria-label="Next chart"
              title="Next chart (PgDn)"
              onClick={() => onStep(1)}
            >
              ›
            </button>
          </span>
        )}
        {title && (
          // biome-ignore lint/a11y/noStaticElementInteractions: a shortcut; the ⤢ button and F do the same
          <span
            className={`font-medium text-foreground ${full ? 'text-sm' : ''}`}
            onDoubleClick={onFull}
            data-testid="chart-title"
          >
            {title}
          </span>
        )}
        {legend.length > 1 &&
          legend.map((s) => (
            <button
              key={s.label}
              type="button"
              className={`flex items-center gap-1 ${view.hidden.has(s.label) ? 'opacity-40' : ''}`}
              title={view.hidden.has(s.label) ? 'Show' : 'Hide'}
              onClick={() => view.toggle(s.label)}
            >
              {s.kind === 'points' ? (
                <span className="inline-block size-1.5 rounded-full" style={{ background: s.color }} />
              ) : (
                <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              )}
              <span style={{ color: s.color }}>{s.label}</span>
            </button>
          ))}
        <span className="ml-auto flex items-center gap-1">
          {full && <Toolbar view={view} primary={primary} at={at} onExport={exportAs} />}
          <Tip text={full ? 'Close (Esc)' : 'Full screen (F) – zoom, cursors, export'}>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label={full ? 'Close full screen' : 'Full screen'}
              onClick={onFull}
            >
              {full ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
            </button>
          </Tip>
        </span>
      </div>
      <div
        ref={area}
        className={`relative min-w-0 ${full ? 'min-h-0 flex-1' : ''}`}
        style={full ? undefined : { height: total }}
      >
        <svg
          ref={svg}
          width={width}
          height={total}
          className="absolute top-0 left-0 block select-none text-muted-foreground"
          role="img"
          aria-label={title ?? `${yUnit} vs ${xUnit}`}
          style={{ fontFamily: FONT_FAMILY }}
        >
          <rect
            x={left}
            y={top}
            width={plotW}
            height={mainBottom - top}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.4}
          />
          {residuals && (
            <rect
              x={left}
              y={resTop}
              width={plotW}
              height={resH}
              fill="none"
              stroke="currentColor"
              strokeOpacity={0.4}
            />
          )}
          {xLabels.map((l) => (
            <g key={`x${l.value}`}>
              <line
                x1={l.center}
                x2={l.center}
                y1={top}
                y2={bottom}
                stroke="currentColor"
                strokeOpacity={0.12}
              />
              <text x={l.left} y={bottom + 13} fontSize={FONT} fill="currentColor">
                {l.text}
              </text>
            </g>
          ))}
          {yVals.map((v) => (
            <g key={`y${v}`}>
              <line
                x1={left}
                x2={left + plotW}
                y1={fy(v)}
                y2={fy(v)}
                stroke="currentColor"
                strokeOpacity={0.12}
              />
              <text
                x={left - 5}
                y={Math.min(Math.max(fy(v) + 4, FONT), mainBottom + 4)}
                fontSize={FONT}
                textAnchor="end"
                fill="currentColor"
              >
                {yText(v)}
              </text>
            </g>
          ))}
          {rVals.map((v) => (
            <g key={`r${v}`}>
              <line
                x1={left}
                x2={left + plotW}
                y1={fr(v)}
                y2={fr(v)}
                stroke="currentColor"
                strokeOpacity={v === 0 ? 0.35 : 0.12}
                strokeDasharray={v === 0 ? '4 3' : undefined}
              />
              <text x={left - 5} y={fr(v) + 4} fontSize={FONT} textAnchor="end" fill="currentColor">
                {rText(v)}
              </text>
            </g>
          ))}
          <clipPath id={clip}>
            <rect x={left} y={top} width={plotW} height={bottom - top} />
          </clipPath>
          <g clipPath={`url(#${clip})`}>
            {highlight && band(highlight[0], highlight[1]) && (
              <rect
                {...bandRect(band(highlight[0], highlight[1]), top, mainBottom)}
                className="fill-amber-400"
                fillOpacity={0.16}
                data-testid="chart-highlight"
              />
            )}
            {range && (range[0] !== null || range[1] !== null) && (
              <g data-testid="chart-range">
                {(['below', 'above'] as const).map((side) => {
                  const r = side === 'below' ? band(null, range[0]) : band(range[1], null)
                  return (
                    r && (
                      <rect key={side} {...bandRect(r, top, bottom)} fill="currentColor" fillOpacity={0.1} />
                    )
                  )
                })}
                {([0, 1] as const).map((k) => {
                  const v = range[k]
                  return v !== null && ok(v, logX) && fx(v) >= left && fx(v) <= left + plotW ? (
                    <line
                      key={k}
                      data-testid={`range-edge-${k}`}
                      x1={fx(v)}
                      x2={fx(v)}
                      y1={top}
                      y2={bottom}
                      stroke="currentColor"
                      strokeOpacity={0.55}
                      strokeWidth={2}
                    />
                  ) : null
                })}
              </g>
            )}
            {drag?.kind === 'range' && (
              <rect
                x={Math.min(drag.x0, drag.x)}
                width={Math.abs(drag.x - drag.x0)}
                y={top}
                height={bottom - top}
                className="fill-sky-500"
                fillOpacity={0.15}
              />
            )}
            {visible.map((s) => {
              if (s.kind === 'points')
                return s.x.map((x, i) =>
                  ok(x, logX) && ok(s.y[i], logY) ? (
                    <circle
                      key={`${s.label}:${x}:${s.y[i]}`}
                      cx={fx(x)}
                      cy={fy(s.y[i])}
                      r={full ? 3.4 : 2.8}
                      fill={s.weights?.[i] === 0 ? 'none' : s.color}
                      stroke={s.weights?.[i] === 0 ? s.color : undefined}
                      fillOpacity={0.9}
                    />
                  ) : null,
                )
              return (
                <path
                  key={s.label}
                  d={pathOf(s)}
                  fill="none"
                  stroke={s.faint ? 'currentColor' : s.color}
                  strokeOpacity={s.faint ? 0.45 : 1}
                  strokeWidth={s.faint ? 1 : 1.6}
                  strokeDasharray={s.dashed ? '4 3' : undefined}
                />
              )
            })}
            {residuals &&
              residuals.x.map((x, i) =>
                ok(x, logX) && Number.isFinite(residuals.y[i]) ? (
                  <circle
                    key={`res:${x}:${residuals.y[i]}`}
                    cx={fx(x)}
                    cy={fr(residuals.y[i])}
                    r={2.6}
                    className="fill-orange-500"
                  />
                ) : null,
              )}
          </g>
          {endAt &&
            ends.map((s) => {
              const y = endAt.get(s.label)
              const i = lastIndex(s, logX, logY)
              if (y === undefined || i < 0) return null
              return (
                <text
                  key={`end${s.label}`}
                  x={Math.min(fx(s.x[i]), left + plotW) - 3}
                  y={y}
                  fontSize={FONT}
                  textAnchor="end"
                  fill={s.color}
                >
                  {s.label}
                </text>
              )
            })}
          {cursorLine(a, 'A')}
          {cursorLine(b, 'B')}
          {readout && (
            <line
              x1={readout.px}
              x2={readout.px}
              y1={top}
              y2={bottom}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeDasharray="3 3"
              pointerEvents="none"
            />
          )}
          {drag?.kind === 'box' && (
            <rect
              x={Math.min(drag.x0, drag.x)}
              y={Math.min(drag.y0, drag.y)}
              width={Math.abs(drag.x - drag.x0)}
              height={Math.abs(drag.y - drag.y0)}
              fill="none"
              stroke="currentColor"
              strokeDasharray="4 3"
            />
          )}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the mouse surface of the chart (keys: on the group) */}
          <rect
            x={0}
            y={0}
            width={width}
            height={total}
            fill="transparent"
            className={
              drag?.kind === 'pan' || session?.kind === 'curve'
                ? 'cursor-grabbing'
                : space
                  ? 'cursor-grab'
                  : drag?.kind === 'edge' || (hover && rangeEdgeAt(hover) !== null)
                    ? 'cursor-ew-resize'
                    : (onPointMove && hover && pointAt(hover) !== null) || (onGrab && hover && onCurve(hover))
                      ? 'cursor-grab'
                      : hover && (hover.y > bottom || hover.x < left)
                        ? 'cursor-pointer'
                        : 'cursor-crosshair'
            }
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerEnter={() => {
              over.current = true
            }}
            onPointerLeave={() => {
              over.current = false
              setHover(null)
            }}
            onDoubleClick={() => {
              setAxisEntry(null)
              view.setDomain(null)
              view.setCursors(beforeClicks.current.cursors)
            }}
            onContextMenu={(e) => {
              const remove = tool === 'add' ? onPointRemove : undefined
              const id = remove || onPointToggle ? pointAt(local(e)) : null
              if (tool === 'add') e.preventDefault()
              if (id === null) return
              e.preventDefault()
              if (remove) remove(id)
              else onPointToggle?.(id)
            }}
            data-testid="chart-surface"
          />
          {session?.kind === 'point' && session.moved && pull && (
            <circle
              cx={pull.x}
              cy={pull.y}
              r={4}
              className="fill-orange-500"
              pointerEvents="none"
              data-testid="chart-point-drag"
            />
          )}
          {session?.kind === 'curve' && pull && (
            <g className="text-amber-500" pointerEvents="none" data-testid="chart-pull">
              <line
                x1={session.px.x}
                y1={session.px.y}
                x2={pull.x}
                y2={pull.y}
                stroke="currentColor"
                strokeDasharray="3 3"
              />
              <circle cx={pull.x} cy={pull.y} r={5} fill="none" stroke="currentColor" strokeWidth={1.8} />
            </g>
          )}
          {handles.map((h) => {
            if (!ok(h.x, logX) || !ok(h.y, logY)) return null
            const big = near === h.label || grab === h.label
            return (
              // biome-ignore lint/a11y/useSemanticElements: an SVG handle on the chart (a <button> cannot be drawn there)
              <circle
                key={h.label}
                data-testid={`handle-${h.label}`}
                cx={fx(h.x)}
                cy={fy(h.y)}
                r={big ? 8 : 6}
                fill="var(--background)"
                stroke="currentColor"
                strokeWidth={1.8}
                className={
                  h.disabled ? 'cursor-not-allowed text-muted-foreground' : 'cursor-move text-amber-500'
                }
                role="button"
                tabIndex={0}
                aria-label={`${h.label} handle – arrows move it, Enter: type its values`}
                onPointerEnter={() => {
                  setNear(h.label)
                  h.onHover?.(true)
                }}
                onPointerLeave={() => {
                  setNear(null)
                  h.onHover?.(false)
                }}
                onFocus={() => h.onHover?.(true)}
                onBlur={() => h.onHover?.(false)}
                onPointerDown={handleDown(h)}
                onPointerMove={handleMove(h)}
                onPointerUp={handleUp(h)}
                onDoubleClick={(e) => {
                  e.stopPropagation()
                  if (!h.disabled) setEntry({ label: h.label, x: fmt(h.x, xUnit), y: fmt(h.y, yUnit) })
                }}
                onKeyDown={handleKey(h)}
              >
                <title>
                  {h.disabled
                    ? `${h.label}: ${h.disabled}`
                    : `${h.label} – drag: ${h.hint ?? 'move it'}. Shift: one axis, Ctrl: fine, Alt: no snapping, Esc: cancel, double-click: type it`}
                </title>
              </circle>
            )
          })}
        </svg>
        {readout && (
          <div
            className="pointer-events-none absolute z-10 rounded border bg-popover px-2 py-1 text-[11px] whitespace-nowrap text-popover-foreground shadow"
            style={{
              left: tooltipLeft,
              top: Math.max(0, (hover?.y ?? 0) - 10),
              transform: readout.px > left + plotW / 2 ? 'translateX(-100%)' : undefined,
            }}
            data-testid="chart-tooltip"
          >
            <div className="font-medium">{fmt(readout.x, xUnit)}</div>
            {readout.lines.map((l) => (
              <div key={l.label} className="flex gap-2">
                <span
                  style={{ color: l.color || undefined }}
                  className={l.color ? '' : 'text-muted-foreground'}
                >
                  {l.label}
                </span>
                <span className="ml-auto font-mono">{l.text}</span>
              </div>
            ))}
          </div>
        )}
        {session?.kind === 'curve' && grabReadout && pull && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-amber-500/60 bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap text-popover-foreground shadow"
            style={{ left: Math.min(pull.x + 12, width - 40), top: Math.max(0, pull.y - 28) }}
            data-testid="pull-readout"
          >
            {grabReadout}
          </div>
        )}
        {axisEntry && (
          <form
            className="absolute z-20 flex items-center gap-1 rounded border bg-popover p-1.5 text-[11px] shadow"
            style={{ left: Math.max(0, axisEntry.at.x), top: Math.max(0, axisEntry.at.y) }}
            onSubmit={(e) => {
              e.preventDefault()
              applyAxis()
            }}
            data-testid="axis-entry"
          >
            <span className="font-medium">{axisEntry.axis.toUpperCase()}</span>
            <input
              ref={axisInput}
              aria-label={`${axisEntry.axis.toUpperCase()} axis from`}
              aria-invalid={axisEntry.bad}
              className={`w-20 rounded border bg-background px-1 font-mono ${axisEntry.bad ? 'border-destructive' : ''}`}
              value={axisEntry.lo}
              onChange={(e) => setAxisEntry({ ...axisEntry, lo: e.target.value, bad: false })}
              onKeyDown={(e) => e.key === 'Escape' && setAxisEntry(null)}
            />
            <span>…</span>
            <input
              aria-label={`${axisEntry.axis.toUpperCase()} axis to`}
              aria-invalid={axisEntry.bad}
              className={`w-20 rounded border bg-background px-1 font-mono ${axisEntry.bad ? 'border-destructive' : ''}`}
              value={axisEntry.hi}
              onChange={(e) => setAxisEntry({ ...axisEntry, hi: e.target.value, bad: false })}
              onKeyDown={(e) => e.key === 'Escape' && setAxisEntry(null)}
            />
            <button type="submit" className="rounded border px-1.5 hover:bg-accent">
              OK
            </button>
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Keep the axis as it is"
              onClick={() => setAxisEntry(null)}
            >
              <X className="size-3" />
            </button>
          </form>
        )}
        {entry &&
          (() => {
            const h = handles.find((x) => x.label === entry.label)
            if (!h) return null
            return (
              <form
                className="absolute z-20 flex items-center gap-1 rounded border bg-popover p-1.5 text-[11px] shadow"
                style={{ left: Math.min(fx(h.x) + 10, width - 230), top: Math.max(0, fy(h.y) - 14) }}
                onSubmit={(e) => {
                  e.preventDefault()
                  applyEntry(h, entry.x, entry.y)
                }}
                data-testid="handle-entry"
              >
                <span className="font-medium">{h.label}</span>
                <input
                  aria-label={`${h.label} x`}
                  className="w-20 rounded border bg-background px-1 font-mono"
                  value={entry.x}
                  onChange={(e) => setEntry({ ...entry, x: e.target.value })}
                  onKeyDown={(e) => e.key === 'Escape' && setEntry(null)}
                />
                <input
                  aria-label={`${h.label} y`}
                  className="w-20 rounded border bg-background px-1 font-mono"
                  value={entry.y}
                  onChange={(e) => setEntry({ ...entry, y: e.target.value })}
                  onKeyDown={(e) => e.key === 'Escape' && setEntry(null)}
                />
                <button type="submit" className="rounded border px-1.5 hover:bg-accent">
                  OK
                </button>
              </form>
            )
          })()}
        {grabbed?.readout && hover && (
          <div
            className="pointer-events-none absolute z-10 rounded border border-amber-500/60 bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap text-popover-foreground shadow"
            style={{ left: Math.min(hover.x + 12, width - 40), top: Math.max(0, hover.y - 28) }}
            data-testid="handle-readout"
          >
            {grabbed.readout}
          </div>
        )}
      </div>
      {(a !== null || b !== null) && (
        <div className="flex flex-wrap items-center gap-x-3 px-1 text-[11px]" data-testid="chart-readout">
          {a !== null && (
            <span>
              <b className="text-sky-500">A</b> {fmt(a, xUnit)}
              {va !== null && ` · ${fmt(va, yUnit)}`}
            </span>
          )}
          {b !== null && (
            <span>
              <b className="text-sky-500">B</b> {fmt(b, xUnit)}
              {vb !== null && ` · ${fmt(vb, yUnit)}`}
            </span>
          )}
          {a !== null && b !== null && (
            <span className="text-muted-foreground">{deltaText(a, b, va, vb, xUnit, yUnit, logX, logY)}</span>
          )}
          <button
            type="button"
            className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Hide the cursors"
            onClick={() => view.setCursors({ a: null, b: null, active: 'a' })}
          >
            <X className="size-3" />
          </button>
        </div>
      )}
    </div>
  )
}

function Toolbar({
  view,
  primary,
  at,
  onExport,
}: {
  view: View
  primary: ChartSeries | undefined
  at: (s: ChartSeries, x: number) => number | null
  onExport: (kind: 'png' | 'svg' | 'csv' | 'copy') => void
}) {
  const resonance = primary ? resonanceOf(primary.x, primary.y, view.cursors.b) : null
  const extreme = (kind: 'min' | 'max') => {
    if (!primary) return
    let best = -1
    primary.y.forEach((v, i) => {
      if (!Number.isFinite(v)) return
      if (best < 0 || (kind === 'min' ? v < primary.y[best] : v > primary.y[best])) best = i
    })
    if (best >= 0 && at(primary, primary.x[best]) !== null)
      view.setCursors({ ...view.cursors, a: primary.x[best], active: 'a' })
  }
  const button = 'rounded border px-1.5 py-0.5 text-[11px] hover:bg-accent'
  return (
    <span className="mr-2 flex flex-wrap items-center gap-1" data-testid="chart-toolbar">
      <button type="button" className={button} onClick={() => view.setDomain(null)}>
        Fit view
      </button>
      <button
        type="button"
        className={button}
        aria-pressed={view.logX}
        onClick={() => view.setLog('x', !view.logX)}
      >
        log X
      </button>
      <button
        type="button"
        className={button}
        aria-pressed={view.logY}
        onClick={() => view.setLog('y', !view.logY)}
      >
        log Y
      </button>
      <button type="button" className={button} onClick={() => extreme('min')}>
        A → min
      </button>
      <button type="button" className={button} onClick={() => extreme('max')}>
        A → max
      </button>
      <button
        type="button"
        className={`${button} disabled:opacity-40`}
        disabled={resonance === null}
        title={resonance === null ? 'This curve has no dip or peak' : 'Cursor B to the nearest dip or peak'}
        onClick={() => view.setCursors({ ...view.cursors, b: resonance, active: 'b' })}
      >
        B → resonance
      </button>
      {(['png', 'svg', 'csv'] as const).map((k) => (
        <button key={k} type="button" className={button} onClick={() => onExport(k)}>
          <Download className="mr-0.5 inline size-3" />
          {k.toUpperCase()}
        </button>
      ))}
      <button type="button" className={button} onClick={() => onExport('copy')}>
        Copy
      </button>
    </span>
  )
}

// -- helpers ------------------------------------------------------------------------------------

function lastIndex(s: ChartSeries, logX: boolean, logY: boolean): number {
  for (let i = Math.min(s.x.length, s.y.length) - 1; i >= 0; i--)
    if (Number.isFinite(s.x[i]) && Number.isFinite(s.y[i]) && (!logX || s.x[i] > 0) && (!logY || s.y[i] > 0))
      return i
  return -1
}

function nearestIndex(xs: number[], x: number, log: boolean): number {
  let best = -1
  let dist = Number.POSITIVE_INFINITY
  xs.forEach((v, i) => {
    const d = log ? Math.abs(Math.log10(v / x)) : Math.abs(v - x)
    if (d < dist) {
      dist = d
      best = i
    }
  })
  return best
}

/** Symmetric around zero, at least ±1 (residuals are in % or degrees). */
function residualRange(values: number[]): Range {
  const most = Math.max(1, ...values.filter(Number.isFinite).map(Math.abs)) * 1.15
  return [-most, most]
}

function growRange([lo, hi]: Range, side: 'lo' | 'hi', log: boolean): Range {
  if (log) {
    const step = (Math.log10(hi) - Math.log10(lo)) * 0.04
    return side === 'hi' ? [lo, hi * 10 ** step] : [lo / 10 ** step, hi]
  }
  const step = (hi - lo) * 0.04
  return side === 'hi' ? [lo, hi + step] : [lo - step, hi]
}

function bandRect(r: { x: number; w: number } | null, top: number, bottom: number) {
  return r ? { x: r.x, width: r.w, y: top, height: bottom - top } : { x: 0, width: 0, y: 0, height: 0 }
}

function deltaText(
  a: number,
  b: number,
  va: number | null,
  vb: number | null,
  xUnit: string,
  yUnit: string,
  logX: boolean,
  logY: boolean,
): string {
  const parts = [`Δx ${fmt(b - a, xUnit)}`]
  if (va !== null && vb !== null) {
    parts.push(`Δy ${fmt(vb - va, yUnit)}`)
    if (va !== 0 && vb / va > 0) parts.push(`ratio ${formatRatio(vb / va)}`)
    const s = slope([a, va], [b, vb], logX, logY)
    if (s) {
      const value = s.ratio ? s.value.toFixed(2) : fmt(s.value, yUnit)
      parts.push(`slope ${value}${s.per === 'dec' ? ' /dec' : `/${xUnit || 'unit'}`}`)
    }
  }
  return parts.join(' · ')
}

function formatRatio(r: number): string {
  return r >= 1 ? `${Number(r.toPrecision(3))}` : `1/${Number((1 / r).toPrecision(3))}`
}

/** The chart as a standalone SVG document (colours resolved, no CSS needed). */
function standalone(el: SVGSVGElement, holder: Element): string {
  const clone = el.cloneNode(true) as SVGSVGElement
  const style = getComputedStyle(el)
  const background = getComputedStyle(holder).backgroundColor
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
  clone.setAttribute('style', `color:${style.color};font-family:${FONT_FAMILY};background:${background}`)
  clone.querySelector('[data-testid="chart-surface"]')?.remove()
  let text = new XMLSerializer().serializeToString(clone)
  text = text.replaceAll('var(--background)', background || '#fff')
  return text
}

async function toPng(
  svgText: string,
  width: number,
  height: number,
  background: string,
): Promise<Blob | null> {
  const image = new Image()
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }))
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('cannot draw the chart'))
      image.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = width * 2
    canvas.height = height * 2
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.fillStyle = background && background !== 'rgba(0, 0, 0, 0)' ? background : '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.scale(2, 2)
    ctx.drawImage(image, 0, 0)
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/** Axis types of a characteristic by its name. */
export const CHART_AXES: Record<string, { logX: boolean; logY: boolean; x: string; y: string }> = {
  '|Z|(f)': { logX: true, logY: true, x: 'Hz', y: 'Ω' },
  'phase(f)': { logX: true, logY: false, x: 'Hz', y: '°' },
  'ESR(f)': { logX: true, logY: true, x: 'Hz', y: 'Ω' },
  'C(V)': { logX: false, logY: false, x: 'V', y: 'F' },
  'L(I)': { logX: false, logY: false, x: 'A', y: 'H' },
  'VF(IF)': { logX: true, logY: false, x: 'A', y: 'V' },
  'Cj(VR)': { logX: false, logY: false, x: 'V', y: 'F' },
  'VZ(IZ)': { logX: true, logY: false, x: 'A', y: 'V' },
  'RDS(Vgs)': { logX: false, logY: false, x: 'V', y: 'Ω' },
  'VBE(Ic)': { logX: true, logY: false, x: 'A', y: 'V' },
  'VCEsat(Ic)': { logX: true, logY: false, x: 'A', y: 'V' },
  'I-V': { logX: false, logY: false, x: 'V', y: 'A' },
  // Diodes and transistors (datasheet curves).
  'I-V forward': { logX: false, logY: true, x: 'V', y: 'A' },
  'I-V reverse': { logX: false, logY: true, x: 'V', y: 'A' },
  'Ic(Vce)': { logX: false, logY: false, x: 'V', y: 'A' },
  'Ic(Vbe)': { logX: false, logY: true, x: 'V', y: 'A' },
  'hFE(Ic)': { logX: true, logY: false, x: 'A', y: '' },
  'Id(Vds)': { logX: false, logY: false, x: 'V', y: 'A' },
  'Vgs(Qg)': { logX: false, logY: false, x: 'C', y: 'V' },
  'Id(Vgs)': { logX: false, logY: false, x: 'V', y: 'A' },
  // Transformers and op-amps.
  'Ratio(f)': { logX: true, logY: true, x: 'Hz', y: 'V/V' },
  '|Zin|(f)': { logX: true, logY: true, x: 'Hz', y: 'Ω' },
  'Aol(f)': { logX: true, logY: false, x: 'Hz', y: 'dB' },
  'h21(f)': { logX: true, logY: true, x: 'Hz', y: '' },
  'Aol phase(f)': { logX: true, logY: false, x: 'Hz', y: '°' },
  'Vout(Vin)': { logX: false, logY: false, x: 'V', y: 'V' },
  'Vout(t)': { logX: false, logY: false, x: 's', y: 'V' },
}

export const CHART_COLORS = ['#3b82f6', '#f97316', '#10b981', '#e11d48']
/** Members of a family of curves (one colour each). */
export const FAMILY_COLORS = ['#3b82f6', '#10b981', '#f97316', '#8b5cf6', '#e11d48', '#0891b2']
