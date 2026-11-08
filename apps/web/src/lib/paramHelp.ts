/**
 * What each parameter of the built-in templates is (docs/projekt-kreator.md §4.2): the card shown
 * when hovering its name – what it is, what it does to the curves, where the datasheet gives it,
 * a typical range, and the part of a chart it acts on (highlighted while the card is open).
 */

export interface ParamInfo {
  name: string // full name
  help: string // what it is
  effect?: string // what it does to the curves
  datasheet?: string // where to take it from
  typical?: string // typical range
  chart?: string // the characteristic it shows on
  /** The x range of `chart` it acts on, from the current values (base units). */
  region?: (v: Record<string, number>) => [number, number] | null
}

const TWO_PI = 2 * Math.PI
const VT = 0.02585
const srf = (c?: number, l?: number) => (c && l ? 1 / (TWO_PI * Math.sqrt(c * l)) : null)
const around = (x: number | null, k = 3): [number, number] | null => (x && x > 0 ? [x / k, x * k] : null)
const above = (x: number | null): [number, number] | null => (x && x > 0 ? [x, x * 1e4] : null)
const below = (x: number | null): [number, number] | null => (x && x > 0 ? [x / 1e4, x] : null)

// -- passives (built-in templates) --------------------------------------------------------------

const CAP_COMMON: Record<string, ParamInfo> = {
  Cnom: {
    name: 'Capacitance',
    help: 'The nominal capacitance of the part.',
    effect: 'Sets the falling (capacitive) slope of |Z| below the self-resonance: twice C, half |Z|.',
    datasheet: 'The value on the part (e.g. 10 µF); the |Z|(f) chart at low frequency.',
    chart: '|Z|(f)',
    region: (v) => below(srf(v.Cnom, v.esl) ? (srf(v.Cnom, v.esl) as number) / 10 : null),
  },
  esr: {
    name: 'Equivalent series resistance',
    help: 'The resistance in series with the capacitance: electrodes, leads, dielectric losses.',
    effect: 'Sets the bottom of the |Z| dip at the self-resonance and the heat at a ripple current.',
    datasheet: 'ESR at 100 kHz in the table, or the minimum of the |Z|(f) chart.',
    typical: 'MLCC 2–50 mΩ, film 5–50 mΩ, aluminium electrolytic 20 mΩ–2 Ω.',
    chart: '|Z|(f)',
    region: (v) => around(srf(v.Cnom, v.esl)),
  },
  esl: {
    name: 'Equivalent series inductance',
    help: 'The inductance of the leads, the electrodes and the package.',
    effect: 'Sets the self-resonance (with C) and the rising (inductive) slope of |Z| above it.',
    datasheet: 'ESL in the table, or from the self-resonance: ESL = 1 / ((2π·SRF)²·C).',
    typical: '0402 ≈ 0.4 nH, 0805 ≈ 0.8 nH, radial leads 5–20 nH.',
    chart: '|Z|(f)',
    region: (v) => above(srf(v.Cnom, v.esl)),
  },
  rleak: {
    name: 'Leakage resistance',
    help: 'The insulation (parallel) resistance: a small DC current flows through the dielectric.',
    effect: 'Flattens |Z| at very low frequency and discharges a capacitor left alone.',
    datasheet: 'Insulation resistance (MΩ·µF or MΩ), or leakage current at the rated voltage: R = V / I.',
    typical: 'MLCC > 100 MΩ, electrolytic 100 kΩ–10 MΩ.',
  },
}

