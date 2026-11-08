import { expect, test } from '@playwright/test'

test('a module simulates as its averaged model, chosen in the inspector', async ({ page, request }) => {
  const info = await (await request.post('/api/library/examples/lm2596_module/open')).json()
  try {
    // The averaged model needs no small time step: a plain 5 ms transient.
    const doc = (await (await request.get(`/api/projects/${info.id}/document`)).json()).project
    const simulation = { ...doc.simulation, cards: { ...doc.simulation.cards, tran: '.tran 1u 5m' } }
    await request.post(`/api/projects/${info.id}/commands`, {
      data: { command: { type: 'set_simulation', simulation } },
    })
    await page.goto(`/?project=${info.id}`)
    await page.waitForFunction(() => window.__bpt !== undefined)
    await expect(page.locator('footer')).toContainText('rev 1')
    const [x, y] = await page.evaluate(() => window.__bpt?.toScreen([2032, -1016]) ?? [0, 0])
    await page.mouse.click(x, y)
    const variant = page.getByLabel('Variant')
    await expect(variant.locator('option')).toHaveText(['Switching (full)', 'Averaged (no switching)'])
    await variant.selectOption({ label: 'Averaged (no switching)' })
    await expect
      .poll(async () => {
        const project = (await (await request.get(`/api/projects/${info.id}/document`)).json()).project
        return project.sheets[0].instances.find((i: { ref: string }) => i.ref === 'U1').model.variant
      })
      .toBe('averaged')
    const netlist = await (await request.get(`/api/projects/${info.id}/export/netlist`)).text()
    expect(netlist).toContain('XU1 in out 0 sheet_lm2596_module_avg')

    await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
    await page.keyboard.press('F5')
    await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })
  } finally {
    await request.delete(`/api/projects/${info.id}`)
  }
})
