import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('analysis graph: power of a resistor and its average', async ({ page, request }) => {
  await page.setViewportSize({ width: 1400, height: 850 })
  const id = (await (await request.post('/api/projects', { data: { name: 'graph' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 2\nR1 in out 1k\nR2 out 0 1k' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Power and its average' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /OK|Create|Save/ })
    .click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await page.getByRole('button', { name: /Run graph/ }).click()
  await expect(page.getByTestId('node-value')).toHaveText('1 mW', { timeout: 20_000 })
  await expect(page.getByTestId('graph-canvas').locator('canvas').first()).toBeVisible()

  // The plot node opens a full-screen viewer.
  await page.getByRole('button', { name: 'Full screen' }).click()
  await expect(page.getByTestId('plot-viewer')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('plot-viewer')).toHaveCount(0)
})

test('quick simulation opens as a graph; auto-run follows schematic changes', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'quick' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 2\nR1 in out 1k\nR2 out 0 1k' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_simulation',
        simulation: {
          active: 'tran',
          cards: { op: '.op', dc: '.dc V1 0 1 0.1', ac: '.ac dec 20 10 1meg', tran: '.tran 10u 1m' },
        },
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 2')
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Open as analysis graph' }).click()

  // Analysis workspace: Circuit → Transient → Signal(s) → Plot, already run.
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Transient' })).toHaveCount(1)
  await expect(page.locator('.react-flow__node').filter({ hasText: /V\(out\): \d+ points/ })).toHaveCount(1, {
    timeout: 20_000,
  })

  // Auto-run: a new value of R2 is picked up without pressing F5.
  await page.getByRole('checkbox', { name: 'Run automatically' }).check()
  await request.patch(`/api/projects/${id}/circuit/components/R2`, { data: { params: { R: '3k' } } })
  await expect(page.locator('.react-flow__node').filter({ hasText: /V\(out\): .*1\.5V/ })).toHaveCount(1, {
    timeout: 20_000,
  })
})

test('a parameter sweep draws one curve per value and a table', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'sweep' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 AC 1\nR1 in out {R}\nC1 out 0 100n' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Parameter sweep' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  await page.keyboard.press('F5') // F5 runs the graph in the Analysis workspace
  const table = page.getByTestId('rf__node-table')
  await expect(table).toContainText('R=5k', { timeout: 30_000 })
  await expect(table).toContainText('318')
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Plot' })).toContainText('V(out) [R=2k]')
})

test('step response template measures the edge; Bode shows two panes', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'step' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 AC 1 PULSE(0 1 0 1n 1n 5m 10m)\nR1 in out 1k\nC1 out 0 100n' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Step response' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(8)
  await page.keyboard.press('F5')
  const table = page.getByTestId('rf__node-table')
  await expect(table).toContainText('rise(V(out))', { timeout: 20_000 })
  await expect(table).toContainText('219.6 µs') // 2.2 RC
  await expect(table).not.toContainText('T%') // no SI prefix on percent

  await page.getByRole('button', { name: /New graph/ }).click()
  await page.getByRole('menuitem', { name: /Frequency response/ }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(6)
  const plot = page.locator('.react-flow__node').filter({ hasText: 'Plot' })
  await plot.getByRole('combobox', { name: 'AC as' }).selectOption('bode')
  await page.keyboard.press('F5')
  await expect(plot.locator('canvas')).toHaveCount(2, { timeout: 20_000 })
})

test('Monte Carlo template: histogram and a specification verdict', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'mc' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Monte Carlo' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await expect(page.locator('.react-flow__node')).toHaveCount(7)
  const spec = page.locator('.react-flow__node').filter({ hasText: 'Specification' })
  const condition = spec.getByRole('textbox', { name: 'Condition' })
  await condition.fill('900..1.1k')
  await condition.press('Enter')
  await page.keyboard.press('F5')
  await expect(page.getByTestId('spec-verdict')).toContainText('yield', { timeout: 60_000 })
  await expect(page.getByTestId('histogram')).toContainText('n = 50')
  // Nodes whose size does not change after a run stay visible (they used to vanish).
  await expect(page.getByTestId('rf__node-circuit')).toBeVisible()
  // The Log panel of the Analysis area shows the graph's run (it said "No simulation run yet").
  await page.getByRole('tab', { name: 'Log' }).click()
  await expect(page.getByTestId('graph-log')).toContainText('Monte Carlo')
})

test('a saved project opened again shows its graph results without simulating', async ({ page, request }) => {
  const folder = mkdtempSync(join(tmpdir(), 'bpt-e2e-cache-'))
  const path = join(folder, 'cached.bpt')
  const id = (await (await request.post('/api/projects', { data: { name: 'cached' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 2\nR1 in out 1k\nR2 out 0 1k' },
  })
  await request.post(`/api/projects/${id}/save`, { data: { path } })
  await page.goto(`/?project=${id}`)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Power and its average' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await page.getByRole('button', { name: /Run graph/ }).click()
  await expect(page.getByTestId('node-value')).toHaveText('1 mW', { timeout: 20_000 })
  await request.post(`/api/projects/${id}/save`, { data: {} })
  await request.delete(`/api/projects/${id}`)

  const again = (await (await request.post('/api/projects/open', { data: { path } })).json()).id
  await page.goto(`/?project=${again}`)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await expect(page.getByTestId('node-value')).toHaveText('1 mW', { timeout: 20_000 })
  await expect(page.getByTestId('node-restored').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /Run graph/ })).toBeEnabled()
})