const PASSIVE: Record<string, Record<string, ParamInfo>> = {
  resistor: {
    Rnom: {
      name: 'Resistance',
      help: 'The nominal resistance of the part.',
      effect: 'The flat |Z| at low frequency.',
      datasheet: 'The value on the part.',
      chart: '|Z|(f)',
    },
    ls: {
      name: 'Series inductance',
      help: 'The inductance of the leads and the resistive element.',
      effect: 'Makes |Z| rise at high frequency (low resistances).',
      typical: 'SMD 0.2–1 nH, leaded 5–20 nH.',
    },
    cp: {
      name: 'Parallel capacitance',
      help: 'The capacitance across the part (terminals, the body).',
      effect: 'Makes |Z| fall at high frequency (high resistances).',
      typical: '0.05–0.5 pF.',
    },
  },
  capacitor: CAP_COMMON,
  mlcc: {
    ...CAP_COMMON,
    Cnom: { ...CAP_COMMON.Cnom, name: 'Capacitance at 0 V', help: 'The capacitance without DC bias.' },
    vhalf: {
      name: 'Half-capacitance voltage',
      help: 'The DC bias at which the capacitance falls to half (class 2 dielectrics: X5R, X7R).',
      effect: 'Sets how fast C(V) falls with the voltage on the part.',
      datasheet: 'The DC bias characteristic (ΔC % against V): the voltage at −50 %.',
      typical: 'A few volts for small 0402 / 0603 parts, more for large or high-voltage ones.',
      chart: 'C(V)',
      region: (v) => (v.vhalf ? [v.vhalf * 0.5, v.vhalf * 1.5] : null),
    },
  },
  electrolytic: {
    ...CAP_COMMON,
    esr: {
      ...CAP_COMMON.esr,
      name: 'ESR at high frequency',
      help: 'The series resistance at 100 kHz and above (electrolyte and foil).',
      datasheet: 'Impedance or ESR at 100 kHz in the series table.',
      chart: 'ESR(f)',
      region: (v) => (v.flf ? [v.flf * 10, v.flf * 1e4] : null),
    },
    rlf: {
      name: 'ESR rise at low frequency',
      help: 'The extra series resistance at low frequency (dielectric losses: tan δ).',
      effect: 'Raises ESR(f) below the corner frequency.',
      datasheet: 'From tan δ at 120 Hz: ESR(120 Hz) = tan δ / (2π·120·C). Use “From the catalogue”.',
      chart: 'ESR(f)',
      region: (v) => (v.flf ? [v.flf / 1e3, v.flf] : null),
    },
    flf: {
      name: 'ESR corner frequency',
      help: 'The frequency at which the low-frequency ESR rise has halved.',
      effect: 'Moves the step of ESR(f) left or right.',
      typical: 'About 1 kHz for aluminium electrolytics.',
      chart: 'ESR(f)',
      region: (v) => around(v.flf ?? null),
    },
  },
  film: {
    ...CAP_COMMON,
    rins: {
      name: 'Insulation resistance',
      help: 'The parallel resistance of the film dielectric.',
      datasheet: 'Insulation resistance (MΩ or s = MΩ·µF).',
      typical: '> 10 GΩ for small values.',
    },
    rda: {
      name: 'Dielectric absorption resistance',
      help: 'With cda, the slow charge the dielectric absorbs and gives back (a voltage that comes back after a discharge).',
      typical: 'Polypropylene: very little absorption (large R, small C).',
    },
    cda: {
      name: 'Dielectric absorption capacitance',
      help: 'With rda, the part of the charge absorbed slowly by the dielectric.',
      typical: 'A few % of C or less.',
    },
  },
  inductor: {
    Lnom: {
      name: 'Inductance',
      help: 'The inductance at zero current.',
      effect: 'Sets the rising slope of |Z| below the self-resonance.',
      datasheet: 'The value on the part, at the test frequency of the table.',
      chart: '|Z|(f)',
      region: (v) => below(srf(v.cp, v.Lnom) ? (srf(v.cp, v.Lnom) as number) / 10 : null),
    },
    dcr: {
      name: 'DC resistance',
      help: 'The resistance of the winding.',
      effect: 'The flat |Z| at very low frequency; the losses at a DC current.',
      datasheet: 'DCR in the table (often the maximum; typical ≈ 0.8 of it).',
    },
    cp: {
      name: 'Winding capacitance',
      help: 'The capacitance between the turns (or give the self-resonance instead).',
      effect: 'Sets the self-resonance with L; above it the part is a capacitor.',
      datasheet: 'From the SRF in the table: Cp = 1 / ((2π·SRF)²·L).',
      chart: '|Z|(f)',
      region: (v) => around(srf(v.cp, v.Lnom)),
    },
    srf: {
      name: 'Self-resonant frequency',
      help: 'The frequency at which the winding capacitance resonates with L (sets Cp).',
      datasheet: 'SRF in the table.',
      chart: '|Z|(f)',
      region: (v) => around(v.srf ?? srf(v.cp, v.Lnom)),
    },
    rac: {
      name: 'AC winding resistance',
      help: 'What the winding adds at high frequency (skin and proximity effects), above its DCR.',
      effect: 'ESR(f) rises from DCR to DCR + R AC around f AC; the |Z| dip-free slope gets lossier.',
      datasheet: 'ACR at a frequency, or from the Q at the test frequency: ESR = 2πfL / Q.',
      chart: 'ESR(f)',
    },
    fac: {
      name: 'AC resistance corner',
      help: 'Where the extra winding resistance has reached half of R AC.',
      datasheet: 'The frequency of the ACR (or Q) value in the table, as a start.',
      typical: '10 kHz – 1 MHz for power inductors.',
    },
    rp: {
      name: 'Core loss resistance',
      help: 'The losses of the core, in parallel with L.',
      effect: 'Sets the height of the |Z| peak at the self-resonance.',
      datasheet: 'The peak of the |Z|(f) chart.',
      chart: '|Z|(f)',
      region: (v) => around(srf(v.cp, v.Lnom)),
    },
    isat: {
      name: 'Saturation current',
      help: 'The current at which the inductance has fallen (to the datasheet’s criterion).',
      effect: 'Bends L(I) down above this current.',
      datasheet: 'Isat in the table (e.g. at −30 % L), or the knee of the L(I) chart.',
      chart: 'L(I)',
      region: (v) => (v.isat ? [v.isat * 0.5, v.isat * 1.5] : null),
    },
  },
}

