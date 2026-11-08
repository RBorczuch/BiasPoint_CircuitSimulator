import { useQuery } from '@tanstack/react-query'
import { apiGet, type Schemas } from './client'

export type Health = Schemas['Health']
export type ComponentStatus = Schemas['ComponentStatus']

export interface StatusRow {
  name: string
  ok: boolean
  version: string
  detail: string
}

/** Flatten the health response into display rows. */
export function healthRows(health: Health): StatusRow[] {
  const row = (name: string, status: ComponentStatus): StatusRow => ({
    name,
    ok: status.ok,
    version: status.version ?? '—',
    detail:
      status.error ??
      Object.entries(status.details ?? {})
        .map(([key, value]) => `${key}: ${String(value)}`)
        .join(' · '),
  })
  return [
    { name: 'Backend', ok: true, version: health.version, detail: health.app },
    row('Native module (Rust)', health.native),
    row('ngspice', health.ngspice),
  ]
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => apiGet<Health>('/api/health'), retry: false })
}
