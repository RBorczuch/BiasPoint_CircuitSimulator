// Reads `pnpm licenses list --json` from stdin and fails on licenses outside the allowlist.
import { readFileSync } from 'node:fs'

const ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Apache-2.0',
  'MPL-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Unlicense',
  'OFL-1.1', // fonts
  'CC-BY-4.0', // data (caniuse-lite)
])

// "(MIT OR CC0-1.0)" is fine if any alternative is allowed.
const isAllowed = (expr) =>
  expr
    .replace(/[()]/g, '')
    .split(/\s+OR\s+/)
    .some((id) => ALLOWED.has(id.trim()))

const byLicense = JSON.parse(readFileSync(0, 'utf8'))
const bad = Object.entries(byLicense).filter(([license]) => !isAllowed(license))
for (const [license, packages] of bad) {
  console.error(`  disallowed ${license}: ${packages.map((p) => p.name).join(', ')}`)
}
if (bad.length > 0) process.exit(1)
console.log('  ok')
