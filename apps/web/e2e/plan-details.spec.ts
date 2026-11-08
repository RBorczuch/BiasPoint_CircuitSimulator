/** Details of docs/projekt-elementy.md §4 beyond the paths of §5. */
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('§4.1 part row: duplicate, move to a library, where used, export', async ({ page, request }) => {
  for (const name of ['e2e-row', 'e2e-row2']) await request.delete(`/api/library/libraries/${name}`)
  await request.post('/api/components/from-template', {
    data: { template: 'mlcc', form: { Cnom: '2.2u' }, library: 'e2e-row', name: 'E2E225' },
  })
  const id = (await (await request.post('/api/projects', { data: { name: 'row' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const parts = async () => Object.keys(await (await request.get('/api/library/components')).json())
  const menu = async (name: string, item: string | RegExp) => {
    await page.getByRole('textbox', { name: 'Search parts' }).fill(name)
    await page.getByTestId(`part-${name}`).first().hover()
    await page
      .getByRole('button', { name: `Actions of ${name}` })
      .first()
      .click()
    await page.getByRole('menuitem', { name: item }).click()
  }

  await menu('E2E225', 'Duplicate…')
  await page.getByRole('dialog').getByRole('textbox').fill('E2E225-B')
  await page.keyboard.press('Enter')
  await expect.poll(parts).toContain('cmp:e2e-row/E2E225-B')

  await menu('E2E225-B', 'Move to a library…')
  await page.getByRole('dialog').getByRole('textbox').fill('e2e-row2')
  await page.keyboard.press('Enter')
  await expect.poll(parts).toContain('cmp:e2e-row2/E2E225-B')
  expect(await parts()).not.toContain('cmp:e2e-row/E2E225-B')

  await menu('E2E225', 'Where used')
  await expect(page.getByText('E2E225 is not used in the open or recent projects')).toBeVisible()

  const folder = mkdtempSync(join(tmpdir(), 'bpt-row-'))
  await menu('E2E225', 'Export (.bptlib)…')
  await page
    .getByRole('dialog')
    .getByRole('textbox', { name: 'Folder path' })
    .fill(join(folder, 'one.bptlib'))
  await page.keyboard.press('Enter')
  await expect(page.getByText(/E2E225 exported to/)).toBeVisible()
  expect(existsSync(join(folder, 'one.bptlib'))).toBe(true)
  for (const name of ['e2e-row', 'e2e-row2']) await request.delete(`/api/library/libraries/${name}`)
})

test('§4.1 New → Part from the selection, offered once parts are selected', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'sel' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'R1 a b 1k\nC1 b 0 1n' } })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await expect(page.getByRole('menuitem', { name: 'Part from the selection…' })).toBeDisabled()
  await page.keyboard.press('Escape')
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: 'Part from the selection…' }).click()
  await expect(page.getByRole('dialog').getByRole('textbox')).toBeVisible() // its name
})

test('§4.4 the project chooses IEC or ANSI; the inspector restores the built-in drawing', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'standard' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'R1 a 0 1k' } })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const r1 = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'R1')
  // A drawing chosen for the project's resistors (as the symbol editor's "this project" does).
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'transaction',
        label: 'drawing',
        commands: [
          { type: 'set_default_look', symbol: 'bpt:resistor', look: 'ansi' },
          { type: 'update_instance', sheet: 'root', id: r1.id, look: 'ansi' },
        ],
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)

  // Nothing selected: the project's settings, the symbol standard among them.
  const preview = page.getByTestId('part-Resistor').first().locator('svg').first()
  const iec = await preview.innerHTML()
  await page.getByLabel('Symbol standard of the project').selectOption('ansi')
  await expect.poll(async () => (await doc()).symbol_standard).toBe('ansi')
  await expect.poll(() => preview.innerHTML()).not.toBe(iec)

  await page.evaluate(() => window.__bpt?.fit())
  const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p) ?? [0, 0], r1.at as [number, number])
  await page.mouse.click(x, y)
  await page.getByRole('button', { name: 'Restore the built-in drawing here' }).click()
  await expect.poll(async () => (await doc()).default_looks).toEqual({})
  expect((await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'R1').look).toBeFalsy()
})

