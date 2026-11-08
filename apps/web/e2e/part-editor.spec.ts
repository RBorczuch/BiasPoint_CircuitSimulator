import { expect, test } from '@playwright/test'

test('edit a library part: new version with data, placed parts updated; a standard part copied', async ({
  page,
  request,
}) => {
  // A part of the user's library, placed in a project.
  await request.delete('/api/library/libraries/e2e-edit')
  await request.post('/api/components/from-template', {
    data: { template: 'mlcc', form: { Cnom: '1u', esr: '10m' }, library: 'e2e-edit', name: 'E2EMLCC' },
  })
  const id = (await (await request.post('/api/projects', { data: { name: 'edit part' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('textbox', { name: 'Search parts' }).fill('E2EMLCC')
  await page
    .getByRole('button', { name: /^E2EMLCC/ })
    .first()
    .click()
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 400, y: 300 } })
  await page.keyboard.press('Escape')
  const placed = async () =>
    (await (await request.get(`/api/projects/${id}/components`)).json()) as {
      version: number
      used: number
    }[]
  await expect.poll(async () => (await placed())[0]?.used).toBe(1)

  // Ś6: row → Edit → change → data → save → update the placed one.
  await page.getByTestId('part-E2EMLCC').hover()
  await page.getByRole('button', { name: 'Actions of E2EMLCC' }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('component-wizard')
  await expect(editor.getByRole('textbox', { name: 'Part name' })).toHaveValue('E2EMLCC')
  await expect(editor.getByRole('textbox', { name: 'C', exact: true })).toHaveValue('1u')
  await editor.getByRole('textbox', { name: 'ESR', exact: true }).fill('5m')
  await editor.getByRole('tab', { name: 'Data' }).click()
  await expect(editor.getByLabel('Category')).toBeVisible()
  await editor.getByRole('textbox', { name: 'Manufacturer' }).fill('E2E Ceramics')
  await editor.getByRole('combobox', { name: 'Dielectric' }).fill('X7R')
  await editor.getByRole('tab', { name: 'Usage' }).click()
  await editor.getByRole('textbox', { name: 'What changes' }).fill('lower ESR')
  await editor.getByRole('button', { name: /^Save version 2$/ }).click()
  await page.getByRole('button', { name: 'Update them' }).click()
  await expect.poll(async () => (await placed())[0]?.version).toBe(2)
  const parts = await (await request.get('/api/library/components')).json()
  const saved = parts['cmp:e2e-edit/E2EMLCC']
  expect(saved.metadata).toMatchObject({ manufacturer: 'E2E Ceramics', dielectric: 'X7R' })
  expect(saved.template.values.esr).toBe('5m')
  expect(saved.changes).toBe('lower ESR')

  // Ś7: a standard part is edited as a copy in the user's library.
  await page.getByRole('textbox', { name: 'Search parts' }).fill('TL072')
  await page.getByTestId('part-TL072').first().hover() // the standard part comes first
  await page.getByRole('button', { name: 'Actions of TL072' }).first().click()
  await page.getByRole('menuitem', { name: 'Edit a copy' }).click()
  await expect(editor.getByText('Copy of a standard part')).toBeVisible()
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-edit')
  await editor.getByRole('textbox', { name: 'Vos', exact: true }).fill('1m')
  await editor.getByRole('button', { name: 'Save a copy in my library' }).click()
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/library/components')).json())['cmp:e2e-edit/TL072']?.template.values
          .vos,
    )
    .toBe('1m')
  await request.delete('/api/library/libraries/e2e-edit')
})
