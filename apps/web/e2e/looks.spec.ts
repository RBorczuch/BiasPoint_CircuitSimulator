import { expect, test } from '@playwright/test'

test('symbol standard and per-part looks', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'looks' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 a 0 DC 5\nR1 a b 1k\nC1 b 0 10u' },
  })
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => localStorage.removeItem('bpt.settings'))
  const resistor = page.getByRole('button', { name: /^Resistor/ })
  await expect(resistor.locator('svg rect')).toHaveCount(1) // IEC: a box

  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /Settings/ }).click()
  await page.getByRole('button', { name: 'ANSI', exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(resistor.locator('svg rect')).toHaveCount(0) // ANSI: a zigzag
  await expect(resistor.locator('svg polyline')).toHaveCount(1)

  // C1 drawn as an electrolytic capacitor: stored in the part, one undo step.
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const c1 = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'C1')
  const [x, y] = await page.evaluate((at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0], c1.at)
  await page.mouse.click(x, y)
  await page.getByRole('combobox', { name: 'Symbol look' }).selectOption('electrolytic-eu')
  await expect
    .poll(async () => (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'C1').look)
    .toBe('electrolytic-eu')
  await page.evaluate(() => localStorage.removeItem('bpt.settings'))
})
