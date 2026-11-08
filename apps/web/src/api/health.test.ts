import { describe, expect, it } from 'vitest'
import { type Health, healthRows } from './health'

const health: Health = {
  status: 'degraded',
  app: 'BiasPoint',
  version: '0.1.0',
  native: { ok: true, version: '0.1.0', error: null, details: { engine_version: '0.1.0' } },
  ngspice: { ok: false, version: null, error: 'ngspice shared library not found', details: {} },
}

describe('healthRows', () => {
  it('shows details for working components and the error for failing ones', () => {
    const [backend, native, ngspice] = healthRows(health)
    expect(backend).toMatchObject({ ok: true, version: '0.1.0' })
    expect(native.detail).toBe('engine_version: 0.1.0')
    expect(ngspice).toMatchObject({ ok: false, version: '—', detail: 'ngspice shared library not found' })
  })
})

describe('API errors', () => {
  it('reads FastAPI validation errors as field: message', async () => {
    const { validationText } = await import('./client')
    expect(
      validationText([
        { loc: ['body', 'command', 'rename_sheet', 'new_name'], msg: 'Field required' },
        { loc: ['body'], msg: 'Invalid JSON' },
      ]),
    ).toBe('new_name: Field required; Invalid JSON')
  })
})
