import { expect, test } from '@playwright/test'

test('Ś9: a part from the selection takes its place; K6: flattened back into its circuit', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-sel')
  const id = (await (await request.post('/api/projects', { data: { name: 'selection' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 1\nR1 in out 1k\nC1 out 0 10n' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const root = (await doc()).sheets[0]
  const at = (ref: string) =>
    root.instances.find((i: { ref: string }) => i.ref === ref).at as [number, number]

  // Select R1 and C1, right click: Make a part from the selection.
  for (const [k, ref] of ['R1', 'C1'].entries()) {
    const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p) ?? [0, 0], at(ref))
    await page.mouse.click(x, y, { modifiers: k ? ['Shift'] : [] })
  }
  const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p) ?? [0, 0], at('R1'))
  await page.mouse.click(x, y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Make a part from the selection…' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('RC low-pass')
  await page.keyboard.press('Enter')

  const editor = page.getByTestId('component-wizard')
  await expect(editor.getByTestId('part-data')).toBeVisible() // it opens on its data
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-sel')
  await editor.getByLabel('Category').selectOption('Other')
  await editor.getByRole('textbox', { name: 'Manufacturer' }).fill('E2E')
  await editor
    .getByRole('button', { name: 'Save and use for the part' })
    .or(editor.getByRole('button', { name: 'Save to library' }))
    .click()

  // The saved part replaced the block: a library part on the sheet, one instance in place of two.
  await expect
    .poll(async () =>
      (await doc()).sheets.some((s: { owner?: string }) => s.owner === 'cmp:e2e-sel/RC low-pass'),
    )
    .toBe(true)
  const parts = await (await request.get('/api/library/components')).json()
  expect(parts['cmp:e2e-sel/RC low-pass'].metadata.manufacturer).toBe('E2E')

  // K6: right click the placed part → Flatten: its circuit is back on the sheet.
  const placed = (await doc()).sheets[0].instances.find((i: { symbol: string }) =>
    i.symbol.startsWith('sheet:'),
  )
  await page.evaluate(() => window.__bpt?.fit())
  const [px, py] = await page.evaluate(
    (p) => window.__bpt?.toScreen(p) ?? [0, 0],
    placed.at as [number, number],
  )
  await page.mouse.click(px, py, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Flatten (put its circuit here)' }).click()
  await expect
    .poll(async () => (await doc()).sheets[0].instances.map((i: { symbol: string }) => i.symbol).sort())
    .toEqual(['bpt:capacitor', 'bpt:gnd', 'bpt:gnd', 'bpt:resistor', 'bpt:vsource'])
  await request.delete('/api/library/libraries/e2e-sel')
})