// -- semiconductors (SPICE model parameters) -----------------------------------------------------

/** The diode's forward voltage at a current (ideal exponential and series resistance). */
const vf = (v: Record<string, number>, i: number) =>
  (v.n ?? 1) * VT * Math.log(i / (v.is || 1e-14) + 1) + i * (v.rs ?? 0)

const DIODE: Record<string, ParamInfo> = {
  is: {
    name: 'Saturation current',
    help: 'The scale of the junction current: I = IS·(exp(V / (N·Vt)) − 1).',
    effect: 'Shifts the forward curve left or right: ten times IS, about 60·N mV less for the same current.',
    datasheet: 'Fitted to the VF(IF) points at low currents (well below the rated current).',
    typical: 'Signal silicon 1–10 nA (as fitted), rectifiers 1 nA–1 µA, Schottky 1–100 µA, LEDs < 1 fA.',
    chart: 'I-V forward',
    region: (v) => [vf(v, 1e-9), vf(v, 1e-4)],
  },
  n: {
    name: 'Emission coefficient',
    help: 'The ideality of the junction: the slope of log I against V.',
    effect: 'Tilts the straight part of the forward curve (on a log current axis): larger N, less steep.',
    datasheet: 'From two VF(IF) points a decade apart: N = ΔV / (Vt·ln 10).',
    typical: '1–2 for silicon, 2–4 for LEDs.',
    chart: 'I-V forward',
    region: (v) => [vf(v, 1e-6), vf(v, 1e-2)],
  },
  rs: {
    name: 'Series resistance',
    help: 'The resistance of the leads and the bulk silicon in series with the junction.',
    effect: 'Bends the forward curve at high current (the right end of the curve).',
    datasheet: 'The slope of VF(IF) above about a tenth of the rated current.',
    typical: '0.1–2 Ω for small-signal diodes, 10–100 mΩ for rectifiers.',
    chart: 'I-V forward',
    region: (v) => [vf(v, 1e-2), vf(v, 1)],
  },
  bv: {
    name: 'Reverse breakdown voltage',
    help: 'The reverse voltage at which the current rises sharply (Zener / avalanche).',
    effect: 'Places the knee of the reverse curve.',
    datasheet: 'VBR or VR (maximum reverse voltage) in the table; VZ for a Zener.',
    chart: 'I-V reverse',
    region: (v) => (v.bv ? [v.bv * 0.9, v.bv * 1.05] : null),
  },
  ibv: {
    name: 'Current at the breakdown voltage',
    help: 'The reverse current at which the voltage equals BV.',
    effect: 'Sets how sharp the reverse knee is at BV.',
    datasheet: 'The test current of VBR / VZ (IZT for a Zener).',
    chart: 'I-V reverse',
    region: (v) => (v.bv ? [v.bv * 0.9, v.bv * 1.05] : null),
  },
  cjo: {
    name: 'Junction capacitance at 0 V',
    help: 'The capacitance of the junction with no bias.',
    effect: 'Sets the C(V) curve at 0 V and the switching speed.',
    datasheet: 'CD / CT in the table (with its bias, e.g. VR = 0 V, f = 1 MHz).',
    chart: 'C(V)',
    region: () => [0, 1],
  },
  vj: {
    name: 'Junction potential',
    help: 'The built-in potential of the junction.',
    effect: 'With M, how C(V) falls with the reverse voltage.',
    typical: '0.5–0.9 V.',
    chart: 'C(V)',
  },
  mj: {
    name: 'Grading coefficient',
    help: 'How abrupt the junction is: 0.5 abrupt, 0.33 linearly graded.',
    effect: 'The slope of C(V) with the reverse voltage.',
    datasheet: 'Fitted to the Cj(VR) points.',
    typical: '0.3–0.5.',
    chart: 'C(V)',
  },
  tt: {
    name: 'Transit time',
    help: 'The charge stored per ampere of forward current: the reverse recovery.',
    datasheet: 'From trr in the table: TT ≈ trr / ln 2 (for IF = IR).',
    typical: 'Fast switching diodes 1–10 ns, rectifiers µs.',
  },
}

