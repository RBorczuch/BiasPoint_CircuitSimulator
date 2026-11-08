import { expect, test } from '@playwright/test'

test('a transfer function block: its Bode plot in the inspector, a bad expression says why', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'hs' } })).json()).id
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const sheet = (await doc()).sheets[0].name
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet,
        instances: [
          {
            id: '00000000-0000-7000-8000-000000000011',
            ref: 'A1',
            symbol: 'bpt:hs',
            at: [2540, 0],
            model: { params: { h: '1/(1+s/(2*pi*1k))' } },
          },
        ],
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())
  const [x, y] = await page.evaluate(() => window.__bpt?.toScreen([2540, 0]) ?? [0, 0])
  await page.mouse.click(x, y)
  const plot = page.getByTestId('transfer-plot')
  await expect(plot).toContainText('(6283) / (1·s + 6283)') // 2π·1k over s + 2π·1k
  await expect(plot.getByRole('img', { name: '|H|(f)' })).toBeVisible()

  const field = page.getByRole('textbox', { name: 'h', exact: true })
  await field.fill('s^2/(s+1)')
  await field.press('Enter')
  await expect(page.getByTestId('transfer-error')).toContainText('more zeros than poles')
})
