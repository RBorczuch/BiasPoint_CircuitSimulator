import { expect, test } from '@playwright/test'

test('a very large run asks first and starts nothing until answered', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'big' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 a 0 SIN(0 1 1k)\nR1 a b 1k\nC1 b 0 1u' },
  })
  // 1 ns steps over 1 s: a billion points. (Voltages only is tested in the backend.)
  const simulation = { active: 'tran', cards: { op: '.op', tran: '.tran 1n 1' } }
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_simulation', simulation } },
  })
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await expect(page.locator('footer')).toContainText('rev 2')
  await page.keyboard.press('F5')
  await expect(page.getByText('This run is very large')).toBeVisible()
  const jobs = await (await request.get(`/api/projects/${id}/runs`)).json()
  expect(jobs).toHaveLength(0) // nothing started yet
  await expect(page.getByRole('button', { name: 'Voltages only' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Run anyway' })).toBeVisible()
  await page.waitForTimeout(500)
  expect(await (await request.get(`/api/projects/${id}/runs`)).json()).toHaveLength(0)
})
