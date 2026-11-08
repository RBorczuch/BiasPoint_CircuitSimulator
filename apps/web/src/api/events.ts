/** WebSocket client for backend events, with automatic reconnect. */
import type { NodeState } from './types'

export type BackendEvent =
  | { type: 'hello' }
  | { type: 'ui.capture'; request_id: string; project_id: string; target: string; max_px: number }
  | { type: 'doc.changed'; project_id: string; revision: number; command: unknown }
  | {
      type: 'run.progress' | 'run.finished'
      job_id: string
      project_id: string
      run_id: string | null
      status: string
      progress: string
      error: string | null
      origin?: string
    }
  | { type: 'graph.node'; project_id: string; graph: string; node: string; state: NodeState }
  | { type: 'graph.finished'; project_id: string; graph: string }

type Listener = (event: BackendEvent) => void
type StatusListener = (connected: boolean) => void

export class EventSocket {
  private socket: WebSocket | null = null
  private listeners = new Set<Listener>()
  private statusListeners = new Set<StatusListener>()
  private retryMs = 500
  private closed = false
  private retry: ReturnType<typeof setTimeout> | null = null

  connect(): void {
    this.closed = false
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`
    const socket = new WebSocket(url)
    this.socket = socket
    socket.onopen = () => {
      this.retryMs = 500
      for (const listener of this.statusListeners) listener(true)
    }
    socket.onmessage = (message) => {
      if (typeof message.data !== 'string') return // the backend sends JSON text only
      let event: BackendEvent
      try {
        event = JSON.parse(message.data) as BackendEvent
      } catch {
        return // one bad frame must not stop the event stream
      }
      for (const listener of this.listeners) listener(event)
    }
    socket.onclose = () => {
      for (const listener of this.statusListeners) listener(false)
      if (this.closed) return
      this.retry = setTimeout(() => this.connect(), this.retryMs)
      this.retryMs = Math.min(this.retryMs * 2, 5000)
    }
  }

  close(): void {
    this.closed = true
    if (this.retry) clearTimeout(this.retry) // a pending reconnect would open it again
    this.retry = null
    this.socket?.close()
  }

  on(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }
}

export const events = new EventSocket()
