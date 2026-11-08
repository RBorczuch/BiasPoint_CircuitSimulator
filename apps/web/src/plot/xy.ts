/** uPlot path for XY data (mode 2): points joined in data order, x need not increase. */
import type uPlot from 'uplot'

type Column = (number | null)[]

export const xyPath: uPlot.Series.PathBuilder = (u, seriesIdx) => {
  const [xs, ys] = u.data[seriesIdx] as unknown as Column[]
  const series = u.series[seriesIdx]
  const [xKey, yKey] = [series.facets?.[0].scale ?? 'x', series.facets?.[1].scale ?? 'y']
  const stroke = new Path2D()
  let pen = false
  for (let i = 0; i < xs.length; i++) {
    const [x, y] = [xs[i], ys[i]]
    if (x == null || y == null) {
      pen = false
      continue
    }
    const [cx, cy] = [u.valToPos(x, xKey, true), u.valToPos(y, yKey, true)]
    if (pen) stroke.lineTo(cx, cy)
    else stroke.moveTo(cx, cy)
    pen = true
  }
  return { stroke, fill: null, clip: null, band: null, gaps: null, flags: 0 } as unknown as uPlot.Series.Paths
}
