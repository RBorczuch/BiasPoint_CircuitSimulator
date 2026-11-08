import { describe, expect, it } from 'vitest'
import { crossings, extremeIndex, topPeaks, valueAt } from './markers'

describe('plot markers', () => {
  const xs = [0, 1, 2, 3, 4, 5, 6]
  const ys = [0, 2, 1, 5, null, 3, -1]

  it('finds the peak and the minimum, skipping gaps', () => {
    expect(extremeIndex(ys)).toBe(3)
    expect(extremeIndex(ys, false)).toBe(6)
  })

  it('finds where a curve crosses a level', () => {
    expect(crossings(xs, ys, 1.5)).toEqual([0.75, 1.5, 2.125, 5.375])
    expect(crossings([1, 10, 100], [0, -3, -6], -3)).toEqual([10])
  })

  it('takes the highest local maxima in x order (harmonics)', () => {
    expect(topPeaks([0, 9, 0, 3, 0, 5, 0, 1, 0], 3)).toEqual([1, 3, 5])
  })

  it('interpolates a value at x', () => {
    expect(valueAt(xs, ys, 0.5)).toBe(1)
    expect(valueAt(xs, ys, 3.5)).toBeNull()
  })
})
