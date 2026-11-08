import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('export a library as a .bptlib package and import it again', async ({ page, request }) => {
  const symbols = await (await request.get('/api/library/symbols')).json()
  const resistor = symbols.find((s: { id: string }) => s.id === 'bpt:resistor')
  const symbol = { ...resistor, id: 'user:e2e-pack/RP', name: 'RP', looks: [] }
  await request.post('/api/library/symbols', { data: { library: 'e2e-pack', symbol } })
  const folder = mkdtempSync(join(tmpdir(), 'bpt-e2e-pack-'))
  const id = (await (await request.post('/api/projects', { data: { name: 'pack' } })).json()).id
  await page.goto(`/?project=${id}`)

  await page.getByRole('button', { name: 'Show by library' }).click()
  const group = page.getByTestId('library-group-lib:e2e-pack')
  await group.hover()
  await group.getByRole('button', { name: 'Export library e2e-pack' }).click()
  const dialog = page.getByRole('dialog', { name: 'Export library package' })
  await dialog.getByRole('textbox', { name: 'Folder path' }).fill(join(folder, 'shared.bptlib'))
  await page.keyboard.press('Enter')
  await expect(page.getByText(/Library “e2e-pack” exported/)).toBeVisible()
  expect(existsSync(join(folder, 'shared.bptlib'))).toBe(true)

  // Imported again: replaces the library of the same name (one part).
  await request.delete('/api/library/libraries/e2e-pack')
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /Import library package/ }).click()
  await page.getByRole('textbox', { name: 'Folder path' }).fill(join(folder, 'shared.bptlib'))
  await page.keyboard.press('Enter')
  await expect(page.getByText('Library “e2e-pack”: 1 parts')).toBeVisible()
  await request.delete('/api/library/libraries/e2e-pack')
})
