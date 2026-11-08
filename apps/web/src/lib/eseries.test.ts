import { describe, expect, it } from 'vitest'
import { nearestE24 } from './eseries'

describe('E24', () => {
  it('suggests the nearest preferred value', () => {
    expect(nearestE24(4.6e-6)).toBeCloseTo(4.7e-6, 12)
    expect(nearestE24(3065)).toBe(3000)
    expect(nearestE24(9.7)).toBe(10)
  })

  it('stays quiet on a preferred value', () => {
    expect(nearestE24(4.7e-6)).toBeNull()
    expect(nearestE24(1000)).toBeNull()
  })
})
