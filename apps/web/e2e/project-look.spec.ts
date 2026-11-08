import { expect, test } from '@playwright/test'

test("a built-in symbol's drawing changed for this project, new parts get it, restored", async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'look' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'R1 a 0 1k\nR2 a b 2k' } })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const looks = async () =>
    (await doc()).sheets[0].instances
      .filter((i: { symbol: string }) => i.symbol === 'bpt:resistor')
      .map((i: { look?: string | null }) => i.look ?? null)

  // Ś8: row → Edit the drawing → save for this project: both resistors change.
  await page.getByTestId('part-Resistor').hover()
  await page.getByRole('button', { name: 'Actions of Resistor' }).click()
  await page.getByRole('menuitem', { name: 'Edit the drawing…' }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  await expect(editor.getByRole('combobox', { name: 'Save as' })).toHaveValue('bpt:resistor')
  await expect(editor.getByRole('combobox', { name: 'Drawing for' })).toHaveValue('project')
  await editor.getByRole('textbox', { name: 'Symbol name' }).fill('Slim')
  await editor.getByRole('button', { name: 'Save drawing' }).click()
  await expect(page.getByText('Resistor drawn as “Slim” in this project')).toBeVisible()
  await expect.poll(looks).toEqual(['project:Slim', 'project:Slim'])
  expect((await doc()).default_looks).toEqual({ 'bpt:resistor': 'project:Slim' })

  // A new resistor gets it too.
  await page
    .getByTestId('part-Resistor')
    .getByRole('button', { name: /^Resistor/ })
    .click()
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 500, y: 420 } })
  await page.keyboard.press('Escape')
  await expect.poll(async () => (await looks()).length).toBe(3)
  expect(await looks()).toEqual(['project:Slim', 'project:Slim', 'project:Slim'])

  // Restored: the built-in drawing again.
  await page.getByTestId('part-Resistor').hover()
  await page.getByRole('button', { name: 'Actions of Resistor' }).click()
  await page.getByRole('menuitem', { name: 'Restore the built-in drawing here' }).click()
  await expect.poll(looks).toEqual([null, null, null])
})
