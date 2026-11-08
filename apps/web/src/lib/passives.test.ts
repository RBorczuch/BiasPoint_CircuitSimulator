import { describe, expect, it } from 'vitest'
import { impedance, numbers, previewCurves } from './passives'

// Values computed by the backend's templates (bpt/models/templates.py) for the same forms.
const CASES: [string, Record<string, string>, [number, number, number, number][]][] = [
  [
    'capacitor',
    { Cnom: '1u', esr: '20m', esl: '1n' },
    [
      [1e3, 159.154938065, -89.9928, 0.02],
      [5.0329e6, 0.02, -0.000764, 0.02],
      [1e8, 0.627046018, 88.172208, 0.02],
    ],
  ],
  [
    'mlcc',
    { Cnom: '10u', vhalf: '8', esr: '5m', esl: '500p' },
    [
      [1e3, 15.915491953, -89.982, 0.005],
      [1e6, 0.013717601, -68.623478, 0.005],
    ],
  ],
  [
    'electrolytic',
    { Cnom: '100u', esr: '300m', rlf: '500m', flf: '1k', esl: '10n', rleak: '1meg' },
    [
      [100, 15.984789869, -87.148144, 0.795302808],
      [1e5, 0.30040654, -2.791793, 0.300049995],
    ],
  ],
  [
    'film',
    { Cnom: '1u', esr: '5m', esl: '10n', rins: '10G' },
    [
      [1e3, 159.154880339, -89.998199, 0.005002533],
      [1e7, 0.612423447, 89.532216, 0.005],
    ],
  ],
  [
    'inductor',
    { Lnom: '10u', dcr: '50m', srf: '30meg' },
    [
      [1e3, 0.080298454, 51.488113, 0.05],
      [3e7, 71061151.71284336, -0.00152, 71061151.68784337],
    ],
  ],
  [
    'inductor',
    { Lnom: '10u', dcr: '50m', srf: '30meg', rac: '0.5', fac: '100k' },
    [
      [1e3, 0.08429765407726945, 53.57789357018934, 0.05004999512057206],
      [1e6, 62.95372388737304, 89.50282531900208, 0.5462637052238218],
    ],
  ],
  [
    'resistor',
    { Rnom: '1k', ls: '10n', cp: '0.5p' },
    [
      [1e3, 999.999999995, -0.000176, 999.999999991],
      [1e9, 309.012503734, -72.07346, 95.113235461],
    ],
  ],
]

describe('passive templates in the browser', () => {
  it.each(CASES)('%s matches the backend', (template, form, points) => {
    const v = numbers(template, form)
    expect(v).not.toBeNull()
    for (const [f, magnitude, phase, esr] of points) {
      const [re, im] = impedance(template, v as Record<string, number>, f)
      expect(Math.hypot(re, im)).toBeCloseTo(magnitude, magnitude > 1e3 ? -2 : 6)
      expect((Math.atan2(im, re) * 180) / Math.PI).toBeCloseTo(phase, 3)
      expect(re).toBeCloseTo(esr, esr > 1e3 ? -2 : 6)
    }
  })

  it('draws C(V) and L(I) like the backend', () => {
    const mlcc = previewCurves('mlcc', { Cnom: '10u', vhalf: '8', esr: '5m', esl: '500p' }, 10, 1e9)
    const cv = mlcc?.find((c) => c.name === 'C(V)')
    expect(cv?.y[0]).toBeCloseTo(1.00010001e-5, 12)
    expect(cv?.y[10]).toBeCloseTo(5.00025001e-6, 12) // at V½
    const coil = previewCurves('inductor', { Lnom: '10u', dcr: '50m', srf: '30meg', isat: '2' }, 10, 1e9)
    expect(coil?.find((c) => c.name === 'L(I)')?.y[10]).toBeCloseTo(5.00001758e-6, 12)
  })

  it('gives nothing for an unusable form', () => {
    expect(previewCurves('capacitor', { Cnom: '' }, 10, 1e9)).toBeNull()
    expect(previewCurves('capacitor', { Cnom: 'abc' }, 10, 1e9)).toBeNull()
  })
})
