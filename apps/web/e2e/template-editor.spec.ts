import { expect, test } from '@playwright/test'

test('draw a parametric template: pins, parameters dragged onto parts, form, symbol, saved and offered', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-tpl')
  const id = (await (await request.post('/api/projects', { data: { name: 'tpl' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await expect(page.locator('footer')).toContainText(/rev [0-9]/)

  // Ś5: New → Draw a template: a sheet with two pins and the template editor beside it.
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Draw a model/ }).click()
  const editor = page.getByTestId('template-editor')
  await expect(editor.getByRole('textbox', { name: 'Pin 1' })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Pin 2' })).toBeVisible()

  // The circuit (drawn as on any sheet): R1 and C1 in series between the pins.
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'Model',
        instances: [
          { ref: 'R1', symbol: 'bpt:resistor', at: [762, 0], rot: 90 },
          { ref: 'C1', symbol: 'bpt:capacitor', at: [1778, 0], rot: 90 },
        ],
        wires: [
          {
            points: [
              [0, 0],
              [381, 0],
            ],
          },
          {
            points: [
              [1143, 0],
              [1397, 0],
            ],
          },
          {
            points: [
              [2159, 0],
              [2540, 0],
            ],
          },
        ],
      },
    },
  })
  await page.evaluate(() => window.__bpt?.fit())

  // Parameters: added here, dragged onto the parts' values.
  for (const [name, value] of [
    ['Rs', '50m'],
    ['Cs', '10u'],
  ]) {
    await editor.getByRole('textbox', { name: 'New parameter name' }).fill(name)
    await editor.getByRole('textbox', { name: 'New parameter value' }).fill(value)
    await editor.getByRole('button', { name: 'Add parameter' }).click()
  }
  await expect(editor.getByText('not used yet: drag it onto a part')).toHaveCount(2)
  const canvas = page.getByTestId('schematic')
  const r1 = await page.evaluate(() => window.__bpt?.toScreen([762, 0]) ?? [0, 0])
  const c1 = await page.evaluate(() => window.__bpt?.toScreen([1778, 0]) ?? [0, 0])
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no canvas')
  await editor.getByRole('button', { name: 'Drag parameter Rs onto a part' }).dragTo(canvas, {
    targetPosition: { x: r1[0] - box.x, y: r1[1] - box.y },
  })
  await editor.getByRole('button', { name: 'Drag parameter Cs onto a part' }).dragTo(canvas, {
    targetPosition: { x: c1[0] - box.x, y: c1[1] - box.y },
  })
  await expect(editor.getByText('used by R1')).toBeVisible()
  await expect(editor.getByText('used by C1')).toBeVisible()

  // Form: units and labels; symbol: drawn like a capacitor; a look at the curves.
  await editor.getByRole('textbox', { name: 'Unit of Cs' }).fill('F')
  await editor.getByRole('textbox', { name: 'Label of Cs' }).fill('C')
  await editor.getByRole('textbox', { name: 'Unit of Rs' }).fill('Ω')
  await editor.getByRole('textbox', { name: 'Unit of Rs' }).blur()
  // Range, group and order of the fields (§4.3): C first, at least 1 nF.
  await editor.getByRole('button', { name: 'More of Cs' }).click()
  await editor.getByRole('textbox', { name: 'Minimum of Cs' }).fill('1n')
  await editor.getByRole('textbox', { name: 'Group of Cs' }).fill('Main')
  await editor.getByRole('textbox', { name: 'Group of Cs' }).blur()
  await editor.getByRole('button', { name: 'Move Cs up' }).click()
  await editor.getByRole('tab', { name: 'Symbol' }).click()
  await editor.getByRole('button', { name: 'Like the Capacitor' }).click()
  await editor.getByRole('tab', { name: 'Preview' }).click()
  await expect(editor.getByTestId('template-preview')).toBeVisible()

  await editor.getByRole('textbox', { name: 'Model name' }).fill('E2E RC cap')
  await editor.getByRole('textbox', { name: 'Model library' }).fill('e2e-tpl')
  await editor.getByLabel('Model kind').selectOption('capacitor')
  await page.getByTestId('model-bar').getByRole('button', { name: 'Save model' }).click()
  await expect(page.getByText(/Model E2E RC cap saved in “e2e-tpl”/)).toBeVisible()
  const templates = await (await request.get('/api/components/templates')).json()
  const saved = templates.find((t: { name: string }) => t.name === 'tpl:e2e-tpl/E2E RC cap')
  expect(saved.category).toBe('Capacitors')
  expect(
    saved.fields.map((f: { key: string; unit: string; minimum: string; group: string }) => [
      f.key,
      f.unit,
      f.minimum,
      f.group,
    ]),
  ).toEqual([
    ['Cs', 'F', '1n', 'Main'],
    ['Rs', 'Ω', '', ''],
  ])

  // Offered in its category: a part from it.
  await expect(page.getByTestId('template-E2E RC cap')).toBeVisible()
  await request.delete('/api/library/libraries/e2e-tpl')
})

test('a built-in template opens as a copy to change', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'tpl copy' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByTestId('template-Capacitor').hover()
  await page.getByRole('button', { name: 'Edit model Capacitor' }).click()
  const editor = page.getByTestId('template-editor')
  await expect(editor.getByRole('textbox', { name: 'Model name' })).toHaveValue('Capacitor (copy)')
  await expect(editor.getByRole('button', { name: 'Drag parameter Cnom onto a part' })).toBeVisible()
  await expect(editor.getByRole('textbox', { name: 'Unit of Cnom' })).toHaveValue('F')
})
