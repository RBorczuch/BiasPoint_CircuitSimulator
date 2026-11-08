import { expect, test } from '@playwright/test'

test('a snapshot taken before agent changes brings the project back (and Undo returns)', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'snapshots' } })).json()).id
  const add = (text: string, agent: boolean) =>
    request.post(`/api/projects/${id}/circuit/import`, {
      data: { text },
      headers: agent ? { 'X-BPT-Origin': 'agent' } : {},
    })
  await add('R1 a 0 1k', false)
  await add('R2 a b 2k\nC1 b 0 1u', true)

  await page.goto(`/?project=${id}`)
  await page.getByRole('tab', { name: 'Project' }).click()
  const list = page.getByRole('list', { name: 'Snapshots' })
  await expect(list).toContainText('Before AI agent changes')
  await list.getByRole('button', { name: 'Restore Before AI agent changes' }).click()
  await expect(page.getByText('Back to “Before AI agent changes”')).toBeVisible()
  const netlist = async () => (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(await netlist()).not.toMatch(/^R2 /m)
  expect(await netlist()).toMatch(/^R1 /m)

  await page.getByRole('button', { name: 'Undo', exact: true }).first().click()
  await expect.poll(netlist).toMatch(/^C1 /m)
})
