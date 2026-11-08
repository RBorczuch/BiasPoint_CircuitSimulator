import { expect, test } from '@playwright/test'

test('probes are plotted after a run and show their value on the schematic', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'probes' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 SIN(0 1 1k)\nR1 in mid 1k\nR2 mid2 0 1k' },
  })
  const x = 30000
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'transaction',
        commands: [
          {
            type: 'add_objects',
            sheet: 'root',
            instances: [
              { ref: 'IP1', symbol: 'bpt:probe_i', at: [x, 0] },
              { ref: 'VP1', symbol: 'bpt:probe_v', at: [x + 2540, 0] },
            ],
            labels: [
              { text: 'mid', at: [x, -381] },
              { text: 'mid2', at: [x, 381] },
              { text: 'mid', at: [x + 2540, 254] },
            ],
          },
          {
            type: 'set_simulation',
            simulation: {
              active: 'tran',
              cards: { op: '.op', dc: '.dc V1 0 1 0.1', ac: '.ac dec 20 10 1meg', tran: '.tran 10u 2m' },
            },
          },
        ],
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByRole('button', { name: 'I(IP1)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(mid)', exact: true })).toBeVisible()
})