const BJT: Record<string, ParamInfo> = {
  is: {
    name: 'Saturation current',
    help: 'The scale of the collector current: Ic = IS·exp(Vbe / Vt).',
    effect: 'Shifts Ic(Vbe) left or right (VBE at a given current).',
    datasheet: 'Fitted to VBE(Ic) points (VBE(on) in the table).',
    typical: '1 fA–100 fA for small transistors.',
    chart: 'Ic(Vbe)',
  },
  bf: {
    name: 'Forward current gain',
    help: 'The ideal maximum of the current gain β (hFE), before the roll-offs.',
    effect: 'Raises or lowers the hFE(Ic) curve, mostly at its peak.',
    datasheet: 'hFE in the table (the group: A / B / C), or the peak of hFE(Ic).',
    typical: '100–800 for small-signal transistors.',
    chart: 'hFE(Ic)',
    region: (v) => (v.ikf ? [v.ikf / 300, v.ikf / 3] : null),
  },
  vaf: {
    name: 'Early voltage',
    help: 'Models the output resistance: Ic rises with Vce.',
    effect: 'The slope of the Ic(Vce) lines: smaller VAF, steeper.',
    datasheet:
      'From the output characteristic: extend the Ic(Vce) lines to where they meet the voltage axis.',
    typical: '20–150 V.',
    chart: 'Ic(Vce)',
    region: () => [1, 1e3],
  },
  ikf: {
    name: 'High-current roll-off',
    help: 'The corner current above which the gain falls (high injection).',
    effect: 'Bends hFE(Ic) down at high current.',
    datasheet: 'Where hFE(Ic) has fallen to about half of its peak.',
    chart: 'hFE(Ic)',
    region: (v) => (v.ikf ? [v.ikf / 3, v.ikf * 30] : null),
  },
  ise: {
    name: 'Base-emitter leakage current',
    help: 'A recombination current in the base: makes the gain fall at low current.',
    effect: 'Bends hFE(Ic) down at low current.',
    datasheet: 'Fitted to hFE(Ic) points at low currents.',
    chart: 'hFE(Ic)',
    region: (v) => (v.ikf ? [v.ikf * 1e-7, v.ikf * 1e-3] : null),
  },
  ne: {
    name: 'Emission coefficient of the leakage',
    help: 'The slope of that recombination current (with ISE).',
    effect: 'How steeply hFE falls at low current.',
    typical: '1.5–2.',
    chart: 'hFE(Ic)',
    region: (v) => (v.ikf ? [v.ikf * 1e-7, v.ikf * 1e-3] : null),
  },
  br: {
    name: 'Reverse current gain',
    help: 'The gain with collector and emitter swapped (inverse operation, saturation).',
    effect: 'Affects VCE(sat) a little.',
    typical: '1–10.',
  },
  rb: {
    name: 'Base resistance',
    help: 'The resistance of the base region.',
    effect: 'Noise and the response at high current and frequency.',
    typical: '10–200 Ω.',
  },
  rc: {
    name: 'Collector resistance',
    help: 'The resistance in series with the collector.',
    effect: 'Raises VCE(sat) at high current.',
    datasheet: 'From VCE(sat) at the highest current of the table.',
    typical: '0.1–10 Ω.',
  },
  cje: {
    name: 'Base-emitter junction capacitance',
    help: 'The capacitance of the base-emitter junction at 0 V.',
    datasheet: 'Cibo (input capacitance) in the table.',
  },
  cjc: {
    name: 'Base-collector junction capacitance',
    help: 'The capacitance of the base-collector junction at 0 V (the Miller capacitance).',
    datasheet: 'Cobo (output capacitance) in the table.',
  },
  tf: {
    name: 'Forward transit time',
    help: 'The time of the carriers through the base: sets the transition frequency.',
    datasheet: 'From fT in the table: TF ≈ 1 / (2π·fT) (minus the capacitances’ share).',
    typical: '0.1–1 ns for small-signal transistors.',
  },
}

