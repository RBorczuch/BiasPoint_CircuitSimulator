import { expect, test } from '@playwright/test'

test('the part form reads by heading; Advanced is folded and says what changed in it', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'groups' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('film')

  await expect(wizard.getByTestId('field-Cnom')).toContainText('Main')
  await expect(wizard.getByTestId('field-esr')).toContainText('Loss')
  // The dielectric absorption is there, folded.
  const fold = wizard.getByRole('button', { name: /^Advanced/ })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await expect(wizard.getByRole('button', { name: 'About R da' })).toHaveCount(0)
  await fold.click()
  const rda = wizard.getByTestId('field-rda').getByRole('textbox')
  await rda.fill('1meg')
  await fold.click()
  await expect(rda).toHaveCount(0)
  await expect(fold).toContainText('1 changed')
})

test('a SPICE model in the inspector: its parameters have cards', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'cards' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 a 0 DC 1\nD1 a 0 MYD\n.model MYD D(IS=2.5n XTI=3)' },
  })
  const doc = (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const part = doc.sheets[0].instances.find((i: { ref: string }) => i.ref === 'D1')
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())
  const [x, y] = await page.evaluate(
    (at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0],
    part.at,
  )
  await page.mouse.click(x, y)
  const params = page.getByTestId('model-params')
  await params.getByText('Model parameters (2)').click()
  await params.getByRole('button', { name: 'About XTI' }).hover()
  await expect(page.getByTestId('param-help-xti')).toContainText('IS temperature exponent')
  await params.getByRole('button', { name: 'About IS' }).hover()
  await expect(page.getByTestId('param-help-is')).toContainText('From the datasheet')
})
