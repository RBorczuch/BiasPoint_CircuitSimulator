/**
 * Performance budgets of NFR-2 (run with `pnpm bench`; results go to docs/benchmarks.md).
 * Each test prints one line "BENCH <name>: <numbers>".
 */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

test.describe.configure({ timeout: 300_000 })
// Real GPU: headless Chromium renders WebGL in software (SwiftShader) otherwise.
test.use({ launchOptions: { args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'] } })

const report = (name: string, values: Record<string, number | string>) =>
  console.log(
    `BENCH ${name}: ${Object.entries(values)
      .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toPrecision(4)) : v}`)
      .join(' ')}`,
  )

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]

async function project(request: APIRequestContext, name: string, netlist: string[]): Promise<string> {
  const id = (await (await request.post('/api/projects', { data: { name } })).json()).id
  const r = await request.post(`/api/projects/${id}/circuit/import`, { data: { text: netlist.join('\n') } })
  expect(r.ok()).toBe(true)
  return id
}

async function run(request: APIRequestContext, id: string, card: string): Promise<string> {
  const job = await (await request.post(`/api/projects/${id}/analyses/run`, { data: { card } })).json()
  for (;;) {
    const info = await (await request.get(`/api/jobs/${job.job_id}`)).json()
    if (info.status === 'ok') return info.run_id
    if (info.status === 'error' || info.status === 'cancelled') throw new Error(info.error)
    await new Promise((r) => setTimeout(r, 2))
  }
}

/** Mean time per animation frame while the view zooms (wheel) and pans (middle drag). */
async function frameTimes(page: Page): Promise<{ zoom: number; pan: number }> {
  return page.evaluate(async () => {
    const canvas = document.querySelector('canvas') as HTMLCanvasElement
    const box = canvas.getBoundingClientRect()
    const [cx, cy] = [box.left + box.width / 2, box.top + box.height / 2]
    const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)))
    await frame()
    let t = performance.now()
    for (let i = 0; i < 60; i++) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          deltaY: i % 20 < 10 ? 100 : -100,
          clientX: cx,
          clientY: cy,
          bubbles: true,
        }),
      )
      await frame()
    }
    const zoom = (performance.now() - t) / 60
    const pointer = (type: string, x: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          clientX: x,
          clientY: cy,
          button: 1,
          buttons: 4,
          pointerId: 1,
          bubbles: true,
        }),
      )
    pointer('pointerdown', cx)
    t = performance.now()
    for (let i = 0; i < 60; i++) {
      pointer('pointermove', cx + (i % 30 < 15 ? i % 15 : 15 - (i % 15)) * 10)
      await frame()
    }
    const pan = (performance.now() - t) / 60
    pointer('pointerup', cx)
    return { zoom, pan }
  })
}

test('editor with 5000 objects', async ({ page, request }) => {
  const lines = ['V1 n0 0 DC 1']
  for (let i = 0; i < Number(process.env.BENCH_PARTS ?? 1000); i++) lines.push(`R${i + 1} n${i} n${i + 1} 1k`)
  const id = await project(request, 'bench-editor', lines)
  const doc = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
  const objects = doc.instances.length + doc.wires.length + doc.labels.length + doc.junctions.length
  const t0 = Date.now()
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev ')
  await page.waitForFunction(() => window.__bpt !== undefined)
  const load = Date.now() - t0
  await page.evaluate(() => window.__bpt?.fit())
  const gpu = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl?.getParameter(ext.UNMASKED_RENDERER_WEBGL)).split(',')[1]?.trim() : '?'
  })
  const { zoom, pan } = await frameTimes(page)
  const t1 = Date.now()
  await page.keyboard.press('Control+a')
  await expect(page.getByText(/\d+ selected/)).toBeVisible()
  report('editor', {
    gpu: JSON.stringify(gpu),
    objects,
    load_ms: load,
    zoom_fps: 1000 / zoom,
    pan_fps: 1000 / pan,
    select_all_ms: Date.now() - t1,
  })
})

test('operating point of a circuit with 100 elements', async ({ request }) => {
  const lines = ['V1 n0 0 DC 10']
  for (let i = 0; i < 50; i++) lines.push(`R${2 * i + 1} n${i} n${i + 1} 1k`, `R${2 * i + 2} n${i + 1} 0 10k`)
  const id = await project(request, 'bench-op', lines)
  await run(request, id, '.op') // warm the worker up
  const times: number[] = []
  for (let i = 0; i < 15; i++) {
    const t = performance.now()
    const runId = await run(request, id, '.op')
    const values = await (await request.get(`/api/runs/${runId}/values`)).json()
    expect(Object.keys(values.values).length).toBeGreaterThan(50)
    times.push(performance.now() - t)
  }
  report('op', { elements: lines.length, median_ms: median(times), max_ms: Math.max(...times) })
})

test('transient with 10 million points', async ({ request }) => {
  const id = await project(request, 'bench-wave', ['V1 in 0 SIN(0 1 1k)', 'R1 in out 1k', 'C1 out 0 100n'])
  const t = performance.now()
  const runId = await run(request, id, '.tran 1n 10m 0 1n')
  const simulate = performance.now() - t
  const meta = await (await request.get(`/api/runs/${runId}`)).json()
  const query = async (x_min: number | null, x_max: number | null) => {
    const t1 = performance.now()
    const r = await request.post(`/api/runs/${runId}/query`, {
      data: { signals: ['V(out)', 'V(in)'], pixels: 2000, x_min, x_max, format: 'binary' },
    })
    expect(r.ok()).toBe(true)
    await r.body()
    return performance.now() - t1
  }
  const full = [await query(null, null), await query(null, null), await query(null, null)]
  const windows: number[] = []
  for (let i = 0; i < 20; i++) windows.push(await query(i * 4e-4, i * 4e-4 + 2e-3)) // scrolling a 2 ms window
  report('waveform', {
    points: meta.points ?? meta.length ?? '?',
    simulate_s: simulate / 1000,
    full_view_ms: median(full),
    scroll_ms: median(windows),
    scroll_max_ms: Math.max(...windows),
  })
})
