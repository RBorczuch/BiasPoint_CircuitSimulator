import { describe, expect, it } from 'vitest'
import { insertPoint, parseWeightedPoints, percentToFarads } from './points'

describe('weighted points', () => {
  it('reads an optional third column as the weight of the point', () => {
    expect(parseWeightedPoints('1k 10\n10k 1 0\n100 100')).toEqual({
      points: [
        [100, 100],
        [1000, 10],
        [10000, 1],
      ],
      weights: [1, 1, 0],
    })
    expect(parseWeightedPoints('1 2\n3 4').weights).toEqual([])
  })
})

describe('percentToFarads', () => {
  it('turns a DC bias curve in ΔC % into farads of C', () => {
    expect(percentToFarads('0 0\n5 -20%\n10 -55 2\n# note', 10e-6)).toBe('0 10u\n5 8u\n10 4.5u 2\n# note')
  })
})

describe('insertPoint', () => {
  it('keeps the rows in the order of x', () => {
    expect(insertPoint('', 5, '5 1')).toBe('5 1')
    expect(insertPoint('1 1\n10 2\n', 5, '5 9')).toBe('1 1\n5 9\n10 2')
    expect(insertPoint('1 1\n10 2\n', 50, '50 9')).toBe('1 1\n10 2\n50 9')
    expect(insertPoint('# from Fig. 2\n1 1', 0.5, '0.5 9')).toBe('# from Fig. 2\n0.5 9\n1 1')
  })
})