const MOS: Record<string, ParamInfo> = {
  vto: {
    name: 'Threshold voltage',
    help: 'The gate voltage at which the channel starts to conduct.',
    effect: 'Shifts Id(Vgs) left or right.',
    datasheet: 'VGS(th) in the table (at its small drain current, e.g. 250 µA).',
    typical: 'Logic-level 1–2.5 V, standard 2–4 V.',
    chart: 'Id(Vgs)',
    region: (v) => (v.vto !== undefined ? [v.vto - 0.5, v.vto + 0.7] : null),
  },
  kp: {
    name: 'Transconductance parameter',
    help: 'How fast the drain current grows above the threshold: Id = KP/2·(Vgs − Vto)².',
    effect: 'Steepness of Id(Vgs) and the on-resistance.',
    datasheet: 'Fitted to Id(Vgs) or RDS(on) points (gfs in the table).',
    chart: 'Id(Vgs)',
    region: (v) => (v.vto !== undefined ? [v.vto + 0.7, v.vto + 6] : null),
  },
  lambda: {
    name: 'Channel-length modulation',
    help: 'The rise of the drain current with Vds in saturation (output conductance).',
    effect: 'The slope of the flat parts of Id(Vds).',
    typical: '0–0.05 1/V.',
  },
  theta: {
    name: 'Mobility degradation',
    help: 'How much the channel mobility falls as the gate voltage rises (level 3).',
    effect: 'Straightens Id(Vgs) at high gate voltage and raises RDS(on) there.',
    datasheet: 'The bend of the transfer curve above the threshold; fitted to Id(Vgs) points.',
    typical: '0–0.5 1/V for power MOSFETs.',
  },
  rd: {
    name: 'Drain resistance',
    help: 'The resistance in series with the drain.',
    effect: 'Adds to RDS(on).',
    datasheet: 'With RS, from RDS(on) at a high gate voltage.',
  },
  rs: {
    name: 'Source resistance',
    help: 'The resistance in series with the source.',
    effect: 'Adds to RDS(on) and lowers the effective Vgs at high current.',
  },
  cgso: {
    name: 'Gate-source capacitance',
    help: 'The capacitance between gate and source (per metre of width; W = 1 m here, so the capacitance itself).',
    datasheet: 'Ciss − Crss.',
  },
  cgdo: {
    name: 'Gate-drain capacitance',
    help: 'The Miller capacitance between gate and drain.',
    datasheet: 'Crss (reverse transfer capacitance).',
  },
  cbd: {
    name: 'Drain-body capacitance',
    help: 'The capacitance of the drain-body junction.',
    datasheet: 'Coss − Crss.',
  },
}

const JFET: Record<string, ParamInfo> = {
  vto: {
    name: 'Pinch-off voltage',
    help: 'The gate voltage at which the channel closes.',
    effect: 'Shifts Id(Vgs).',
    datasheet: 'VGS(off) in the table.',
    chart: 'Id(Vgs)',
  },
  beta: {
    name: 'Transconductance parameter',
    help: 'Scales the drain current: IDSS = BETA·VTO².',
    datasheet: 'From IDSS and VGS(off): BETA = IDSS / VGS(off)².',
    chart: 'Id(Vgs)',
  },
  lambda: MOS.lambda,
  rd: MOS.rd,
  rs: MOS.rs,
  cgs: {
    name: 'Gate-source capacitance',
    help: 'The capacitance of the gate-source junction at 0 V.',
    datasheet: 'Ciss − Crss.',
  },
  cgd: {
    name: 'Gate-drain capacitance',
    help: 'The capacitance of the gate-drain junction at 0 V.',
    datasheet: 'Crss.',
  },
}

const OPAMP: Record<string, ParamInfo> = {
  aol: {
    name: 'Open-loop gain',
    help: 'The DC gain without feedback.',
    datasheet: 'AVD / AOL in the table (V/mV or dB).',
  },
  gbw: {
    name: 'Gain-bandwidth product',
    help: 'The frequency at which the open-loop gain is 1; a follower’s bandwidth.',
    datasheet: 'GBW / GBP in the table.',
  },
  sr: { name: 'Slew rate', help: 'The fastest the output can change.', datasheet: 'SR in the table (V/µs).' },
  vos: {
    name: 'Input offset voltage',
    help: 'The input voltage that makes the output zero.',
    datasheet: 'VIO / VOS in the table (typical).',
  },
  ib: { name: 'Input bias current', help: 'The current into the inputs.', datasheet: 'IIB in the table.' },
  cmrr: {
    name: 'Common-mode rejection',
    help: 'How little the output follows a voltage on both inputs.',
    datasheet: 'CMRR in the table (dB).',
  },
  psrr: {
    name: 'Supply rejection',
    help: 'How little the output follows the supply voltage.',
    datasheet: 'kSVR / PSRR in the table (dB).',
  },
  vohigh: {
    name: 'Output swing to the positive supply',
    help: 'How close the output gets to the positive supply.',
    datasheet: 'VOH in the table (as a drop from the supply).',
  },
  volow: {
    name: 'Output swing to the negative supply',
    help: 'How close the output gets to the negative supply.',
    datasheet: 'VOL in the table.',
  },
  iout: {
    name: 'Output current limit',
    help: 'The short-circuit current of the output.',
    datasheet: 'IOS in the table.',
  },
  iq: {
    name: 'Quiescent current',
    help: 'The supply current without load.',
    datasheet: 'ICC / IQ in the table (per amplifier).',
  },
  rin: { name: 'Input resistance', help: 'The differential resistance between the inputs.' },
  rout: { name: 'Output resistance', help: 'The open-loop output resistance.' },
}

const TRANSFORMER: Record<string, ParamInfo> = {
  lp: {
    name: 'Primary inductance',
    help: 'The magnetizing inductance of the primary winding.',
    datasheet: 'Inductance in the table (secondary open).',
  },
  n: { name: 'Turns ratio', help: 'Secondary turns per primary turn (the voltage ratio).' },
  k: {
    name: 'Coupling coefficient',
    help: 'How much of the flux links both windings (1 = ideal).',
    datasheet: 'From the leakage inductance: k = √(1 − Lleak / Lp).',
  },
  rp: { name: 'Primary resistance', help: 'The DC resistance of the primary winding.' },
  rs: { name: 'Secondary resistance', help: 'The DC resistance of the secondary winding.' },
  rcore: { name: 'Core loss resistance', help: 'The core losses, across the primary.' },
  cw: { name: 'Interwinding capacitance', help: 'The capacitance between the windings.' },
}

