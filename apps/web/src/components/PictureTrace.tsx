/**
 * Tracing a datasheet chart picture in the part editor (docs/projekt-modele.md §2). The picture
 * fills the chart's place; its axes are an orange frame whose edges are dragged onto labelled
 * grid lines, with the values typed at the edges and each axis linear or logarithmic. A control
 * grid then shows whether the calibration matches the picture's own grid. Points are clicked,
 * drawn along the curve or traced by its colour, and go straight to the characteristic's
 * points; the model's curve is drawn on the picture in the same scale.
 */
import { Maximize2, Minimize2 } from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ticks } from '@/lib/chartAxes'
import { openPdf, type PdfDocument, renderPage } from '@/lib/pdf'
import { looksLog, type Pixel, replaceBetween, resample, type TraceAxis, toPixel, toValue } from '@/lib/trace'
import { findFrame, traceColor } from './Digitizer'

export interface TracePicture {
  image: string
  width: number
  height: number
  pdf?: { doc: PdfDocument; page: number }
}

/** A traced picture with its calibration: X along the picture (a: left edge, b: right), Y up
 *  it (a: bottom edge, b: top). `swap`: the picture's X is the points' Y (a diode's IF against
 *  VF chart for the VF(IF) points). */
export interface TraceState {
  picture: TracePicture
  x: TraceAxis
  y: TraceAxis
  swap: boolean
}

type Tool = 'points' | 'draw' | 'colour'
type Edge = 'left' | 'right' | 'bottom' | 'top'
type Drag =
  | { kind: 'edge'; edge: Edge }
  | { kind: 'point'; index: number; pixels: Pixel[] }
  | { kind: 'stroke'; pixels: Pixel[] }
  | { kind: 'click'; at: Pixel }

const ORANGE = '#f59e0b'
const HINT: Record<Tool, string> = {
  points: 'Click the curve to add a point, drag a point to move it, right-click removes it.',
  draw: 'Draw along the curve: the line becomes points (drawing over a part again redraws it).',
  colour: 'Click the curve: points follow its colour across the frame.',
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('not a picture'))
    img.src = url
  })
}

function pixelsOf(img: HTMLImageElement): ImageData | null {
  const canvas = document.createElement('canvas')
  canvas.width = img.naturalWidth
  canvas.height = img.naturalHeight
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  ctx.drawImage(img, 0, 0)
  return ctx.getImageData(0, 0, canvas.width, canvas.height)
}

/** The frame on a picture: its chart's axes when found, else a margin inside the picture. */
function frameOf(img: HTMLImageElement): { left: number; right: number; top: number; bottom: number } {
  const data = pixelsOf(img)
  const found = data && findFrame(data.data, data.width, data.height)
  const w = img.naturalWidth
  const h = img.naturalHeight
  return found ?? { left: 0.12 * w, right: 0.92 * w, top: 0.08 * h, bottom: 0.88 * h }
}

/** A picture file (or a PDF's page) opened for tracing; the axes' values and scales kept. */
export async function openPicture(
  source: File | { doc: PdfDocument; page: number },
  before: TraceState | null,
  defaults: { logX: boolean; logY: boolean; swap: boolean },
): Promise<TraceState> {
  let pdf: TracePicture['pdf']
  let url: string
  if (source instanceof File) {
    if (source.type === 'application/pdf' || /\.pdf$/i.test(source.name)) {
      pdf = { doc: await openPdf(source), page: 1 }
      url = await renderPage(pdf.doc, 1)
    } else url = await readFile(source)
  } else {
    pdf = source
    url = await renderPage(source.doc, source.page)
  }
  const img = await loadImage(url)
  const f = frameOf(img)
  const swap = before?.swap ?? defaults.swap
  const axis = (a: number, b: number, kept: TraceAxis | undefined, log: boolean): TraceAxis => ({
    a,
    b,
    va: kept?.va ?? '',
    vb: kept?.vb ?? '',
    log: kept?.log ?? log,
  })
  return {
    picture: { image: url, width: img.naturalWidth, height: img.naturalHeight, pdf },
    x: axis(f.left, f.right, before?.x, swap ? defaults.logY : defaults.logX),
    y: axis(f.bottom, f.top, before?.y, swap ? defaults.logX : defaults.logY),
    swap,
  }
}

