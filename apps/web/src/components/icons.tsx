/** Electronics icons in the lucide style (24 grid, 2 px stroke, round caps). */
import type { SVGProps } from 'react'

const base = {
  xmlns: 'http://www.w3.org/2000/svg',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const

type IconProps = SVGProps<SVGSVGElement>

export const GroundIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M12 3v9M5 12h14M8 16h8M11 20h2" />
  </svg>
)

export const PowerIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M12 21V8M6 8h12M9 4h6" />
  </svg>
)

export const WireIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M3 18h7V6h11" />
    <circle cx="3" cy="18" r="1.5" fill="currentColor" />
    <circle cx="21" cy="6" r="1.5" fill="currentColor" />
  </svg>
)

export const SymbolIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M12 2v4M12 18v4" />
    <rect x="8.5" y="6" width="7" height="12" rx="1" />
    <path d="M18 9v4M16 11h4" />
  </svg>
)

export const JunctionIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M3 12h18M12 12v9" />
    <circle cx="12" cy="12" r="3" fill="currentColor" />
  </svg>
)

export const NetHighlightIcon = (props: IconProps) => (
  <svg {...base} {...props} aria-hidden="true">
    <path d="M3 17h6V7h12" />
    <path d="M14 17h7" strokeDasharray="2 3" />
    <circle cx="9" cy="12" r="5" strokeWidth={1.5} />
  </svg>
)