const PACKAGE: Record<string, ParamInfo> = {
  lb: { name: 'Base lead inductance', help: 'The inductance of the base lead and bond wire.' },
  lc: { name: 'Collector lead inductance', help: 'The inductance of the collector lead.' },
  le: {
    name: 'Emitter lead inductance',
    help: 'The inductance of the emitter lead (feedback at high frequency).',
  },
  cbe: {
    name: 'Package base-emitter capacitance',
    help: 'The capacitance between the base and emitter leads.',
  },
  cbc: {
    name: 'Package base-collector capacitance',
    help: 'The capacitance between the base and collector leads.',
  },
}

/** The card's content for field `key` of template `template` (its id or built-in name). */
export function paramInfo(template: string, key: string): ParamInfo | undefined {
  if (PASSIVE[template]) return PASSIVE[template][key]
  const name = template.split('/').pop() ?? template
  if (/^(Diode|LED|Zener)/.test(name)) return DIODE[key]
  if (/^(NPN|PNP) transistor/.test(name)) return BJT[key]
  if (/MOSFET/.test(name)) return MOS[key]
  if (/JFET/.test(name)) return JFET[key]
  if (/Op-amp/.test(name)) return OPAMP[key]
  if (/transformer/i.test(name)) return TRANSFORMER[key]
  if (/with package/.test(name)) return PACKAGE[key]
  if (/Hybrid/i.test(name)) return HYBRID[key]
  return undefined
}

// -- parameters of SPICE models (imported ones, in the inspector) --------------------------------

const brief = (name: string, help: string): ParamInfo => ({ name, help })
const JUNCTION = {
  eg: brief('Band gap', 'Activation energy: how the saturation current grows with temperature.'),
  xti: brief('IS temperature exponent', 'How the saturation current follows temperature.'),
  kf: brief('Flicker noise coefficient', 'The 1/f noise; 0 = none.'),
  af: brief('Flicker noise exponent', 'How the 1/f noise follows the current.'),
  fc: brief('Forward capacitance coefficient', 'Where the depletion capacitance formula turns linear.'),
}
const SPICE_MORE: Record<'diode' | 'bjt' | 'mos' | 'jfet', Record<string, ParamInfo>> = {
  diode: {
    ...JUNCTION,
    m: DIODE.mj,
    cj0: DIODE.cjo,
    isr: brief(
      'Recombination current',
      'A second diode at low current, with its own emission coefficient NR.',
    ),
    nr: brief('Recombination emission coefficient', 'The slope of the low-current diode (around 2).'),
    ikf: brief('High-injection knee', 'Above it the forward current grows more slowly.'),
  },
  bjt: {
    ...JUNCTION,
    nf: brief('Forward emission coefficient', 'The slope of Ic against Vbe (near 1).'),
    nr: brief('Reverse emission coefficient', 'The same for the transistor used backwards.'),
    nc: brief('B-C leakage emission coefficient', 'The slope of ISC.'),
    isc: brief('B-C leakage current', 'Lowers the reverse gain at low current.'),
    var: brief('Reverse Early voltage', 'The output slope of the transistor used backwards.'),
    ikr: brief('Reverse high-injection knee', 'Where the reverse gain falls at high current.'),
    re: brief('Emitter resistance', 'Adds to VCE(sat) and VBE at high current.'),
    irb: brief('Base current halfway to RBM', 'Where the base resistance falls.'),
    rbm: brief('Base resistance at high current', 'What RB falls to.'),
    vje: brief('B-E built-in potential', 'Shapes Cje against voltage.'),
    mje: brief('B-E grading coefficient', 'Shapes Cje against voltage.'),
    vjc: brief('B-C built-in potential', 'Shapes Cjc against voltage.'),
    mjc: brief('B-C grading coefficient', 'Shapes Cjc against voltage.'),
    xcjc: brief('Cjc share at the inner base', 'Which part of Cjc sits behind RB.'),
    cjs: brief('Collector-substrate capacitance', 'At the collector; integrated transistors.'),
    tr: brief('Reverse transit time', 'Stored charge when saturated: the turn-off delay.'),
    xtf: brief('TF bias coefficient', 'How the transit time grows with current.'),
    vtf: brief('TF voltage dependence', 'How the transit time follows Vbc.'),
    itf: brief('TF current dependence', 'The current where the transit time starts to grow.'),
    xtb: brief('Gain temperature exponent', 'How BF follows temperature.'),
  },
  mos: {
    ...JUNCTION,
    gamma: brief('Body effect', 'How the threshold follows the source-bulk voltage.'),
    phi: brief('Surface potential', 'Used with the body effect.'),
    is: brief('Bulk junction saturation current', 'The leakage of the body diode.'),
    pb: brief('Bulk junction potential', 'Shapes the junction capacitance.'),
    cbs: brief('Source-bulk capacitance', 'At zero bias.'),
    cgbo: brief('Gate-bulk overlap capacitance', 'Per metre of channel length.'),
    rsh: brief('Sheet resistance', 'Of the drain and source diffusion.'),
    cj: brief('Bottom junction capacitance', 'Per square metre.'),
    mj: brief('Bottom grading coefficient', 'Shapes the junction capacitance.'),
    cjsw: brief('Side junction capacitance', 'Per metre of perimeter.'),
    tox: brief('Oxide thickness', 'Sets the gate capacitance per area.'),
    uo: brief('Surface mobility', 'Sets KP when KP is not given.'),
    level: brief('Model level', 'Which set of equations the simulator uses.'),
  },
  jfet: {
    ...JUNCTION,
    is: brief('Gate junction saturation current', 'The gate leakage.'),
    pb: brief('Gate junction potential', 'Shapes Cgs and Cgd against voltage.'),
    b: brief('Doping tail parameter', 'Shapes the drain current near the threshold.'),
  },
}

