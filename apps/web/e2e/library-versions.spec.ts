import { type APIRequestContext, expect, test } from '@playwright/test'

const ID = 'user:e2e-versions/RV'

async function saveSymbol(request: APIRequestContext, r: string, changes: string) {
  const symbols = await (await request.get('/api/library/symbols')).json()
  const resistor = symbols.find((s: { id: string }) => s.id === 'bpt:resistor')
  const symbol = { ...resistor, id: ID, name: 'RV', default_params: { R: r }, changes, looks: [] }
  const saved = await request.post('/api/library/symbols', { data: { library: 'e2e-versions', symbol } })
  expect(saved.ok()).toBe(true)
  return saved.json()
}

test('library part versions: update a copy on request, linked parts follow the library', async ({
  page,
  request,
}) => {
  const v1 = await saveSymbol(request, '1k', '')
  const id = (await (await request.post('/api/projects', { data: { name: 'versions' } })).json()).id
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'transaction',
        commands: [
          { type: 'set_symbol', id: ID, symbol: v1 },
          { type: 'add_objects', sheet: 'root', instances: [{ ref: 'R?', symbol: ID, at: [0, 0] }] },
        ],
      },
    },
  })
  await saveSymbol(request, '2k2', 'default 2k2')

  await page.goto(`/?project=${id}`)
  await page.getByRole('tab', { name: 'Project' }).click()
  const list = page.getByRole('list', { name: 'Library parts' })
  await expect(list).toContainText('v1 → v2 in the library')
  await list.getByRole('button', { name: 'Update RV' }).click()
  await expect(list).toContainText('v2')
  await expect(list).not.toContainText('→')

  // Linked: a new library version is taken over by itself when the project loads.
  await list.getByRole('button', { name: 'Link RV' }).click()
  await expect(list.getByRole('button', { name: 'Unlink RV' })).toBeVisible()
  await saveSymbol(request, '4k7', 'default 4k7')
  await page.reload()
  await expect(page.getByText('Updated linked parts: RV')).toBeVisible()
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^R1 .* 4.7k$/m)
  await request.delete('/api/library/libraries/e2e-versions')
})
