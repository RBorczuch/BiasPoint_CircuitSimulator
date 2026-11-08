import { describe, expect, it } from 'vitest'
import { PRESETS } from './keymap'

describe('key bindings', () => {
  it('give each key to one action only', () => {
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const [action, keys] of Object.entries(PRESETS.kicad)) {
      for (const key of keys) {
        const other = owner.get(key)
        if (other) clashes.push(`${key}: ${other} and ${action}`)
        owner.set(key, action)
      }
    }
    expect(clashes).toEqual([])
  })
})