/** The card of a parameter in a SPICE model of the given type (D, NPN, PMOS…); any case. */
export function spiceParamInfo(type: string, key: string): ParamInfo | undefined {
  const t = type.toUpperCase()
  const k = key.toLowerCase()
  if (t === 'D') return DIODE[k] ?? SPICE_MORE.diode[k]
  if (t === 'NPN' || t === 'PNP') return BJT[k] ?? SPICE_MORE.bjt[k]
  if (t === 'NMOS' || t === 'PMOS') return MOS[k] ?? SPICE_MORE.mos[k]
  if (t === 'NJF' || t === 'PJF') return JFET[k] ?? SPICE_MORE.jfet[k]
  return undefined
}

// -- the small-signal transistor (hybrid-pi) ------------------------------------------------------

const HYBRID: Record<string, ParamInfo> = {
  ic: {
    name: 'Collector bias current',
    help: 'The DC current the transistor works at; the model is valid around it only.',
    effect: 'Sets gm = Ic/VT, so the gain-bandwidth fT = gm / (2π(Cπ + Cμ)).',
    datasheet: 'The Ic of the datasheet’s small-signal table (hfe, fT are given at one).',
  },
  beta: {
    name: 'Small-signal current gain',
    help: 'hfe: the change of collector current over the change of base current.',
    effect: 'The flat start of h21(f).',
    datasheet: 'hfe in the small-signal table.',
    typical: '50–500.',
  },
  vaf: {
    name: 'Early voltage',
    help: 'Sets the output resistance ro = VAF / Ic.',
    typical: '20–200 V.',
  },
  rx: {
    name: 'Base spreading resistance',
    help: 'The resistance from the base pin to the active base (rbb’).',
    effect: 'Limits the input at high frequency; adds noise.',
    datasheet: 'rbb’, or from the noise figure.',
    typical: '10–500 Ω.',
  },
  cpi: {
    name: 'Base-emitter capacitance',
    help: 'Cπ: the diffusion and junction capacitance at the bias point.',
    effect: 'With Cμ, where h21(f) starts to fall and reaches 1 (fT).',
    datasheet: 'From fT: Cπ = gm / (2π fT) − Cμ.',
  },
  cmu: {
    name: 'Base-collector capacitance',
    help: 'Cμ: the collector junction (the Miller capacitance in an amplifier).',
    datasheet: 'Cobo (Ccb) in the table.',
    typical: '1–10 pF for small-signal parts.',
  },
}

/** Every built-in template's field keys that have a card (for the completeness test). */
export const HELP_TABLES = { PASSIVE, DIODE, BJT, MOS, JFET, OPAMP, TRANSFORMER, PACKAGE, HYBRID }

// -- parameters of the ideal parts (the inspector) ------------------------------------------------

