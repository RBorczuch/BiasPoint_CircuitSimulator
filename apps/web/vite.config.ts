/// <reference types="vitest/config" />
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type ProxyOptions } from 'vite'

// Ports can be moved (e.g. an isolated instance for end-to-end tests).
const BACKEND = `http://127.0.0.1:${process.env.BPT_BACKEND_PORT ?? 8765}`

/** Same location as `bpt.api.security.session_file()` (platformdirs user_state_path). */
function sessionFile(): string {
  if (process.env.BPT_SESSION_FILE) return process.env.BPT_SESSION_FILE
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'BiasPoint', 'session.json')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'BiasPoint', 'session.json')
  }
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'BiasPoint', 'session.json')
}

/** Read on every request: the backend writes a fresh token each time it starts. */
function sessionToken(): string {
  try {
    return JSON.parse(readFileSync(sessionFile(), 'utf8')).token ?? ''
  } catch {
    return ''
  }
}

const backendProxy: ProxyOptions = {
  target: BACKEND,
  changeOrigin: true,
  ws: true,
  configure: (proxy) => {
    proxy.on('proxyReq', (req) => req.setHeader('x-bpt-token', sessionToken()))
    proxy.on('proxyReqWs', (req) => req.setHeader('x-bpt-token', sessionToken()))
  },
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': join(import.meta.dirname, 'src') },
  },
  server: {
    host: '127.0.0.1',
    port: Number(process.env.BPT_WEB_PORT ?? 5173),
    strictPort: true,
    proxy: { '/api': backendProxy, '/ws': backendProxy },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
