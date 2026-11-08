import { expect, test } from '@playwright/test'

test('save a sheet as a template, make a component from it; standard templates drawn', async ({
  page,
  request,
}) => {
  for (const lib of ['e2e-templates', 'e2e-tparts']) await request.delete(`/api/library/libraries/${lib}`)
  const id = (await (await request.post('/api/projects', { data: { name: 'tpl' } })).json()).id
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'add_sheet', sheet: { name: 'twocap', parameters: { c1: '1u', c2: '10n' } } } },
  })
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'C1 1 2 {c1}\nC2 1 2 {c2}', sheet: 'twocap' },
  })
  const doc = (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const sheet = doc.sheets.find((s: { name: string }) => s.name === 'twocap')
  const ports = sheet.labels.map((l: { text: string; at: number[] }) => ({
    kind: 'port',
    text: l.text,
    at: l.at,
  }))
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'add_objects', sheet: 'twocap', labels: ports } },
  })

  await page.goto(`/?project=${id}`)
  await page.getByRole('tab', { name: 'twocap' }).click()
  await page.getByRole('button', { name: 'Save as model…' }).click()
  const editor = page.getByTestId('template-editor')
  await editor.getByRole('textbox', { name: 'Model name' }).fill('E2E Two caps')
  await editor.getByRole('textbox', { name: 'Model library' }).fill('e2e-templates')
  await editor.getByLabel('Model kind').selectOption('capacitor')
  await editor.getByRole('textbox', { name: 'Label of c1' }).fill('C bulk')
  await editor.getByRole('textbox', { name: 'Unit of c1' }).fill('F')
  await editor.getByRole('textbox', { name: 'Unit of c1' }).blur()
  await editor.getByRole('tab', { name: 'Symbol' }).click()
  await editor.getByRole('button', { name: 'Like the Capacitor' }).click()
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save model' }).click()
  await expect(page.getByText('Model E2E Two caps saved in “e2e-templates” (version 1)')).toBeVisible()

  // In the library: a click opens the maker with the template, its circuit drawn with the values.
  await page
    .getByTestId('template-E2E Two caps')
    .getByRole('button', { name: /New: E2E Two caps/ })
    .click()
  const wizard = page.getByTestId('component-wizard')
  await expect(wizard.getByRole('combobox', { name: 'Model' })).toHaveValue('tpl:e2e-templates/E2E Two caps')
  await wizard.getByRole('textbox', { name: 'C bulk', exact: true }).fill('47u')
  await expect(wizard.getByTestId('template-circuit')).toContainText('47 µF')
  await expect(wizard.getByRole('img', { name: '|Z|(f)' })).toBeVisible({ timeout: 20_000 }) // by simulation
  await wizard.getByRole('textbox', { name: 'Part name' }).fill('E2E47U')
  await wizard.getByRole('textbox', { name: 'Library' }).fill('e2e-tparts')
  await wizard.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByText('E2E47U saved in library “e2e-tparts”')).toBeVisible()
  const parts = await (await request.get('/api/library/components')).json()
  expect(parts['cmp:e2e-tparts/E2E47U'].sheets[0].parameters).toEqual({ c1: '47u', c2: '10n' })

  // A standard template with four pins: drawn, with a transformer's characteristics.
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  await wizard
    .getByRole('combobox', { name: 'Model' })
    .selectOption('tpl:Standard templates/Real transformer')
  await expect(wizard.getByTestId('template-circuit').locator('svg')).toBeVisible()
  await expect(wizard.getByRole('tab', { name: 'Ratio(f)', exact: true })).toBeVisible()
  for (const lib of ['e2e-templates', 'e2e-tparts']) await request.delete(`/api/library/libraries/${lib}`)
})
