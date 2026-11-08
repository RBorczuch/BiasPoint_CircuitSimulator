import { expect, test } from '@playwright/test'

test('Ctrl+K finds parts, nets and sheets and goes there', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'search' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 vin 0 DC 1\nR1 vin vout 4k7\nR2 vout 0 10k' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'add_sheet', sheet: { name: 'notes' } } },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)

  // A part by its value: selected and shown.
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Command, part, net, signal, sheet…').fill('4k7')
  await page.getByRole('option', { name: /R1 Resistor · 4k7/ }).click()
  await expect(page.getByText('1 selected')).toBeVisible()

  // A net: highlighted.
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Command, part, net, signal, sheet…').fill('vout')
  await page.getByRole('group', { name: 'Nets' }).getByRole('option', { name: /vout/ }).click()
  await expect(page.getByText('Net root/vout highlighted')).toBeVisible()

  // A sheet: shown.
  await page.keyboard.press('Control+k')
  await page.getByPlaceholder('Command, part, net, signal, sheet…').fill('notes')
  await page.getByRole('option', { name: 'notes' }).click()
  await expect(page.getByRole('tab', { name: 'notes' })).toHaveAttribute('aria-selected', 'true')
})
