import { join, resolve } from 'node:path'
import { expect, test } from '@playwright/test'

const FIXTURES = resolve('../../backend/tests/fixtures/kicad') // tests run from apps/web

test('import a hierarchical KiCad schematic as a new project', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'before' } })).json()).id
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 0')
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /Import KiCad schematic/ }).click()
  await page.getByRole('textbox', { name: 'Folder path' }).fill(join(FIXTURES, 'hier', 'top.kicad_sch'))
  await page.keyboard.press('Enter')
  await expect(page.getByText('Imported top')).toBeVisible()
  await expect(page.getByRole('tab', { name: 'divider' })).toBeVisible()
  const projects = await (await request.get('/api/projects')).json()
  const top = projects.find((p: { name: string }) => p.name === 'top')
  const netlist = await (await request.get(`/api/projects/${top.id}/export/netlist`)).text()
  expect(netlist).toContain('X1 n002 sheet_divider')
  await page.screenshot({ path: 'test-results/kicad-import.png' })
})
