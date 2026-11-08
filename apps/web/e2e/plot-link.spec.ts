import { expect, test } from '@playwright/test'

test('plot and schematic point at each other', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'link' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 SIN(0 1 1k)\nR1 in out 1k\nC1 out 0 100n' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_simulation',
        simulation: {
          active: 'tran',
          cards: { op: '.op', dc: '.dc V1 0 1 0.1', ac: '.ac dec 20 10 1meg', tran: '.tran 10u 3m' },
        },
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })

  // Schematic -> plot: hovering the "out" wire shows its waveform in small.
  await page.getByRole('navigation').getByRole('button', { name: 'Schematic' }).click()
  await page.waitForFunction(() => window.__bpt !== undefined)
  const sheet = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
  const out = sheet.labels.find((l: { text: string }) => l.text === 'out')
  const wire = sheet.wires.find((w: { points: number[][] }) =>
    w.points.some((p) => p[0] === out.at[0] && p[1] === out.at[1]),
  )
  const [a, b] = wire.points
  const [x, y] = await page.evaluate(
    (p) => window.__bpt?.toScreen(p as [number, number]) ?? [0, 0],
    [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2],
  )
  await page.mouse.move(x - 3, y)
  await page.mouse.move(x, y)
  await expect(page.getByTestId('mini-wave')).toBeVisible()

  // Plot -> schematic: a trace's menu shows where it comes from.
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.getByRole('button', { name: 'Options for V(out)' }).click()
  await page.getByRole('menuitem', { name: 'Show on schematic' }).click()
  await expect(page.getByRole('tab', { name: 'root' })).toBeVisible()
})
