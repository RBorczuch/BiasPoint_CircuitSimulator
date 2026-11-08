import { expect, test } from '@playwright/test'

test('a model changed in its circuit (a new version) and a new model started from one', async ({
  page,
  request,
}) => {
  const lib = 'e2e-models'
  await request.delete(`/api/library/libraries/${lib}`)
  const id = (await (await request.post('/api/projects', { data: { name: 'models' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)

  // From the part editor: a new model from the electrolytic's circuit, with the values typed.
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('electrolytic')
  await wizard.getByRole('textbox', { name: 'C', exact: true }).fill('470u')
  await expect(wizard.getByTestId('template-circuit')).toContainText('470 µF')
  await expect(wizard.getByRole('button', { name: 'Edit this circuit' })).toHaveCount(0) // built in
  await wizard.getByRole('button', { name: 'New model from this circuit' }).click()

  const editor = page.getByTestId('template-editor')
  await expect(page.getByTestId('model-editing')).toHaveText('New model based on Electrolytic / tantalum')
  // The sheet to change is in front (not under the part editor), and opening it is no news.
  await expect(wizard).toBeHidden()
  await expect(page.getByText('Changed by another client')).toHaveCount(0)
  await expect(editor.getByRole('textbox', { name: 'Model name' })).toHaveValue(
    'Electrolytic / tantalum (copy)',
  )
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const copy = (await doc()).sheets.find((s: { name: string }) => s.name.startsWith('Electrolytic'))
  expect(copy.parameters.Cnom).toBe('470u') // the typed value is the new model's default
  await editor.getByRole('textbox', { name: 'Model name' }).fill('Low-ESR can')
  await editor.getByRole('textbox', { name: 'Model library' }).fill(lib)
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save model' }).click()
  await expect(page.getByText(`Model Low-ESR can saved in “${lib}” (version 1)`)).toBeVisible()
  // (the message sits over the panel's buttons until it goes; it waits while the mouse is on it)
  await page.mouse.move(10, 300)
  await expect(page.getByText(`Model Low-ESR can saved in “${lib}” (version 1)`)).toBeHidden({
    timeout: 15_000,
  })
  // The editor now edits the saved template: its next save is version 2.
  await expect(page.getByTestId('model-editing')).toHaveText('Editing model: Low-ESR can (version 1)')
  // Saved again unchanged: the version stays.
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText('Nothing changed since version 1')).toBeVisible()
  // A change of the circuit (its ESL's default), then a new version with what changed.
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_parameter', sheet: copy.name, name: 'esl', value: '20n' } },
  })
  await page.mouse.move(10, 300)
  await expect(page.getByText('Nothing changed since version 1')).toBeHidden({ timeout: 15_000 })
  await editor.getByRole('textbox', { name: 'What changed' }).fill('ESL of the snap-in can')
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save as version 2' }).click()
  await expect(page.getByText(`Model Low-ESR can saved in “${lib}” (version 2)`)).toBeVisible()
  await page.mouse.move(10, 300)
  await expect(page.getByText(`Model Low-ESR can saved in “${lib}” (version 2)`)).toBeHidden({
    timeout: 15_000,
  })

  // A new template under a taken name is refused, not written over the other.
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save as a new model…' }).click()
  await expect(editor.getByRole('textbox', { name: 'Model name' })).toHaveValue('Low-ESR can (copy)')
  await editor.getByRole('textbox', { name: 'Model name' }).fill('Low-ESR can')
  await expect(page.getByTestId('model-bar').getByRole('button', { name: 'Save as version 3' })).toHaveCount(
    0,
  )
  await page
    .getByTestId('model-bar')
    .getByRole('button', { name: /^Save (model|as a new model)$/ })
    .click()
  await expect(page.getByText(`“${lib}” has a model Low-ESR can already`)).toBeVisible()

  // The user's own template, from the part editor again: changed in place.
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption(`tpl:${lib}/Low-ESR can`)
  await wizard.getByRole('button', { name: 'Edit this circuit' }).click()
  await expect(page.getByTestId('model-editing')).toHaveText('Editing model: Low-ESR can (version 2)')
  const saved = await (await request.get('/api/components/templates')).json()
  const mine = saved.find((t: { name: string }) => t.name === `tpl:${lib}/Low-ESR can`)
  expect(mine.version).toBe(2)
  await request.delete(`/api/library/libraries/${lib}`)
})

test('a new model from the part editor: there and back, the part keeps its points', async ({
  page,
  request,
}) => {
  const lib = 'e2e-models-back'
  await request.delete(`/api/library/libraries/${lib}`)
  const id = (await (await request.post('/api/projects', { data: { name: 'back' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('capacitor')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  const points = wizard.getByRole('textbox', { name: 'Points |Z|(f)' })
  await points.fill('1k 16\n100k 0.16')
  await wizard.getByRole('button', { name: 'New model from this circuit' }).click()

  // The bar says what is edited and has the way back; one list of parameters in the panel.
  const bar = page.getByTestId('model-bar')
  await expect(page.getByTestId('model-editing')).toHaveText('New model based on Capacitor')
  await expect(bar.getByRole('button', { name: 'Use it in the part' })).toHaveCount(0) // nothing saved
  const editor = page.getByTestId('template-editor')
  await expect(editor.getByRole('textbox', { name: 'Label of Cnom' })).toBeVisible()
  await expect(editor.getByRole('tab', { name: 'Form' })).toHaveCount(0)
  await editor.getByRole('textbox', { name: 'Model name' }).fill('My cap')
  await editor.getByRole('textbox', { name: 'Model library' }).fill(lib)
  await bar.getByRole('button', { name: 'Save model' }).click()
  await expect(page.getByTestId('model-editing')).toHaveText('Editing model: My cap (version 1)')

  await bar.getByRole('button', { name: 'Use it in the part' }).click()
  await expect(wizard.getByRole('combobox', { name: 'Model' })).toHaveValue(`tpl:${lib}/My cap`)
  await expect(wizard.getByRole('textbox', { name: 'Points |Z|(f)' })).toHaveValue('1k 16\n100k 0.16')
  await expect(bar).toHaveCount(0) // the part editor in front: no bar over it

  // Back at the sheet the bar returns. Close ends the editing; the saved model's sheet goes.
  await page.getByRole('tab', { name: 'Schematic', exact: true }).click()
  await expect(bar).toBeVisible()
  const sheets = async (): Promise<string[]> =>
    (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets.map(
      (s: { name: string }) => s.name,
    )
  await bar.getByRole('button', { name: 'Close' }).click()
  await expect(bar).toHaveCount(0)
  await expect.poll(sheets).toEqual(['root'])

  // Changed and not saved: the sheet stays, and says so.
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption(`tpl:${lib}/My cap`)
  await wizard.getByRole('button', { name: 'Edit this circuit' }).click()
  await expect(page.getByTestId('model-editing')).toHaveText('Editing model: My cap (version 1)')
  const [edited] = (await sheets()).filter((name) => name !== 'root')
  await page.getByTestId('template-editor').getByRole('textbox', { name: 'Default of Cnom' }).fill('22u')
  await page.getByTestId('template-editor').getByRole('textbox', { name: 'Default of Cnom' }).press('Enter')
  await expect
    .poll(
      async () =>
        (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets.find(
          (s: { name: string }) => s.name === edited,
        ).parameters.Cnom,
    )
    .toBe('22u')
  await bar.getByRole('button', { name: 'Close' }).click()
  await expect(page.getByText('The model has unsaved changes')).toBeVisible()
  expect(await sheets()).toContain(edited)
  await request.delete(`/api/library/libraries/${lib}`)
})
