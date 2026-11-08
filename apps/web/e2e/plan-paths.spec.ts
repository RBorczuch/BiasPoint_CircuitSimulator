/**
 * The paths of docs/projekt-elementy.md §5 not covered by their own specs, each in no more steps
 * than the plan's "Po" column (the step count is in each title).
 */
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, type Page, test } from '@playwright/test'

async function open(page: Page, request: import('@playwright/test').APIRequestContext, netlist = '') {
  const id = (await (await request.post('/api/projects', { data: { name: 'paths' } })).json()).id
  if (netlist) await request.post(`/api/projects/${id}/circuit/import`, { data: { text: netlist } })
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  if (netlist) await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  return { id, doc }
}

test('Ś1 (3 steps): an ideal 4.7 kΩ resistor placed', async ({ page, request }) => {
  const { doc } = await open(page, request)
  await page.getByTestId('part-Resistor').first().click() // 1
  await page.mouse.click(600, 400) // 2
  await page.keyboard.press('Escape')
  await page.getByRole('textbox', { name: 'R', exact: true }).fill('4k7') // 3
  await page.keyboard.press('Enter')
  await expect
    .poll(async () =>
      (await doc()).sheets[0].instances.map((i: { model: { params: object } }) => i.model.params),
    )
    .toEqual([{ R: '4k7' }])
})

test('Ś3 (2 steps): a library capacitor dropped on an ideal one takes its place', async ({
  page,
  request,
}) => {
  const { doc } = await open(page, request, 'V1 in 0 1\nC1 in 0 100n')
  await page.evaluate(() => window.__bpt?.fit())
  const before = (await doc()).sheets[0].instances.length
  const c1 = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'C1')
  const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p) ?? [0, 0], c1.at as [number, number])
  const canvas = page.getByTestId('schematic')
  const box = await canvas.boundingBox()
  if (!box) throw new Error('no schematic')
  await page.getByRole('textbox', { name: 'Search parts' }).fill('CL10B104') // 1: find it
  await page
    .getByRole('button', { name: /^CL10B104KB85PNC/ })
    .first()
    .dragTo(canvas, { targetPosition: { x: x - box.x, y: y - box.y } }) // 2: drop it on C1
  await expect
    .poll(async () => (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'C1').symbol)
    .toMatch(/^(cmp:|sheet:)/)
  expect((await doc()).sheets[0].instances).toHaveLength(before) // replaced, not added
})

test('Ś4 (7 steps): a new MLCC from its category, with the manufacturer data', async ({ page, request }) => {
  await request.delete('/api/library/libraries/e2e-paths')
  await open(page, request)
  await page
    .getByTestId('library-group-Capacitors/Ceramic')
    .getByRole('button', { name: /^Ceramic/ })
    .click() // 1
  await page.getByTestId('template-MLCC class 2 (DC bias)').getByRole('button', { name: /^New:/ }).click() // 2
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('textbox', { name: 'C', exact: true }).fill('4.7u') // 3: values
  await wizard.getByRole('textbox', { name: 'Part name' }).fill('E2E475')
  await wizard.getByRole('textbox', { name: 'Library' }).fill('e2e-paths')
  await wizard.getByRole('tab', { name: 'Data' }).click() // 4
  await wizard.getByRole('textbox', { name: 'Manufacturer' }).fill('E2E Ceramics') // 5
  await wizard.getByRole('textbox', { name: 'Part number' }).fill('E2E475K') // 6
  await wizard.getByRole('button', { name: /^Save/ }).first().click() // 7
  await expect
    .poll(
      async () =>
        (await (await request.get('/api/library/components')).json())['cmp:e2e-paths/E2E475']?.metadata,
    )
    .toMatchObject({ manufacturer: 'E2E Ceramics', part_number: 'E2E475K' })
  const symbols = await (await request.get('/api/library/symbols')).json()
  expect(symbols.find((s: { id: string }) => s.id === 'cmp:e2e-paths/E2E475').group).toBe(
    'Capacitors/Ceramic',
  )
  await request.delete('/api/library/libraries/e2e-paths')
})

