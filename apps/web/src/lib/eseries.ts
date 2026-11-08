/** Preferred values (IEC 60063). */

const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8,
  7.5, 8.2, 9.1,
]

/** The E24 value nearest to `x` (in ratio), or null when `x` is one already. */
export function nearestE24(x: number): number | null {
  if (!(x > 0)) return null
  const decade = 10 ** Math.floor(Math.log10(x))
  const candidates = [...E24.map((m) => m * decade), 10 * decade]
  const best = candidates.reduce((a, b) => (Math.abs(Math.log(b / x)) < Math.abs(Math.log(a / x)) ? b : a))
  return Math.abs(best / x - 1) < 0.005 ? null : Number(best.toPrecision(2))
}