const PRIMITIVE: Record<string, ParamInfo> = {
  tc1: {
    name: 'First-order temperature coefficient',
    help: 'The relative change of the value per kelvin away from the nominal temperature (27 °C).',
    datasheet: 'TCR in the table (e.g. ±100 ppm/K = 100u).',
    typical: 'Thin film ±25 ppm/K, thick film ±100–200 ppm/K.',
  },
  tc2: {
    name: 'Second-order temperature coefficient',
    help: 'The change per kelvin squared (the curvature of the value against temperature).',
  },
  tce: { name: 'Exponential temperature coefficient', help: 'The value scaled by 1.01^(TCE·ΔT).' },
  m: { name: 'Multiplier', help: 'As if M parts were in parallel.' },
  pos: {
    name: 'Wiper position',
    help: 'Where the wiper is on the track: 0 at pin 1, 1 at pin 2 (0.5: the middle).',
  },
  iph: {
    name: 'Photocurrent',
    help: 'The current the light makes, at the light the part is used at (cathode to anode).',
    datasheet: 'Reverse light current at the stated irradiance; scale it with the light.',
  },
  ctr: {
    name: 'Current transfer ratio',
    help: 'The collector current over the LED current (1 = 100 %).',
    datasheet: 'CTR at the stated IF and VCE (often given in %).',
  },
  ke: {
    name: 'Back-EMF constant',
    help: 'Volts of back EMF per rad/s of the shaft.',
    datasheet: 'From the speed constant: ke = 1 / (rpm per volt · 2π/60).',
  },
  kt: { name: 'Torque constant', help: 'Newton-metres per ampere; equal to ke in SI units.' },
  j: { name: 'Rotor inertia', help: 'The moment of inertia of the rotor and its load, kg·m².' },
  b: { name: 'Viscous friction', help: 'Torque per rad/s lost in the bearings and the air.' },
  bl: {
    name: 'Force factor BL',
    help: 'The force per ampere of the voice coil (and back EMF per m/s), T·m.',
  },
  mms: { name: 'Moving mass Mms', help: 'The mass of the cone, coil and the air it moves, kg.' },
  cms: { name: 'Compliance Cms', help: 'How far the suspension gives per newton, m/N.' },
  rms: { name: 'Mechanical losses Rms', help: 'The suspension’s damping, N·s/m.' },
  r25: { name: 'Resistance at 25 °C', help: 'The nominal value of the thermistor.' },
  beta: {
    name: 'B constant',
    help: 'How steeply the resistance falls with temperature (K).',
    datasheet: 'B25/50 or B25/85 in the table.',
  },
  vq: { name: 'Quiescent output', help: 'The output with no field (often half the supply).' },
  sens: {
    name: 'Sensitivity',
    help: 'Output volts per millitesla of field.',
    datasheet: 'Sensitivity in mV/mT (or mV/G: 1 G = 0.1 mT).',
  },
  vbo: {
    name: 'Breakover voltage',
    help: 'The voltage, either way, at which the diac starts to conduct.',
    datasheet: 'VBO in the table (typically 28-36 V).',
  },
  r0: { name: 'Resistance at zero control', help: 'The value with the control voltage at 0 V.' },
  ns: { name: 'Turns ratio to the second winding', help: 'Its turns over the primary’s.' },
  nt: { name: 'Turns ratio to the third winding', help: 'Its turns over the primary’s.' },
  rgk: {
    name: 'Gate-cathode resistance',
    help: 'Shunts the gate: the larger it is, the smaller the gate current that turns the thyristor on.',
    datasheet: 'From IGT: about 0.6 V / IGT for the trigger current of the datasheet.',
  },
  rcoil: {
    name: 'Coil resistance',
    help: 'The DC resistance of the relay coil.',
    datasheet: 'Coil resistance in the table.',
  },
  lcoil: {
    name: 'Coil inductance',
    help: 'Delays the coil current, so the pull-in, after the coil voltage.',
  },
  ipull: {
    name: 'Pull-in current',
    help: 'The coil current at which the contact closes (COM-NO).',
    datasheet: 'Pull-in (must-operate) voltage divided by the coil resistance.',
  },
  idrop: {
    name: 'Drop-out current',
    help: 'The coil current below which the contact opens again.',
    datasheet: 'Drop-out (must-release) voltage divided by the coil resistance.',
  },
  i2t: {
    name: 'Melting integral I²t',
    help: 'The fuse opens when the integral of the squared current reaches it, and stays open.',
    datasheet: 'I²t (melting) in the table, in A²s; at a steady current I it opens after I²t / I².',
  },
  scale: { name: 'Scale factor', help: 'Multiplies the value.' },
  temp: { name: 'Instance temperature', help: 'The temperature of this part (instead of the circuit’s).' },
  dtemp: { name: 'Temperature rise', help: 'How much warmer this part is than the circuit.' },
  ic: {
    name: 'Initial condition',
    help: 'The voltage (capacitor) or current (inductor) at the start of a transient run with UIC.',
  },
  dc: { name: 'DC value', help: 'The value of the source in the operating point and DC sweeps.' },
  ac: { name: 'AC magnitude', help: 'The small-signal amplitude in the AC analysis (usually 1).' },
  ...OPAMP,
}

/** The card's content for parameter `key` of a placed ideal part (or one of its model's). */
export function primitiveInfo(key: string): ParamInfo | undefined {
  return PRIMITIVE[key.toLowerCase()] ?? PRIMITIVE[key]
}
