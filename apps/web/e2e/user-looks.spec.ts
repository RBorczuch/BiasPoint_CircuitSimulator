import { expect, test } from '@playwright/test'

test('a drawing made in the editor becomes another look of the current source', async ({ page, request }) => {
  await request.delete('/api/library/libraries/e2e-looks')
  const id = (await (await request.post('/api/projects', { data: { name: 'looks' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'I1 a 0 DC 1m\nR1 a 0 1k' } })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)

  // Edit a copy of the built-in current source: same pins, so it can be another drawing of it.
  await page
    .getByTestId('library-group-Sources/Current')
    .getByRole('button', { name: /^Current source/ })
    .hover()
  await page.getByRole('button', { name: 'Actions of Current source' }).click()
  await page.getByRole('menuitem', { name: 'Edit the drawing…' }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  await editor.getByRole('textbox', { name: 'Symbol name' }).fill('Ammeter style')
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-looks')
  await editor
    .getByRole('combobox', { name: 'Save as' })
    .selectOption({ label: 'another drawing of Current source' })
  await editor.getByRole('combobox', { name: 'Drawing for' }).selectOption('offered') // chosen per part
  await editor.getByRole('button', { name: 'Save drawing' }).click()
  await expect(page.getByText('Saved as another drawing of Current source')).toBeVisible()

  // The part chooses it in the inspector; the project keeps a copy.
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const i1 = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'I1')
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate((at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0], i1.at)
  await expect(async () => {
    await page.mouse.click(x, y)
    await expect(page.getByRole('combobox', { name: 'Symbol look' })).toBeVisible({ timeout: 500 })
  }).toPass()
  await page.getByRole('combobox', { name: 'Symbol look' }).selectOption({ label: 'Ammeter style' })
  await expect
    .poll(async () => {
      const project = await doc()
      return [
        project.sheets[0].instances.find((i: { ref: string }) => i.ref === 'I1').look,
        Object.keys(project.looks ?? {}),
      ]
    })
    .toEqual(['user:e2e-looks/Ammeter style', ['bpt:isource']])
  await request.delete('/api/library/libraries/e2e-looks')
})
