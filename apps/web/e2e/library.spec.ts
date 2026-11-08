import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

// A tiny library in the KiCad format, written for this test.
const LIBRARY = `(kicad_symbol_lib (version 20241209) (generator "test")
  (symbol "TESTRES" (pin_numbers (hide yes)) (pin_names (offset 0))
    (property "Reference" "R" (at 2.032 0 90) (effects (font (size 1.27 1.27))))
    (property "Value" "2k2" (at 0 0 90) (effects (font (size 1.27 1.27))))
    (property "Description" "Resistor for the e2e test" (at 0 0 0) (effects (hide yes)))
    (symbol "TESTRES_0_1"
      (rectangle (start -1.016 -2.54) (end 1.016 2.54) (stroke (width 0.254)) (fill (type none))))
    (symbol "TESTRES_1_1"
      (pin passive line (at 0 3.81 270) (length 1.27) (name "~") (number "1"))
      (pin passive line (at 0 -3.81 90) (length 1.27) (name "~") (number "2")))))
`

test('import KiCad symbols, place one: the project keeps a copy (one undo step)', async ({
  page,
  request,
}) => {
  const file = join(tmpdir(), 'bpt-e2e.kicad_sym') // same name: a new import replaces the library
  writeFileSync(file, LIBRARY)
  const id = (await (await request.post('/api/projects', { data: { name: 'kicad' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)

  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Import KiCad symbols/ }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Import KiCad symbols')).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Folder path' }).fill(file)
  await page.keyboard.press('Enter')
  await expect(page.getByText('Library “bpt-e2e”: 1 symbols')).toBeVisible()

  // Imported libraries are folded; a search finds their symbols (also by description).
  await page.getByRole('textbox', { name: 'Search parts' }).fill('e2e test')
  await page
    .getByRole('button', { name: /TESTRES/ })
    .first()
    .click()
  await page.mouse.click(600, 400)
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return Object.keys(doc.project.symbols ?? {})
    })
    .toEqual(['kicad:bpt-e2e/TESTRES'])
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^R1 .* 2.2k$/m)

  // Right after the edit (the page may not have its answer yet): one step undoes both.
  await page.keyboard.press('Control+z')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return [doc.project.sheets[0].instances.length, Object.keys(doc.project.symbols ?? {}).length]
    })
    .toEqual([0, 0])
  await request.delete('/api/library/libraries/bpt-e2e')
})
