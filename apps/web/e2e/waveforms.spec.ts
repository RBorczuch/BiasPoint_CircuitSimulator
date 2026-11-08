import { expect, type Page, test } from '@playwright/test'

type Point = [number, number]

async function clickWorld(page: Page, p: Point): Promise<void> {
  // The schematic editor starts asynchronously (e.g. after switching back to its workspace).
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate((world) => {
    if (!window.__bpt) throw new Error('editor not ready')
    return window.__bpt.toScreen(world as [number, number])
  }, p)
  await page.mouse.click(x, y)
}

test('probe, panes and comparing runs', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'plots' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 PULSE(0 1 0 1n 1n 2m 4m)\nR1 in out 1k\nC1 out 0 1u' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_simulation',
        simulation: {
          active: 'tran',
          cards: { op: '.op', dc: '.dc V1 0 1 0.1', ac: '.ac dec 20 10 1meg', tran: '.tran 10u 8m' },
        },
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 2')

  // Probe the "out" net on the schematic: the wire stub of C1 pin 1 (C1 is auto-placed).
  const doc = await (await request.get(`/api/projects/${id}/document`)).json()
  const sheet = doc.project.sheets[0]
  const outLabel = sheet.labels.find((l: { text: string }) => l.text === 'out')
  const wire = sheet.wires.find((w: { points: Point[] }) =>
    w.points.some((p) => p[0] === outLabel.at[0] && p[1] === outLabel.at[1]),
  )
  const simulate = page.getByRole('navigation').getByRole('button', { name: 'Simulate' })
  await simulate.click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('navigation').getByRole('button', { name: 'Schematic' }).click()
  await page.keyboard.press('Control+p')
  const [a, b] = wire.points
  await clickWorld(page, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])

  // The Simulate workspace has no schematic; the probed trace is there.
  await simulate.click()
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible()
  await expect(page.getByTestId('waveforms').locator('canvas')).toHaveCount(1)

  // Signals by name: the browser lists named nets and part currents.
  await page.getByTitle(/Add signal/).click()
  await page.getByPlaceholder(/Signal or expression/).fill('V(in')
  await page.getByRole('option', { name: 'V(in)' }).click()
  await expect(page.getByRole('button', { name: 'V(in)', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Options for V(in)' }).click()
  await page.getByRole('menuitem', { name: 'Use as X axis (XY plot)' }).click()
  await expect(page.getByText('(X axis)')).toBeVisible()
  await expect(page.getByTestId('waveforms').locator('canvas')).toHaveCount(1)
  await page.getByRole('button', { name: 'Remove V(in)' }).click()

  // A second trace in a new pane: two plots.
  await page.getByTitle(/Add expression/).click()
  await page.getByRole('textbox').last().fill('I(R1)')
  await page.keyboard.press('Enter')
  await page.getByRole('button', { name: 'Options for I(R1)' }).click()
  await page.getByRole('menuitem', { name: 'Move to pane' }).click()
  await page.getByRole('menuitem', { name: 'New pane' }).click()
  await expect(page.getByTestId('waveforms').locator('canvas')).toHaveCount(2)

  // Run again with another R and compare with the previous run.
  await request.patch(`/api/projects/${id}/circuit/components/R1`, { data: { params: { R: '2k' } } })
  await page.keyboard.press('Escape')
  await page.keyboard.press('F5')
  await expect(page.getByTitle(/Compare with the previous run/)).toBeEnabled({ timeout: 20_000 })
  await page.getByTitle(/Compare with the previous run/).click()
  // The finished second run must not look like it is still starting (response/event race).
  await expect(page.getByText(/TRAN · ok/)).toBeVisible()
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0)
})

test('simulation log links messages to parts', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'log' } })).json()).id
  // ngspice warns about the unknown model parameter but simulates.
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 a 0 DC 5\nR1 a b 1k\nD1 b 0 DX\n.model DX D(IS=1e-14 FOO=3)' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.getByRole('button', { name: 'Run F5' }).click()
  await page.locator('.dv-tab', { hasText: /^Log$/ }).click()
  await expect(page.getByText(/unrecognized parameter \(foo\)/)).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'D1', exact: true }).click()
  await expect(page.locator('footer')).toContainText('1 selected')
})
