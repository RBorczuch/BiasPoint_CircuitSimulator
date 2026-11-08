import { expect, test } from '@playwright/test'

test('draw the symbol of a block sheet, then go back to the automatic box', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'block symbol' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 vin 0 DC 2\nR1 vin mid 1k\nR2 mid 0 1k' },
  })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const root = (await doc()).sheets[0]
  const ids = root.instances.filter((i: { ref: string }) => i.ref === 'R2').map((i: { id: string }) => i.id)
  const made = await request.post(`/api/projects/${id}/blocks`, { data: { ids, name: 'load' } })
  expect(made.ok()).toBe(true)
  const netlist = async () => (await request.get(`/api/projects/${id}/export/netlist`)).text()
  const before = (await netlist()).match(/^X1 .*$/m)?.[0]

  await page.goto(`/?project=${id}`)
  await page.getByRole('tab', { name: 'load' }).click()
  await page.getByRole('button', { name: 'Draw block symbol…' }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  await expect(editor.getByRole('heading', { name: /Block symbol – load/ })).toBeVisible()
  await expect(editor).toBeVisible()
  // A new pin is the next port; a second pin for the same port is a problem.
  await editor.getByRole('button', { name: 'Pin', exact: true }).click()
  const box = (await editor.getByRole('application', { name: 'Symbol canvas' }).boundingBox()) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  }
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.85)
  await expect(editor.getByText(/pin numbers must be unique/)).toBeVisible()
  await editor.getByRole('button', { name: 'Delete item' }).click()
  await editor.getByRole('button', { name: 'Use for the block' }).click()
  await expect(page.getByText('Block symbol of “load” drawn')).toBeVisible()
  await expect.poll(async () => Boolean((await doc()).sheets[1].symbol)).toBe(true)
  expect((await netlist()).match(/^X1 .*$/m)?.[0]).toBe(before)

  await page.getByRole('button', { name: 'Edit block symbol…' }).click()
  await page.getByRole('button', { name: 'Use automatic box' }).click()
  await expect.poll(async () => (await doc()).sheets[1].symbol ?? null).toBeNull()
})
