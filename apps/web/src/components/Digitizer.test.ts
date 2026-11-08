import { describe, expect, it } from 'vitest'
import { findFrame } from './Digitizer'

/** A white picture with black lines drawn by `draw(set)`. */
function picture(width: number, height: number, draw: (set: (x: number, y: number) => void) => void) {
  const data = new Uint8ClampedArray(width * height * 4).fill(255)
  draw((x, y) => {
    const i = (y * width + x) * 4
    data[i] = data[i + 1] = data[i + 2] = 0
  })
  return data
}

const hline = (set: (x: number, y: number) => void, y: number, x0: number, x1: number) => {
  for (let x = x0; x <= x1; x++) set(x, y)
}
const vline = (set: (x: number, y: number) => void, x: number, y0: number, y1: number) => {
  for (let y = y0; y <= y1; y++) set(x, y)
}

describe('findFrame', () => {
  it('finds a boxed chart with a grid and a curve, not its grid lines', () => {
    const data = picture(200, 150, (set) => {
      hline(set, 10, 20, 180) // the box
      hline(set, 130, 20, 180)
      vline(set, 20, 10, 130)
      vline(set, 180, 10, 130)
      hline(set, 70, 20, 180) // grid
      vline(set, 100, 10, 130)
      for (let x = 20; x < 180; x++) set(x, Math.round(120 - x / 2)) // curve
    })
    expect(findFrame(data, 200, 150)).toEqual({ left: 20, right: 180, top: 10, bottom: 130 })
  })

  it('finds bare axes and, on a page of two charts, the one around a point', () => {
    const data = picture(300, 120, (set) => {
      vline(set, 10, 10, 100) // left chart: L axes
      hline(set, 100, 10, 130)
      vline(set, 160, 20, 90) // right chart
      hline(set, 90, 160, 290)
    })
    expect(findFrame(data, 300, 120)).toEqual({ left: 10, right: 130, top: 10, bottom: 100 })
    expect(findFrame(data, 300, 120, [200, 50])).toEqual({ left: 160, right: 290, top: 20, bottom: 90 })
    expect(
      findFrame(
        picture(50, 50, () => {}),
        50,
        50,
      ),
    ).toBeNull()
  })
})