test('§4.2 part editor: save as a new part, save as a template', async ({ page, request }) => {
  await request.delete('/api/library/libraries/e2e-save')
  await request.post('/api/components/from-template', {
    data: { template: 'mlcc', form: { Cnom: '1u', esr: '10m' }, library: 'e2e-save', name: 'E2E1U' },
  })
  const id = (await (await request.post('/api/projects', { data: { name: 'save as' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const edit = async () => {
    await page.getByRole('textbox', { name: 'Search parts' }).fill('E2E1U')
    await page.getByTestId('part-E2E1U').hover()
    await page.getByRole('button', { name: 'Actions of E2E1U' }).click()
    await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
    const editor = page.getByTestId('component-wizard')
    await expect(editor.getByRole('textbox', { name: 'Part name' })).toHaveValue('E2E1U')
    return editor
  }

  let editor = await edit()
  await editor.getByRole('textbox', { name: 'ESR', exact: true }).fill('3m')
  await editor.getByRole('button', { name: 'More ways to save' }).click()
  await page.getByRole('menuitem', { name: 'Save as a new part…' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('E2E1U-LOW')
  await page.keyboard.press('Enter')
  const parts = async () => await (await request.get('/api/library/components')).json()
  await expect.poll(async () => (await parts())['cmp:e2e-save/E2E1U-LOW']?.template.values.esr).toBe('3m')
  const original = (await parts())['cmp:e2e-save/E2E1U']
  expect([original.version, original.template.values.esr]).toEqual([1, '10m'])

  editor = await edit()
  await editor.getByRole('button', { name: 'More ways to save' }).click()
  await page.getByRole('menuitem', { name: 'Save as a model…' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('E2E MLCC')
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Model E2E MLCC saved in “e2e-save”/)).toBeVisible()
  const templates = await (await request.get('/api/components/templates')).json()
  const made = templates.find((t: { name: string }) => t.name === 'tpl:e2e-save/E2E MLCC')
  expect(made.fields.find((f: { key: string }) => f.key === 'esr').default).toBe('10m')
  await request.delete('/api/library/libraries/e2e-save')
})

test('§4.2 usage: parts inside a module (K5), other projects, history of versions', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-use')
  const body = { template: 'mlcc', form: { Cnom: '1u' }, library: 'e2e-use', name: 'E2EUSE' }
  await request.post('/api/components/from-template', { data: body })
  await request.patch('/api/library/components', {
    data: { id: 'cmp:e2e-use/E2EUSE', metadata: { manufacturer: 'E2E' }, changes: 'maker added' },
  })
  // Placed in another open project.
  const other = (await (await request.post('/api/projects', { data: { name: 'e2e other' } })).json()).id
  await request.post(`/api/projects/${other}/circuit/components`, {
    data: { symbol: 'cmp:e2e-use/E2EUSE', nets: ['a', '0'] },
  })
  const id = (await (await request.post('/api/projects', { data: { name: 'usage' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const open = async (name: string, item: string) => {
    await page.getByRole('textbox', { name: 'Search parts' }).fill(name)
    await page.getByTestId(`part-${name}`).first().hover()
    await page
      .getByRole('button', { name: `Actions of ${name}` })
      .first()
      .click()
    await page.getByRole('menuitem', { name: item, exact: true }).click()
    const editor = page.getByTestId('component-wizard')
    await editor.getByRole('tab', { name: 'Usage' }).click()
    return editor
  }

  let editor = await open('E2EUSE', 'Edit')
  await expect(editor.getByTestId('part-elsewhere')).toContainText('e2e other: 1 placed · version 2')
  await expect(editor.getByTestId('part-history')).toContainText('v2')
  await expect(editor.getByTestId('part-history')).toContainText('maker added')
  await expect(editor.getByTestId('part-history')).toContainText('v1')
  await editor.getByRole('button', { name: 'Close' }).click()

  editor = await open('LM2596 step-down module', 'Edit a copy')
  const inside = editor.getByTestId('part-inside')
  await expect(inside).toContainText('LM2596 · version 1')
  await expect(inside).toContainText('SS34')
  await expect(inside).toContainText('33uH power inductor')
  await request.delete('/api/library/libraries/e2e-use')
})

test('§4.2 symbol page: a saved part drawn as a box, then like another symbol with its pins mapped', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-draw')
  await request.post('/api/components/from-template', {
    data: { template: 'capacitor', form: { Cnom: '1u' }, library: 'e2e-draw', name: 'E2EDRAW' },
  })
  const id = (await (await request.post('/api/projects', { data: { name: 'drawing' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('textbox', { name: 'Search parts' }).fill('E2EDRAW')
  await page.getByTestId('part-E2EDRAW').hover()
  await page.getByRole('button', { name: 'Actions of E2EDRAW' }).click()
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click()
  const editor = page.getByTestId('component-wizard')
  await editor.getByRole('tab', { name: 'Symbol' }).click()
  const top = async () =>
    (await (await request.get('/api/library/components')).json())['cmp:e2e-draw/E2EDRAW'].sheets[0].symbol

  await editor.getByLabel('Draw the part as').selectOption('box')
  await editor.getByRole('button', { name: 'Apply (a new version)' }).click()
  await expect.poll(top).toBeNull()

  await editor.getByLabel('Draw the part as').selectOption('bpt:diode')
  const pins = editor.getByTestId('part-redraw').getByRole('combobox', { name: /^Drawing pin/ })
  await expect(pins).toHaveCount(2)
  const first = await pins.nth(0).inputValue()
  const second = await pins.nth(1).inputValue()
  await pins.nth(0).selectOption(second) // swapped: each pin once again after the second change
  await expect(editor.getByText(/Each of the part.s pins once/)).toBeVisible()
  await pins.nth(1).selectOption(first)
  await editor.getByRole('button', { name: 'Apply (a new version)' }).click()
  await expect
    .poll(async () => (await top())?.pins.map((p: { number: string }) => p.number))
    .toEqual([second, first])
  await request.delete('/api/library/libraries/e2e-draw')
})

test('§4.2 part editor, SPICE model kind: a pasted .subckt checked, its pins mapped, saved with data', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-spice')
  const id = (await (await request.post('/api/projects', { data: { name: 'spice kind' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Part from a datasheet/ }).click()
  const editor = page.getByTestId('component-wizard')
  await editor.getByRole('button', { name: 'SPICE model' }).click()
  await editor
    .getByLabel('SPICE model text')
    .fill('.SUBCKT E2EAMP INP INN VCC VEE OUT\nE1 OUT 0 INP INN 1e5\nR1 INP INN 1meg\n.ENDS')
  await editor.getByRole('button', { name: 'Check the model' }).click()
  await expect(editor.getByLabel('Symbol of the part')).toHaveValue('bpt:opamp')
  await expect(editor.getByLabel('Model pin VCC')).not.toHaveValue('')
  await expect(editor.getByRole('textbox', { name: 'Part name' })).toHaveValue('E2EAMP')
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-spice')
  await editor.getByRole('tab', { name: 'Data' }).click()
  await editor.getByRole('textbox', { name: 'Manufacturer' }).fill('E2E Semi')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByText('E2EAMP saved in library “e2e-spice”')).toBeVisible()
  const part = (await (await request.get('/api/library/components')).json())['cmp:e2e-spice/E2EAMP']
  expect(part.metadata.manufacturer).toBe('E2E Semi')
  await request.delete('/api/library/libraries/e2e-spice')
})
