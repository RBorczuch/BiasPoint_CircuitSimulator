import { expect, test } from '@playwright/test'

test('history panel: steps with their labels, a click goes back and forward', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'history' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'R1 a 0 1k' } })
  const doc = await (await request.get(`/api/projects/${id}/document`)).json()
  const r1 = doc.project.sheets[0].instances.find((i: { ref: string }) => i.ref === 'R1')
  for (const value of ['2k', '3k'])
    await request.post(`/api/projects/${id}/commands`, {
      data: { command: { type: 'set_params', sheet: 'root', id: r1.id, params: { R: value } } },
    })
  await page.goto(`/?project=${id}`)
  await page.getByRole('tab', { name: 'History' }).click()
  const list = page.getByRole('list', { name: 'History' })
  await expect(list.getByRole('button', { name: /Set R1: R=3k/ })).toHaveAttribute('aria-current', 'step')

  await list.getByRole('button', { name: /Import netlist/ }).click()
  await expect(list.getByRole('button', { name: /Import netlist/ })).toHaveAttribute('aria-current', 'step')
  const netlist = async () => (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(await netlist()).toMatch(/^R1 a 0 1k$/m)
  await list.getByRole('button', { name: /Set R1: R=3k/ }).click() // forward again
  await expect.poll(netlist).toMatch(/^R1 a 0 3k$/m)
})
