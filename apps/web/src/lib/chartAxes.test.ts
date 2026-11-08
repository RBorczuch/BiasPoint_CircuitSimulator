import { describe, expect, it } from 'vitest'
import {
  panRange,
  placeEndLabels,
  placeXLabels,
  resonanceOf,
  slope,
  ticks,
  valueAt,
  yTicks,
  zoomRange,
} from './chartAxes'
import { formatValue } from './units'

describe('ticks', () => {
  it('chooses 1-2-5 steps for the room there is', () => {
    expect(ticks(0, 10, false, 6)).toEqual([0, 2, 4, 6, 8, 10])
    expect(ticks(0, 10, false, 3)).toEqual([0, 5, 10])
  })
  it('keeps every n-th decade on a wide log axis and adds 2 and 5 on a narrow one', () => {
    expect(ticks(10, 1e9, true, 4)).toEqual([1e3, 1e6, 1e9])
    expect(ticks(1, 10, true, 8)).toEqual([1, 2, 5, 10])
  })
})

describe('placeXLabels', () => {
  it('keeps every label inside the chart and apart from the next', () => {
    const width = 280
    const [lo, hi] = [10, 1e9]
    const at = (v: number) => 40 + ((Math.log10(v) - 1) / 8) * (width - 48)
    const labels = placeXLabels(lo, hi, true, at, (v) => formatValue(v, 'Hz', 3), width, width - 48)
    expect(labels.length).toBeGreaterThan(1)
    for (const [i, l] of labels.entries()) {
      const w = l.text.length * 11 * 0.6
      expect(l.left).toBeGreaterThanOrEqual(0)
      expect(l.left + w).toBeLessThanOrEqual(width + 1e-9)
      if (i)
        expect(l.left).toBeGreaterThanOrEqual(labels[i - 1].left + labels[i - 1].text.length * 6.6 + 8 - 1e-9)
    }
    expect(labels.at(-1)?.text).toBe('1 GHz') // the last one aligned with the edge, not cut
  })
})

describe('placeEndLabels', () => {
  it('moves family labels apart inside the plot, or gives up when they cannot fit', () => {
    const placed = placeEndLabels(
      [
        { key: 'a', y: 5 },
        { key: 'b', y: 8 },
        { key: 'c', y: 100 },
      ],
      20,
      120,
    )
    expect(placed?.get('a')).toBe(20)
    expect(placed?.get('b')).toBe(31)
    expect(placed?.get('c')).toBe(100)
    expect(
      placeEndLabels(
        [0, 1, 2, 3, 4].map((k) => ({ key: `${k}`, y: 50 })),
        0,
        30,
      ),
    ).toBeNull()
  })
})

describe('reading a curve', () => {
  it('interpolates on log axes and gives the slope per decade', () => {
    expect(valueAt([1, 100], [100, 1], 10, true, true)).toBeCloseTo(10)
    expect(valueAt([1, 2], [0, 1], 5, false, false)).toBeNull()
    expect(slope([1e3, 16], [1e5, 0.16], true, true)?.value).toBeCloseTo(-1)
    expect(yTicks(0, 1, false, 200).length).toBeGreaterThan(3)
  })
  it('zooms and pans in log space', () => {
    const [lo, hi] = zoomRange(1, 1e4, 100, 0.5, true)
    expect(lo).toBeCloseTo(10)
    expect(hi).toBeCloseTo(1000)
    expect(panRange(0, 10, 0.1, false)).toEqual([1, 11])
  })
})

describe('resonanceOf', () => {
  const xs = [1, 10, 100, 1000, 10000]
  it('finds a dip of |Z| that ends lower than it starts', () => {
    expect(resonanceOf(xs, [16, 1.6, 0.018, 0.05, 0.5])).toBe(100)
  })
  it('finds a peak when there is no dip', () => {
    expect(resonanceOf(xs, [1, 10, 1000, 10, 1])).toBe(100)
  })
  it('takes the one nearest to the cursor, the deepest without one', () => {
    const y = [10, 1, 10, 0.1, 10]
    expect(resonanceOf(xs, y)).toBe(1000)
    expect(resonanceOf(xs, y, 8)).toBe(10)
  })
  it('sees none on a falling curve, a flat one or a ripple', () => {
    expect(resonanceOf(xs, [5, 4, 3, 2, 1])).toBeNull()
    expect(resonanceOf(xs, [1, 1, 1, 1, 1])).toBeNull()
    expect(resonanceOf(xs, [100, 10.001, 10, 10.001, 1])).toBeNull()
  })
  it('works on values of both signs (a phase)', () => {
    expect(resonanceOf(xs, [-10, -80, -90, -80, 0])).toBe(100)
  })
})
