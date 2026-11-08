import { expect, test } from '@playwright/test'

test('a decimal comma in a value is stored with a point', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'comma' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'V1 a 0 DC 1\nR1 a 0 1k' } })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  const doc = await (await request.get(`/api/projects/${id}/document`)).json()
  const r1 = doc.project.sheets[0].instances.find((i: { ref: string }) => i.ref === 'R1')
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate((at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0], r1.at)
  await expect(async () => {
    await page.mouse.click(x, y)
    await expect(page.getByRole('textbox', { name: 'R', exact: true })).toBeVisible({ timeout: 500 })
  }).toPass()
  const field = page.getByRole('textbox', { name: 'R', exact: true })
  await field.fill('4,7k')
  await expect(page.getByText(/= 4.7 ?kΩ/)).toBeVisible()
  await field.press('Enter')
  await expect
    .poll(async () => {
      const d = await (await request.get(`/api/projects/${id}/document`)).json()
      return d.project.sheets[0].instances.find((i: { ref: string }) => i.ref === 'R1').model.params.R
    })
    .toBe('4.7k')

  // The console takes SPICE lines with decimal commas too.
  await page.getByRole('textbox', { name: 'SPICE command line' }).fill('C1 a 0 2,2u')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await request.get(`/api/projects/${id}/export/netlist`)).text())
    .toMatch(/^C1 a 0 2.2u$/m)
})
