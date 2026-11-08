import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

/**
 * End-to-end tests against the real backend (ngspice) and the Vite dev server.
 * They run an isolated instance (ports 8766 / 5174, own session file), so a BiasPoint the
 * user has open on 8765 / 5173 is never touched.
 */
// Autosave copies of one run only: the dev backend reopens whatever it finds there. The main
// process clears the folder; workers inherit it through the environment. One fixed folder: a test
// backend left running by an earlier run (reused, see webServer) writes where the tests look.
if (!process.env.BPT_RECOVERY_DIR) {
  rmSync(join(tmpdir(), 'biaspoint-e2e-recovery'), { recursive: true, force: true })
  process.env.BPT_RECOVERY_DIR = join(tmpdir(), 'biaspoint-e2e-recovery', 'run')
}

const env = {
  BPT_SESSION_FILE: join(tmpdir(), 'biaspoint-e2e-session.json'),
  BPT_LIBRARY_DIR: join(tmpdir(), 'biaspoint-e2e-libraries'), // never the user's own libraries
  BPT_RECOVERY_DIR: process.env.BPT_RECOVERY_DIR as string, // never the user's unsaved work
  BPT_BACKEND_PORT: '8766',
  BPT_WEB_PORT: '5174',
}

export default defineConfig({
  testDir: 'e2e',
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1400, height: 850 } },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.002 } },
  webServer: [
    {
      command: 'uv run --directory ../../backend bpt serve --dev --port 8766',
      url: 'http://127.0.0.1:8766/api/health',
      reuseExistingServer: true,
      timeout: 60_000,
      env,
    },
    { command: 'pnpm dev', url: 'http://127.0.0.1:5174', reuseExistingServer: true, env },
  ],
})
