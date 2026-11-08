import type { components } from './generated'

export type Schemas = components['schemas']

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** FastAPI validation errors (a list of {loc, msg}) as "field: message" lines, not raw JSON. */
export function validationText(detail: unknown): string {
  if (!Array.isArray(detail)) return JSON.stringify(detail)
  return detail
    .map((item: { loc?: unknown[]; msg?: string }) => {
      const where = (item.loc ?? []).filter((part) => part !== 'body' && typeof part === 'string').pop()
      return where ? `${where}: ${item.msg ?? 'invalid'}` : (item.msg ?? 'invalid')
    })
    .join('; ')
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`
    try {
      const data = await response.json()
      if (data?.detail) detail = typeof data.detail === 'string' ? data.detail : validationText(data.detail)
    } catch {
      // keep the status text
    }
    throw new ApiError(response.status, detail)
  }
  const text = await response.text()
  return (text ? JSON.parse(text) : undefined) as T
}

/** In dev the Vite proxy adds the session token; in production the backend sets a cookie. */
export const apiGet = <T>(path: string) => request<T>('GET', path)
export const apiPost = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {})
export const apiPatch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
export const apiDelete = <T>(path: string) => request<T>('DELETE', path)
