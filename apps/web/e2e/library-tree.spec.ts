import { expect, test } from '@playwright/test'

test('library tree: categories with the ideal part first, folding remembered, shortcut places an ideal part', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'tree' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const resistors = page.getByTestId('library-group-Resistors')
  await expect(resistors.getByRole('button', { name: /^Resistor 1k/ })).toBeVisible()
  // A category folds and stays folded (remembered).
  await resistors
    .getByRole('button', { name: /^Resistors/ })
    .first()
    .click()
  await expect(resistors.getByRole('button', { name: /^Resistor 1k/ })).toHaveCount(0)
  await page.reload()
  await expect(
    page.getByTestId('library-group-Resistors').getByRole('button', { name: /^Resistor 1k/ }),
  ).toHaveCount(0)
  await page
    .getByTestId('library-group-Resistors')
    .getByRole('button', { name: /^Resistors/ })
    .first()
    .click()

  // C places an ideal capacitor.
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 300, y: 300 } })
  await page.keyboard.press('C')
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 400, y: 300 } })
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return doc.project.sheets[0].instances.map((i: { symbol: string }) => i.symbol)
    })
    .toEqual(['bpt:capacitor'])
  await page.evaluate(() => localStorage.removeItem('bpt.library.toggled'))
})
