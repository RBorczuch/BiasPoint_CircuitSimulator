import { expect, test } from '@playwright/test'

test('a device from equations: what is wrong is listed, a good one becomes a sheet with its pins', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'edd' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Device from equations/ }).click()
  const dialog = page.getByTestId('equation-device')
  await dialog.getByLabel('Device name').fill('Varactor')
  // A charge of the other branch's voltage: ngspice would ignore it, so it is refused.
  await dialog.getByRole('button', { name: 'Branch', exact: true }).click()
  await dialog.getByLabel('Current of branch 2').fill('V2/r')
  await dialog.getByLabel('Charge of branch 2').fill('cj*V1')
  await dialog.getByRole('button', { name: 'Make the device' }).click()
  const problems = dialog.getByTestId('equation-problems')
  await expect(problems).toContainText('branch 2 charge: only V2')
  await expect(problems).toContainText('unknown name “r”')
  await dialog.getByRole('button', { name: 'Remove branch 2' }).click()
  await dialog.getByRole('button', { name: 'Make the device' }).click()
  await expect(dialog).toHaveCount(0)
  const doc = (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const sheet = doc.sheets.find((s: { name: string }) => s.name === 'Varactor')
  expect(sheet.port_order).toEqual(['P1', 'REF'])
  expect(sheet.parameters).toMatchObject({ is: '1e-14', cj: '1n' })
})
