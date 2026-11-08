/** Rated values a real part can have (stress checks compare the simulation with them). */
export const RATINGS = [
  ['voltage', 'Rated voltage [V]'],
  ['current', 'Rated current [A]'],
  ['power', 'Rated power [W]'],
  ['isat', 'Saturation current [A]'],
  ['tj_max', 'Max. junction / hot-spot temperature [°C]'],
  ['rth', 'Thermal resistance to ambient [K/W]'],
] as const
