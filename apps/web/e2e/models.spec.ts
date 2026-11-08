import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// A small model file in PSpice style, written for this test.
const LIBRARY = `* e2e models
.MODEL DE2E D(IS=2.5n RS=0.5 N=1.75 CJO=4p T_MEASURED=25)
.SUBCKT AMPE2E INP INN VCC VEE OUT
E1 OUT 0 VALUE={LIMIT(1e5*V(INP,INN), V(VEE), V(VCC))}
R1 INP INN 1meg
.ENDS
`

test('import SPICE models: wizard, part in the library, model copied into the project', async ({
  page,
  request,
}) => {
  const file = join(tmpdir(), 'bpt-e2e-models.lib')
  writeFileSync(file, LIBRARY)
  await request.delete('/api/library/libraries/bpt-e2e-models') // left by an earlier run
  const id = (await (await request.post('/api/projects', { data: { name: 'models' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)

  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /Import SPICE models/ }).click()
  await page.getByRole('dialog').getByRole('textbox', { name: 'Folder path' }).fill(file)
  await page.keyboard.press('Enter')

  const wizard = page.getByRole('dialog', { name: /Import SPICE models – bpt-e2e-models.lib/ })
  await expect(wizard).toContainText('2 models (pspice syntax')
  // The 5-pin subcircuit is recognised as an op-amp, its pins mapped by name.
  await expect(wizard.getByRole('combobox', { name: 'Symbol for AMPE2E' })).toHaveValue('bpt:opamp')
  await expect(wizard.getByRole('combobox', { name: 'AMPE2E pin VCC' })).toHaveValue('V+')
  await expect(wizard.getByRole('combobox', { name: 'Symbol for DE2E' })).toHaveValue('bpt:diode')
  await wizard.getByRole('button', { name: 'Import 2 models' }).click()
  await expect(page.getByText(/Library “bpt-e2e-models”: 2 parts/)).toBeVisible()

  await page.getByRole('textbox', { name: 'Search parts' }).fill('AMPE2E')
  await page.getByRole('button', { name: /^AMPE2E/ }).click()
  await page.mouse.click(600, 400)
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return Object.keys(doc.project.subcircuits ?? {})
    })
    .toEqual(['AMPE2E'])
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toContain('.subckt AMPE2E INP INN VCC VEE OUT')
  expect(netlist).toMatch(/^XU1 .* AMPE2E$/m)
  await request.delete('/api/library/libraries/bpt-e2e-models')
})

test('variants: an op-amp simulated as bandwidth-limited, with its model parameters', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'variant' } })).json()).id
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'root',
        instances: [
          { id: '01a00000-0000-7000-8000-0000000000a1', ref: 'U1', symbol: 'bpt:opamp_ideal', at: [0, 0] },
        ],
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate(() => window.__bpt?.toScreen([0, 0]) ?? [0, 0])
  await expect(async () => {
    await page.mouse.click(x, y)
    await expect(page.getByRole('combobox', { name: 'Variant' })).toBeVisible({ timeout: 500 })
  }).toPass()
  await page.getByRole('combobox', { name: 'Variant' }).selectOption('single-pole')
  await expect(page.getByRole('textbox', { name: 'gbw', exact: true })).toHaveAttribute(
    'placeholder',
    '1meg (model default)',
  )
  await page.getByRole('textbox', { name: 'gbw', exact: true }).fill('10meg')
  await page.keyboard.press('Enter')
  await expect
    .poll(async () => (await request.get(`/api/projects/${id}/export/netlist`)).text())
    .toMatch(/^XU1 .* OPAMP_1P gbw=10meg$/m)
})