export function PictureTrace({
  kind,
  xUnit,
  yUnit,
  logX,
  logY,
  swapDefault,
  points,
  onPoints,
  model,
  state,
  onState,
  onDone,
  height,
  file,
}: {
  kind: string
  /** Units and scales of the points (x, y of the characteristic). */
  xUnit: string
  yUnit: string
  logX: boolean
  logY: boolean
  swapDefault: boolean
  points: [number, number][]
  onPoints: (points: [number, number][]) => void
  /** The model's curves in the points' coordinates. */
  model: { x: number[]; y: number[] }[]
  state: TraceState | null
  onState: (state: TraceState | null) => void
  onDone: () => void
  height: number
  /** A picture dropped or pasted before the mode opened. */
  file?: File | null
}): ReactNode {
  const [tool, setTool] = useState<Tool>('points')
  const [big, setBig] = useState(false)
  const [tolerance, setTolerance] = useState(60)
  const [area, setArea] = useState<[number, number]>([600, height])
  const [stroke, setStroke] = useState<Pixel[] | null>(null)
  const [moving, setMoving] = useState<Pixel[] | null>(null)
  const areaRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const drag = useRef<Drag | null>(null)
  const defaults = { logX, logY, swap: swapDefault }
  const stateRef = useRef(state)
  stateRef.current = state

  const open = (source: File | { doc: PdfDocument; page: number }) =>
    openPicture(source, stateRef.current, defaults)
      .then(onState)
      .catch((error: unknown) =>
        toast.error(`Cannot open the picture: ${error instanceof Error ? error.message : String(error)}`),
      )

  // biome-ignore lint/correctness/useExhaustiveDependencies: a file handed over once
  useEffect(() => {
    if (file) void open(file)
  }, [file])
  // Ctrl+V of a screenshot: a new picture (text pasted into the fields stays text).
  // biome-ignore lint/correctness/useExhaustiveDependencies: listens for the mode's lifetime
  useEffect(() => {
    const paste = (e: ClipboardEvent) => {
      const image = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith('image/'))
      if (!image) return
      e.preventDefault()
      void open(image)
    }
    window.addEventListener('paste', paste)
    return () => window.removeEventListener('paste', paste)
  }, [])
  useEffect(() => {
    if (!big) return
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setBig(false)
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [big])
  // The room for the picture: measured again when the picture replaces the drop zone and in
  // full screen (another element each time).
  const hasPicture = state !== null
  // biome-ignore lint/correctness/useExhaustiveDependencies: the measured element changes with these
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const observer = new ResizeObserver(() => setArea([el.clientWidth, el.clientHeight]))
    observer.observe(el)
    setArea([el.clientWidth, el.clientHeight])
    return () => observer.disconnect()
  }, [hasPicture, big])

  const xu = state?.swap ? yUnit : xUnit
  const yu = state?.swap ? xUnit : yUnit
  const dropZone = (
    <button
      type="button"
      className="flex size-full flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed text-sm text-muted-foreground hover:bg-accent/40"
      onClick={() => fileRef.current?.click()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const dropped = e.dataTransfer.files[0]
        if (dropped) void open(dropped)
      }}
    >
      <span className="font-medium text-foreground">Trace the {kind} chart from the datasheet</span>
      <span>Drop a picture or a PDF here · Ctrl+V a screenshot · click to open a file</span>
    </button>
  )
  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept="image/*,application/pdf,.pdf"
      className="hidden"
      aria-label="Datasheet picture or PDF"
      onChange={(e) => {
        const chosen = e.target.files?.[0]
        if (chosen) void open(chosen)
        e.target.value = ''
      }}
    />
  )

  if (!state)
    return (
      <div className="flex flex-col gap-2" data-testid="picture-trace">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">Datasheet picture</span>
          <Button size="sm" variant="ghost" className="ml-auto h-6 px-2 text-xs" onClick={onDone}>
            Back to the chart
          </Button>
        </div>
        <div ref={areaRef} style={{ height }}>
          {dropZone}
        </div>
        {fileInput}
      </div>
    )

  const { picture, x, y } = state
  const scale = Math.max(0.05, Math.min(area[0] / picture.width, area[1] / picture.height))
  const calibrated = toValue(x, x.a) !== null && toValue(y, y.a) !== null
  const set = (patch: Partial<TraceState>) => onState({ ...state, ...patch })
  const setX = (patch: Partial<TraceAxis>) => set({ x: { ...x, ...patch } })
  const setY = (patch: Partial<TraceAxis>) => set({ y: { ...y, ...patch } })

  // Points <-> pixels of the picture (through the swap of its axes).
  const toPicture = ([px, py]: [number, number]): [number, number] => (state.swap ? [py, px] : [px, py])
  const pixelOf = (p: [number, number]): Pixel | null => {
    const [vx, vy] = toPicture(p)
    const u = toPixel(x, vx)
    const v = toPixel(y, vy)
    return u === null || v === null ? null : [u, v]
  }
  const pointOf = (p: Pixel): [number, number] | null => {
    const vx = toValue(x, p[0])
    const vy = toValue(y, p[1])
    if (vx === null || vy === null) return null
    return state.swap ? [vy, vx] : [vx, vy]
  }
  const shown: Pixel[] = moving ?? points.map(pixelOf).filter((p): p is Pixel => p !== null)
  const commit = (pixels: Pixel[]) =>
    onPoints(
      pixels
        .map(pointOf)
        .filter((p): p is [number, number] => p !== null)
        .sort((a, b) => a[0] - b[0]),
    )

  const natural = (e: React.PointerEvent | React.MouseEvent): Pixel => {
    const box = svgRef.current?.getBoundingClientRect()
    if (!box) return [0, 0]
    const px = ((e.clientX - box.left) / box.width) * picture.width
    const py = ((e.clientY - box.top) / box.height) * picture.height
    return [Math.min(Math.max(px, 0), picture.width), Math.min(Math.max(py, 0), picture.height)]
  }
  const begin = (e: React.PointerEvent, next: Drag) => {
    if (e.button !== 0) return
    e.stopPropagation()
    svgRef.current?.setPointerCapture(e.pointerId)
    drag.current = next
    if (next.kind === 'stroke') setStroke(next.pixels)
    if (next.kind === 'point') setMoving(next.pixels)
  }
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    const p = natural(e)
    if (!calibrated) return
    if (tool === 'draw') begin(e, { kind: 'stroke', pixels: [p] })
    else begin(e, { kind: 'click', at: p })
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = natural(e)
    if (d.kind === 'edge') {
      if (d.edge === 'left') setX({ a: p[0] })
      if (d.edge === 'right') setX({ b: p[0] })
      if (d.edge === 'bottom') setY({ a: p[1] })
      if (d.edge === 'top') setY({ b: p[1] })
    } else if (d.kind === 'point') {
      d.pixels = d.pixels.map((q, i) => (i === d.index ? p : q))
      setMoving(d.pixels)
    } else if (d.kind === 'stroke') {
      d.pixels = [...d.pixels, p]
      setStroke(d.pixels)
    }
  }
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    const p = natural(e)
    if (d.kind === 'point') {
      commit(d.pixels)
      setMoving(null)
    } else if (d.kind === 'stroke') {
      setStroke(null)
      const added = resample(d.pixels, Math.abs(x.b - x.a))
      const xs = d.pixels.map((q) => q[0])
      commit(replaceBetween(shown, added, Math.min(...xs), Math.max(...xs)))
    } else if (d.kind === 'click' && Math.hypot(p[0] - d.at[0], p[1] - d.at[1]) * scale < 4) {
      if (tool === 'points') commit([...shown, p])
      if (tool === 'colour') traceFrom(p)
    }
  }
  const remove = (index: number) => (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    commit(shown.filter((_, i) => i !== index))
  }
  const traceFrom = (at: Pixel) => {
    const img = imgRef.current
    const data = img && pixelsOf(img)
    if (!data) return
    const i = (Math.round(at[1]) * data.width + Math.round(at[0])) * 4
    const colour: [number, number, number] = [data.data[i], data.data[i + 1], data.data[i + 2]]
    const every = Math.max(2, Math.round(Math.abs(x.b - x.a) / 60))
    const [top, bottom] = [Math.min(y.a, y.b), Math.max(y.a, y.b)]
    const found = traceColor(data.data, data.width, data.height, colour, tolerance, [x.a, x.b], every).filter(
      (q) => q[1] >= top && q[1] <= bottom,
    )
    if (!found.length) toast.info('No pixels of that colour in the frame: click right on the curve')
    else commit(found)
  }
  const findAxes = () => {
    const img = imgRef.current
    if (!img) return
    const f = frameOf(img)
    set({ x: { ...x, a: f.left, b: f.right }, y: { ...y, a: f.bottom, b: f.top } })
  }

  // The control grid and the model, in the frame.
  const [left, right] = [Math.min(x.a, x.b), Math.max(x.a, x.b)]
  const [top, bottom] = [Math.min(y.a, y.b), Math.max(y.a, y.b)]
  const gridOf = (axis: TraceAxis) => {
    const va = toValue(axis, axis.a)
    const vb = toValue(axis, axis.b)
    if (va === null || vb === null) return []
    return ticks(Math.min(va, vb), Math.max(va, vb), axis.log, 10)
      .map((v) => toPixel(axis, v))
      .filter((p): p is number => p !== null)
  }
  const modelLines = calibrated
    ? model.map((curve) =>
        curve.x
          .map((cx, i) => pixelOf([cx, curve.y[i]]))
          .filter((p): p is Pixel => p !== null)
          .map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`)
          .join(' '),
      )
    : []
  const r = 5 / scale
  const edgeLine = (edge: Edge, x1: number, y1: number, x2: number, y2: number, cursor: string) => (
    <g key={edge}>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={ORANGE}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
      <line
        data-testid={`trace-edge-${edge}`}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="transparent"
        strokeWidth={14}
        vectorEffect="non-scaling-stroke"
        style={{ cursor }}
        onPointerDown={(e) => begin(e, { kind: 'edge', edge })}
      />
    </g>
  )
  const valueInput = (
    label: string,
    value: string,
    change: (v: string) => void,
    style: React.CSSProperties,
  ) => (
    <Input
      aria-label={label}
      title={`${label}: the value at this edge (10, 1k, 1meg)`}
      className="absolute h-6 w-20 border-amber-500 bg-background! px-1 font-mono text-foreground text-xs shadow"
      style={style}
      value={value}
      onChange={(e) => change(e.target.value)}
    />
  )
  const scaleToggle = (name: 'X' | 'Y', axis: TraceAxis, setAxis: (p: Partial<TraceAxis>) => void) => (
    <span className="flex items-center gap-1">
      <span className="text-muted-foreground">
        {name} ({name === 'X' ? xu || '–' : yu || '–'})
      </span>
      <span className="flex rounded-md border p-0.5">
        {(['Lin', 'Log'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-label={`${name} axis ${s === 'Log' ? 'logarithmic' : 'linear'}`}
            aria-pressed={axis.log === (s === 'Log')}
            className={`rounded px-1.5 ${axis.log === (s === 'Log') ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
            onClick={() => setAxis({ log: s === 'Log' })}
          >
            {s}
          </button>
        ))}
      </span>
      {looksLog(axis) && (
        <button
          type="button"
          className="rounded border border-amber-500 px-1 text-amber-600"
          title="The edge values are a decade or more apart: the axis is probably logarithmic"
          onClick={() => setAxis({ log: true })}
        >
          Log?
        </button>
      )}
    </span>
  )

  const w = picture.width * scale
  const h = picture.height * scale
  return (
    <div
      className={big ? 'fixed inset-0 z-50 flex flex-col gap-2 bg-background p-3' : 'flex flex-col gap-2'}
      data-testid="picture-trace"
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <fieldset className="flex min-w-0 rounded-md border p-0.5" aria-label="Tracing tool">
          {(
            [
              ['points', 'Points'],
              ['draw', 'Draw'],
              ['colour', 'Trace colour'],
            ] as [Tool, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              aria-pressed={tool === key}
              disabled={!calibrated}
              title={calibrated ? HINT[key] : 'Set the axes first: their values at the frame’s edges'}
              className={`rounded px-2 py-0.5 disabled:opacity-50 ${tool === key ? 'bg-accent font-medium' : 'text-muted-foreground'}`}
              onClick={() => setTool(key)}
            >
              {label}
            </button>
          ))}
        </fieldset>
        {tool === 'colour' && calibrated && (
          <label className="flex items-center gap-1 text-muted-foreground">
            tolerance
            <input
              type="range"
              min={10}
              max={200}
              value={tolerance}
              aria-label="Colour tolerance"
              onChange={(e) => setTolerance(Number(e.target.value))}
            />
          </label>
        )}
        {scaleToggle('X', x, setX)}
        {scaleToggle('Y', y, setY)}
        <button
          type="button"
          className="rounded border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
          title="The picture's axes the other way round (an IF against VF chart for VF(IF) points)"
          aria-label="Swap the picture's axes"
          onClick={() => set({ swap: !state.swap, x: { ...x, log: y.log }, y: { ...y, log: x.log } })}
        >
          X ⇄ Y
        </button>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={findAxes}>
          Find the axes
        </Button>
        {picture.pdf && (
          <span className="flex items-center gap-1" data-testid="pdf-pages">
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2"
              aria-label="Previous page"
              disabled={picture.pdf.page <= 1}
              onClick={() => picture.pdf && void open({ doc: picture.pdf.doc, page: picture.pdf.page - 1 })}
            >
              ‹
            </Button>
            page {picture.pdf.page} / {picture.pdf.doc.numPages}
            <Button
              size="sm"
              variant="outline"
              className="h-6 px-2"
              aria-label="Next page"
              disabled={picture.pdf.page >= picture.pdf.doc.numPages}
              onClick={() => picture.pdf && void open({ doc: picture.pdf.doc, page: picture.pdf.page + 1 })}
            >
              ›
            </Button>
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            onClick={() => fileRef.current?.click()}
          >
            Another picture…
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs"
            disabled={!points.length}
            onClick={() => onPoints([])}
          >
            Clear points
          </Button>
          <button
            type="button"
            className="rounded p-1 text-muted-foreground hover:text-foreground"
            aria-label={big ? 'Close full screen' : 'Full screen'}
            onClick={() => setBig(!big)}
          >
            {big ? <Minimize2 className="size-3.5" /> : <Maximize2 className="size-3.5" />}
          </button>
          <Button size="sm" className="h-6 px-2 text-xs" onClick={onDone}>
            Done
          </Button>
        </span>
      </div>
      <p className="text-xs text-muted-foreground" data-testid="trace-hint">
        {calibrated
          ? `${HINT[tool]} ${points.length} point${points.length === 1 ? '' : 's'} of ${kind}; the model is the blue line.`
          : 'Drag the orange frame’s edges onto two labelled grid lines of each axis, type their values at the edges and choose Lin or Log.'}
      </p>
      <div ref={areaRef} className={big ? 'min-h-0 flex-1' : ''} style={big ? undefined : { height }}>
        <div className="relative" style={{ width: w, height: h }}>
          <img
            ref={imgRef}
            src={picture.image}
            alt="Datasheet chart"
            className="absolute inset-0 size-full select-none"
            draggable={false}
          />
          <svg
            ref={svgRef}
            className={`absolute inset-0 size-full ${calibrated ? 'cursor-crosshair' : ''}`}
            viewBox={`0 0 ${picture.width} ${picture.height}`}
            preserveAspectRatio="none"
            role="application"
            aria-label="Datasheet chart: drag the frame onto the axes, then add points"
            onPointerDown={onDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onContextMenu={(e) => e.preventDefault()}
          >
            <defs>
              <clipPath id="trace-frame">
                <rect x={left} y={top} width={right - left} height={bottom - top} />
              </clipPath>
            </defs>
            <g clipPath="url(#trace-frame)" data-testid="trace-grid">
              {gridOf(x).map((px) => (
                <line
                  key={`gx${px}`}
                  x1={px}
                  x2={px}
                  y1={top}
                  y2={bottom}
                  stroke="#06b6d4"
                  strokeOpacity={0.6}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {gridOf(y).map((py) => (
                <line
                  key={`gy${py}`}
                  y1={py}
                  y2={py}
                  x1={left}
                  x2={right}
                  stroke="#06b6d4"
                  strokeOpacity={0.6}
                  strokeDasharray="4 4"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {modelLines.map((line, i) => (
                <polyline
                  // biome-ignore lint/suspicious/noArrayIndexKey: the model's curves in their order
                  key={i}
                  data-testid="trace-model"
                  points={line}
                  fill="none"
                  stroke="#3b82f6"
                  strokeWidth={2}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </g>
            {edgeLine('left', x.a, top, x.a, bottom, 'ew-resize')}
            {edgeLine('right', x.b, top, x.b, bottom, 'ew-resize')}
            {edgeLine('bottom', left, y.a, right, y.a, 'ns-resize')}
            {edgeLine('top', left, y.b, right, y.b, 'ns-resize')}
            {stroke && (
              <polyline
                points={stroke.map((p) => `${p[0]},${p[1]}`).join(' ')}
                fill="none"
                stroke="#f97316"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            )}
            {shown.map((p, i) => (
              // biome-ignore lint/a11y/noStaticElementInteractions: dragged with the mouse; the points table edits them by keyboard
              <circle
                // biome-ignore lint/suspicious/noArrayIndexKey: points in their order along x
                key={i}
                data-testid="trace-point"
                cx={p[0]}
                cy={p[1]}
                r={r}
                fill="#f97316"
                stroke="white"
                strokeWidth={1}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'move' }}
                onPointerDown={(e) => begin(e, { kind: 'point', index: i, pixels: shown })}
                onContextMenu={remove(i)}
              />
            ))}
          </svg>
          {valueInput('X at the left edge', x.va, (v) => setX({ va: v }), {
            left: x.a * scale,
            top: Math.min(y.a * scale + 16, h - 24),
            transform: 'translateX(-50%)',
          })}
          {valueInput('X at the right edge', x.vb, (v) => setX({ vb: v }), {
            left: x.b * scale,
            top: Math.min(y.a * scale + 16, h - 24),
            transform: 'translateX(-50%)',
          })}
          {valueInput('Y at the bottom edge', y.va, (v) => setY({ va: v }), {
            left: Math.max(x.a * scale - 4, 80),
            top: y.a * scale,
            transform: 'translate(-100%, -50%)',
          })}
          {valueInput('Y at the top edge', y.vb, (v) => setY({ vb: v }), {
            left: Math.max(x.a * scale - 4, 80),
            top: y.b * scale,
            transform: 'translate(-100%, -50%)',
          })}
        </div>
      </div>
      {fileInput}
    </div>
  )
}
