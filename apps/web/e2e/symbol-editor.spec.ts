import { expect, test } from '@playwright/test'

test('symbol editor: quick box with a SPICE mapping, saved to a library, placed and simulated', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'symbol-editor' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)

  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Draw a symbol/ }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  await expect(editor).toBeVisible()
  await expect(editor.getByText('draw something')).toBeVisible()
  await editor.getByRole('textbox', { name: 'Symbol name' }).fill('E2ERES')
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-symbols')
  await editor.getByRole('textbox', { name: 'Reference prefix' }).fill('R')

  await editor.getByRole('button', { name: 'Quick box' }).click()
  await page.getByRole('dialog', { name: 'Quick box' }).getByRole('textbox').fill('A, B')
  await page.keyboard.press('Enter')
  await expect(editor.getByText('Pins (2)')).toBeVisible()

  // A pin drawn with the pin tool gets the next number and can be removed again.
  await editor.getByRole('button', { name: 'Pin', exact: true }).click()
  const canvas = editor.getByRole('application', { name: 'Symbol canvas' })
  const box = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height * 0.9)
  await expect(editor.getByText('Pins (3)')).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Pin 3 number' })).toHaveValue('3')
  await editor.getByRole('button', { name: 'Delete item' }).click()
  await expect(editor.getByText('Pins (2)')).toBeVisible()

  await editor.getByRole('combobox', { name: 'SPICE element' }).selectOption('R')
  await expect(editor.getByRole('textbox', { name: 'SPICE pin order' })).toHaveValue('1 2')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByText('Saved E2ERES in library “e2e-symbols”')).toBeVisible()
  await expect(editor).toBeHidden()

  await page.getByRole('textbox', { name: 'Search parts' }).fill('E2ERES')
  await page.getByRole('button', { name: /^E2ERES/ }).click()
  await page.mouse.click(600, 400)
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return Object.keys(doc.project.symbols ?? {})
    })
    .toEqual(['user:e2e-symbols/E2ERES'])
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^R1 \S+ \S+ 1k$/m)
  await request.delete('/api/library/libraries/e2e-symbols')
})
