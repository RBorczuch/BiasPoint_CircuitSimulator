import { expect, test } from '@playwright/test'

/** |Z|(f) of 4.7 µF with 12 mΩ ESR and 0.8 nH ESL (what a datasheet chart would give). */
function impedancePoints(): string {
  const lines: string[] = []
  for (let k = 0; k <= 24; k++) {
    const f = 10 ** (2 + k / 4)
    const w = 2 * Math.PI * f
    const z = Math.hypot(0.012, w * 0.8e-9 - 1 / (w * 4.7e-6))
    lines.push(`${f.toPrecision(5)} ${z.toPrecision(5)}`)
  }
  return lines.join('\n')
}

test('ideal capacitor -> quick model -> fitted component in its place -> back to ideal', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-real') // left by an interrupted run
  const id = (await (await request.post('/api/projects', { data: { name: 'real' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'V1 a 0 DC 5\nC1 a 0 1u' } })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const c1 = async () => (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'C1')

  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await expect(page.getByText(/rev 1/)).toBeVisible()
  const at = (await c1()).at
  const select = async () => {
    // The view fits the drawing once loaded: ask for the position each time.
    const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p as [number, number]) ?? [0, 0], at)
    await page.mouse.click(x, y)
  }
  await expect(async () => {
    await select()
    await expect(
      page.getByRole('tabpanel', { name: 'Properties' }).getByText('Ideal', { exact: true }),
    ).toBeVisible({ timeout: 1000 })
  }).toPass()
  await page.getByRole('textbox', { name: 'ESR' }).fill('20m')
  await page.getByRole('textbox', { name: 'ESR' }).press('Enter')
  await expect(page.getByText('Real', { exact: true })).toBeVisible()

  // The component maker opens with the quick model as the capacitor template's form.
  await page.getByRole('button', { name: 'Make a part from these values…' }).click()
  const wizard = page.getByTestId('component-wizard')
  await expect(wizard.getByRole('textbox', { name: 'C', exact: true })).toHaveValue('1u')
  await expect(wizard.getByRole('textbox', { name: 'ESR', exact: true })).toHaveValue('20m')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill(impedancePoints())
  await wizard.getByRole('button', { name: /^Fit \d+ values? to the points/ }).click()
  await expect(wizard.getByText(/Fitted in \d+ steps/)).toBeVisible()
  await expect(wizard.getByText(/worst point/).first()).toBeVisible()
  await expect(wizard.getByTestId('residuals-|Z|(f)')).toBeVisible() // verification: residuals per point
  await expect(wizard.getByRole('textbox', { name: 'C', exact: true })).toHaveValue('4.7u')
  await wizard.getByRole('textbox', { name: 'Part name' }).fill('E2EC4U7')
  await wizard.getByRole('textbox', { name: 'Library' }).fill('e2e-real')
  await wizard.getByRole('button', { name: 'Save and use for the part' }).click()
  await expect.poll(async () => (await c1()).symbol).toBe('sheet:E2EC4U7')
  const placed = await c1()
  expect(placed.model.params).toEqual({})

  // The inspector shows the library part with its card computed by simulation.
  await page.getByRole('tab', { name: 'Schematic' }).click()
  await expect(async () => {
    await select()
    await expect(page.getByText(/E2EC4U7 · capacitor · v1/)).toBeVisible({ timeout: 1000 })
  }).toPass()
  await expect(page.getByRole('img', { name: '|Z|(f)' })).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Make ideal' }).click()
  await expect.poll(async () => (await c1()).symbol).toBe('bpt:capacitor')
  expect((await c1()).model.params).toMatchObject({ C: '4.7u', esr: '12m' })
  await request.delete('/api/library/libraries/e2e-real')
})

test('transistor -> component from its SPICE model with datasheet curves', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'semi' } })).json()).id
  const text = 'V1 c 0 DC 5\nV2 b 0 DC 0.7\nQ1 c b 0 QX\n.model QX NPN(IS=2f BF=150 VAF=50)'
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text } })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const at = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'Q1').at

  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  const make = page.getByRole('button', { name: 'Make a part from model QX…' })
  await expect(async () => {
    const [x, y] = await page.evaluate((p) => window.__bpt?.toScreen(p as [number, number]) ?? [0, 0], at)
    await page.mouse.click(x, y)
    await expect(make).toBeVisible({ timeout: 1000 })
  }).toPass()
  // The inspector shows the transistor's curves from its model right away.
  await expect(page.getByTestId('part-curves').getByRole('img', { name: 'Ic(Vce)' })).toBeVisible({
    timeout: 20_000,
  })
  await make.click()
  // The NPN template with the model's values; its card computed by simulation.
  const wizard = page.getByTestId('component-wizard')
  await expect(wizard.getByRole('combobox', { name: 'Model' })).toHaveValue(
    'tpl:Standard templates/NPN transistor',
  )
  await expect(wizard.getByRole('textbox', { name: 'BF', exact: true })).toHaveValue('150')
  await expect(wizard.getByRole('textbox', { name: 'VAF', exact: true })).toHaveValue('50')
  await wizard.getByRole('button', { name: 'All charts at once' }).click()
  await expect(wizard.getByRole('img', { name: 'Ic(Vce)' })).toBeVisible({ timeout: 20_000 })
  await expect(wizard.getByRole('img', { name: 'hFE(Ic)' })).toBeVisible()
  await expect(wizard.getByRole('img', { name: 'Ic(Vce)' })).toContainText('Ib = ')
})
