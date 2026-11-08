/**
 * Parameter expressions in values ("{1k*(vout/1.23-1)}"): evaluated to show what a part gets.
 * The arithmetic of ngspice's brace expressions: numbers with SPICE suffixes (1k, 4.7u, 1meg),
 * parameters, + - * / ^ (or **), parentheses and the common functions. Anything else (node
 * voltages, unknown names) gives null: the value is then shown as written.
 */
import type { Project } from '@/api/types'
import { parseValue } from './units'

export type Scope = Record<string, number>

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  atan: Math.atan,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  pwr: (x, y) => Math.sign(x) * Math.abs(x) ** y,
  floor: Math.floor,
  ceil: Math.ceil,
}
const CONSTANTS: Scope = { pi: Math.PI }

const TOKEN =
  /\s*(?:(\d+\.?\d*(?:e[+-]?\d+)?[a-zµμ]*|\.\d+(?:e[+-]?\d+)?[a-zµμ]*)|([a-z_][\w]*)|(\*\*|[-+*/^(),]))/iy

function tokens(text: string): string[] | null {
  const out: string[] = []
  TOKEN.lastIndex = 0
  while (TOKEN.lastIndex < text.length) {
    if (/^\s*$/.test(text.slice(TOKEN.lastIndex))) break
    const m = TOKEN.exec(text)
    if (!m) return null
    out.push(m[1] ?? m[2] ?? m[3])
  }
  return out
}

/** The value of ``text`` ("1k*(vout/1.23-1)", without braces) in ``scope``; null if unknown. */
export function evaluate(text: string, scope: Scope): number | null {
  const list = tokens(text)
  if (!list?.length) return null
  let i = 0
  const peek = () => list[i]
  const lower = Object.fromEntries(Object.entries(scope).map(([k, v]) => [k.toLowerCase(), v]))

  const primary = (): number => {
    const t = list[i++]
    if (t === undefined) throw new Error('end')
    if (t === '(') {
      const v = sum()
      if (list[i++] !== ')') throw new Error(')')
      return v
    }
    if (/^[\d.]/.test(t)) {
      const v = parseValue(t)
      if (v === null) throw new Error(t)
      return v
    }
    if (/^[a-z_]/i.test(t)) {
      const name = t.toLowerCase()
      if (peek() === '(' && name in FUNCS) {
        i++
        const args = [sum()]
        while (peek() === ',') {
          i++
          args.push(sum())
        }
        if (list[i++] !== ')') throw new Error(')')
        return FUNCS[name](...args)
      }
      if (name in lower) return lower[name]
      if (name in CONSTANTS) return CONSTANTS[name]
    }
    throw new Error(t)
  }
  const unary = (): number => {
    if (peek() === '-') {
      i++
      return -unary()
    }
    if (peek() === '+') {
      i++
      return unary()
    }
    return power()
  }
  const power = (): number => {
    const base = primary()
    if (peek() === '^' || peek() === '**') {
      i++
      return base ** unary()
    }
    return base
  }
  const product = (): number => {
    let v = unary()
    while (peek() === '*' || peek() === '/') v = list[i++] === '*' ? v * unary() : v / unary()
    return v
  }
  const sum = (): number => {
    let v = product()
    while (peek() === '+' || peek() === '-') v = list[i++] === '+' ? v + product() : v - product()
    return v
  }
  try {
    const v = sum()
    return i === list.length && Number.isFinite(v) ? v : null
  } catch {
    return null
  }
}

/** A value that is one expression ("{R*2}"): its content, else null. */
export function braced(value: string): string | null {
  const m = /^\s*\{(.*)\}\s*$/.exec(value)
  return m ? m[1] : null
}

/** A value as a number: plain ("4k7") or an expression in ``scope``. */
export function numberOf(value: string, scope: Scope): number | null {
  const inner = braced(value)
  return inner === null ? parseValue(value) : evaluate(inner, scope)
}

function evaluated(values: Record<string, string>, scope: Scope): Scope {
  const out: Scope = { ...scope }
  for (const [key, text] of Object.entries(values)) {
    const v = numberOf(text, out)
    if (v !== null) out[key] = v
  }
  return out
}

/**
 * The parameters a sheet sees: the project's, then each block's along ``path`` (its sheet's
 * defaults, overridden by the values set on the block, those read in the outer scope). Without
 * a path the sheet's own defaults.
 */
export function sheetScope(project: Project, sheetName: string, path: string[] | null): Scope {
  const top = evaluated(project.parameters ?? {}, {})
  const sheets = new Map(project.sheets.map((s) => [s.name, s]))
  let scope = top
  let sheet = project.sheets[0]
  for (const ref of path ?? []) {
    const inst = sheet?.instances.find((i) => i.ref === ref)
    const inner = inst?.symbol.startsWith('sheet:') ? sheets.get(inst.symbol.slice(6)) : undefined
    if (!inst || !inner) break
    const overrides = evaluated(inst.model.params, scope)
    const own: Scope = {}
    for (const key of Object.keys(inst.model.params)) if (key in overrides) own[key] = overrides[key]
    scope = { ...evaluated(inner.parameters ?? {}, top), ...own }
    sheet = inner
  }
  const current = sheets.get(sheetName)
  if (current && sheet !== current) scope = evaluated(current.parameters ?? {}, top)
  return scope
}
