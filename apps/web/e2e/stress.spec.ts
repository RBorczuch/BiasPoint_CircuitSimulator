import { expect, test } from '@playwright/test'

test('ratings in the inspector, stress marks and Problems after a run', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'stress' } })).json()).id
  // 15 V on a 16 V capacitor (no margin); 0.4 W in a 0.25 W resistor (over).
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 a 0 DC 15\nC1 a 0 10u\nV2 b 0 DC 20\nR2 b 0 1k' },
  })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const inst = async (ref: string) =>
    (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === ref)
  const c1 = await inst('C1')
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'update_instance', sheet: 'root', id: c1.id, ratings: { voltage: '16' } } },
  })
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await expect(page.locator('footer')).toContainText('rev 2')

  // The resistor's power rating typed in the inspector.
  const r2 = await inst('R2')
  await expect(async () => {
    const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p as [number, number]) ?? [0, 0], r2.at)
    await page.mouse.click(x, y)
    await expect(page.getByRole('button', { name: 'Ratings' })).toBeVisible({ timeout: 1000 })
  }).toPass()
  await page.getByRole('button', { name: 'Ratings' }).click() // collapsed while a part has none
  await page.getByRole('textbox', { name: 'Rated Power' }).fill('0.25')
  await page.getByRole('textbox', { name: 'Rated Power' }).press('Enter')
  await expect.poll(async () => (await inst('R2')).ratings).toEqual({ power: '0.25' })

  await page.keyboard.press('F5')
  await expect(page.getByText('1 rating exceeded')).toBeVisible({ timeout: 20_000 })
  await expect(page.getByText('160 %')).toBeVisible() // 0.4 W of 0.25 W, next to the field
  await page.getByRole('tab', { name: 'Problems' }).click()
  await expect(page.getByText(/R2.*overstressed/)).toBeVisible()
  await expect(page.getByText(/C1.*/).filter({ hasText: '%' }).first()).toBeVisible()
})
