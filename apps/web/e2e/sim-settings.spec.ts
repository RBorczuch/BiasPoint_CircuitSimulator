import { expect, test } from '@playwright/test'

test('DC family of curves, temperature, simulator options and the OP overlay choices', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'family' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'VC c 0 5\nIB 0 b 10u\nQ1 c b 0 QN\n.model QN npn(IS=1e-14 BF=100 VAF=100)' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.getByRole('button', { name: 'DC', exact: true }).nth(1).click()

  // What to sweep: sources, resistors, TEMP; then a second source for a family of curves.
  const source = page.getByLabel('Source', { exact: true })
  await expect(source.locator('option')).toContainText(['VC', 'IB', 'TEMP (temperature)'])
  await source.selectOption('VC')
  await page.getByLabel('Family of curves (sweep a second source)').check()
  await expect(page.getByLabel('Then sweep')).toHaveValue('IB')
  for (const [label, value] of [
    ['Stop', '30u'],
    ['Step', '10u'],
  ] as const) {
    const field = page.getByLabel(label, { exact: true }).nth(1)
    await field.fill(value)
    await field.press('Tab')
  }
  await expect(page.locator('code').filter({ hasText: '.dc VC' })).toHaveText('.dc VC 0 5 0.1 IB 0 30u 10u')

  // Temperature and an option reach the project.
  const temperature = page.getByLabel('Temperature', { exact: true })
  await temperature.fill('85')
  await temperature.press('Tab')
  await page.getByTestId('sim-options').locator('summary').click()
  const reltol = page.getByLabel('Rel. tolerance')
  await reltol.fill('1e-4')
  await reltol.press('Tab')
  await expect
    .poll(async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project.simulation)
    .toMatchObject({ temperature: '85', options: { reltol: '1e-4' } })

  // Run: four curves, one per base current, with their legend.
  await page.keyboard.press('F5')
  await expect(page.getByText(/DC · ok/)).toBeVisible({ timeout: 20_000 })
  await page.getByTitle(/Add signal/).click()
  await page.getByPlaceholder(/Signal or expression/).fill('I(VC)')
  await page.getByRole('option', { name: 'I(VC)', exact: true }).click()
  const legend = page.getByTestId('family-legend')
  await expect(legend).toContainText('IB=0 A')
  await expect(legend).toContainText('IB=30 µA')
  await expect(legend.locator('span > span')).toHaveCount(4)

  // OP: the overlay choices are offered (and remembered in the browser).
  await page.getByRole('button', { name: 'OP', exact: true }).nth(1).click()
  await page.getByLabel('Power').check()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('bpt.settings') ?? '{}').opPower)).toBe(
    true,
  )
})
