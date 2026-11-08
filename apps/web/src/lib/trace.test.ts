import { describe, expect, it } from 'vitest'
import { looksLog, replaceBetween, resample, type TraceAxis, toPixel, toValue } from './trace'

const logX: TraceAxis = { a: 100, b: 500, va: '10', vb: '100k', log: true } // 4 decades, 100 px each
const linY: TraceAxis = { a: 400, b: 0, va: '0', vb: '2', log: false } // bottom 0, top 2

describe('trace', () => {
  it('converts pixels and values on log and linear axes', () => {
    expect(toValue(logX, 300)).toBeCloseTo(1000)
    expect(toPixel(logX, 1e4)).toBeCloseTo(400)
    expect(toValue(linY, 100)).toBeCloseTo(1.5)
    expect(toPixel(linY, 0.5)).toBeCloseTo(300)
    expect(toPixel(logX, -1)).toBeNull() // not on a log axis
    expect(toValue({ ...logX, vb: '' }, 300)).toBeNull() // not calibrated yet
  })

  it('suggests a log scale for edge values a decade apart', () => {
    expect(looksLog({ ...logX, log: false })).toBe(true)
    expect(looksLog(linY)).toBe(false)
    expect(looksLog(logX)).toBe(false) // already log
  })

  it('spreads a drawn line evenly across, read as a function of x', () => {
    const stroke: [number, number][] = [
      [100, 10],
      [150, 20],
      [149.8, 30], // doubles back: the mean height
      [300, 40],
    ]
    const points = resample(stroke, 400, 8) // 200 px of a 400 px frame: 4 + 1 points
    expect(points).toHaveLength(5)
    expect(points[0]).toEqual([100, 10])
    expect(points[4]).toEqual([300, 40])
    expect(points[2][0]).toBeCloseTo(200)
  })

  it('redraws only the part of the curve drawn over', () => {
    const before: [number, number][] = [
      [0, 0],
      [50, 5],
      [100, 10],
    ]
    expect(replaceBetween(before, [[60, 1]], 40, 70)).toEqual([
      [0, 0],
      [60, 1],
      [100, 10],
    ])
  })
})