test('Ś10 (7 steps): a part from a manufacturer SPICE model, with its data', async ({ page, request }) => {
  const file = join(tmpdir(), 'bpt-e2e-paths.lib')
  writeFileSync(
    file,
    '* e2e\n.SUBCKT OPE2E INP INN VCC VEE OUT\nE1 OUT 0 INP INN 1e5\nR1 INP INN 1meg\n.ENDS\n',
  )
  await request.delete('/api/library/libraries/bpt-e2e-paths')
  await open(page, request)
  await page.getByRole('button', { name: 'New part' }).click() // 1
  await page.getByRole('menuitem', { name: 'Part from a SPICE model…' }).click() // 2
  const path = page.getByRole('dialog').getByRole('textbox', { name: 'Folder path' })
  await expect(path).not.toHaveValue('') // the dialog has put its start folder in
  await path.fill(file) // 3
  await page.keyboard.press('Enter')
  const wizard = page.getByRole('dialog', { name: /Import SPICE models/ })
  await expect(wizard.getByRole('combobox', { name: 'Symbol for OPE2E' })).toHaveValue('bpt:opamp') // 4: proposed
  await wizard.getByRole('button', { name: /^Import 1 model/ }).click() // 5
  await page.getByRole('button', { name: 'Add its data' }).click() // 6
  const editor = page.getByTestId('component-wizard')
  await expect(editor.getByRole('textbox', { name: 'Part name' })).toHaveValue('OPE2E') // loaded
  await editor.getByRole('textbox', { name: 'Manufacturer' }).fill('E2E Semi')
  await editor.getByRole('button', { name: /^Save/ }).first().click() // 7
  await expect(page.getByText('OPE2E saved (version 2)')).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => {
      const parts = await (await request.get('/api/library/components')).json()
      return Object.values(
        parts as Record<string, { id: string; name: string; metadata: Record<string, string> }>,
      )
        .filter((p) => p.name === 'OPE2E')
        .map((p) => [p.id, p.metadata.manufacturer ?? ''])
    })
    .toEqual([['cmp:bpt-e2e-paths/OPE2E', 'E2E Semi']])
  const symbols = await (await request.get('/api/library/symbols')).json()
  expect(
    symbols.find((s: { name: string; id: string }) => s.id.startsWith('cmp:') && s.name === 'OPE2E').group,
  ).toBe('Analog ICs/Op-amps')
  await request.delete('/api/library/libraries/bpt-e2e-paths')
})

test('Ś11 (6 steps): a faster variant added to a part in its editor', async ({ page, request }) => {
  await request.delete('/api/library/libraries/e2e-variant')
  await request.post('/api/components/from-template', {
    data: { template: 'electrolytic', form: { Cnom: '100u' }, library: 'e2e-variant', name: 'E2E100U' },
  })
  const { id } = await open(page, request)
  // The faster model: a sheet of the project with the same two pins.
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'add_sheet', sheet: { name: 'ideal', parameters: {} } } },
  })
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'C1 1 2 100u', sheet: 'ideal' } })
  const doc = (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const sheet = doc.sheets.find((s: { name: string }) => s.name === 'ideal')
  const ports = sheet.labels
    .filter((l: { text: string }) => ['1', '2'].includes(l.text))
    .map((l: { text: string; at: number[] }) => ({ kind: 'port', text: l.text, at: l.at }))
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'add_objects', sheet: 'ideal', labels: ports } },
  })

  await page.getByRole('textbox', { name: 'Search parts' }).fill('E2E100U')
  await page.getByTestId('part-E2E100U').hover()
  await page.getByRole('button', { name: 'Actions of E2E100U' }).click() // 1
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click() // 2
  const editor = page.getByTestId('component-wizard')
  await editor.getByRole('tab', { name: 'Usage' }).click() // 3
  await editor.getByLabel('Variant sheet').selectOption('ideal') // 4
  await editor.getByLabel('Variant label').fill('Ideal C') // 5
  await editor.getByRole('checkbox', { name: /faster/ }).check()
  await editor.getByRole('button', { name: 'Add variant' }).click() // 6
  await expect
    .poll(async () => {
      const part = (await (await request.get('/api/library/components')).json())['cmp:e2e-variant/E2E100U']
      return part.sheets[0].variants?.map((v: { label: string; faster: boolean }) => [v.label, v.faster])
    })
    .toEqual([['Ideal C', true]])
  await request.delete('/api/library/libraries/e2e-variant')
})
