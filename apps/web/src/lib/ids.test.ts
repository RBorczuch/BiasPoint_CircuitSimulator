import { describe, expect, it } from 'vitest'
import { newId } from './ids'

describe('newId', () => {
  it('produces sortable UUIDv7 strings', () => {
    const ids = Array.from({ length: 2000 }, newId)
    expect([...ids].sort()).toEqual(ids)
    for (const id of ids.slice(0, 20)) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    }
    expect(new Set(ids).size).toBe(ids.length)
  })
})
