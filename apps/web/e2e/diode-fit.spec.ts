import { expect, test } from '@playwright/test'

test('a diode fitted to datasheet forward-voltage points', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'diode' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/Diode (signal)')

  // Forward voltage at forward current, as read from a datasheet (the last one doubtful: 0).
  await expect(wizard.getByRole('tab', { name: 'I-V forward' })).toBeVisible()
  await expect(wizard.getByRole('tab', { name: /^\|Z\|\(f\)/ })).toHaveCount(0)
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard
    .getByRole('textbox', { name: 'Points VF(IF)' })
    .fill('0.1m 0.503\n1m 0.622\n10m 0.758\n100m 0.97\n300m 1.4 0')
  await wizard.getByRole('button', { name: /^Fit 3 values to the points/ }).click()
  await expect(wizard.getByText(/worst point/).first()).toBeVisible()
  await expect(wizard.getByTestId('residuals-VF(IF)')).toBeVisible()
  // The fitted values are in the form (IS changed from the template's default).
  await expect(wizard.getByRole('textbox', { name: 'IS', exact: true })).not.toHaveValue('2.52n')
})

test('a Zener from its datasheet values and an LED from its colour', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'zener' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  const template = wizard.getByRole('combobox', { name: 'Model' })
  await template.selectOption('tpl:Standard templates/Zener diode')
  await expect(wizard.getByRole('tab', { name: 'I-V reverse' })).toBeVisible()
  const values = wizard.getByTestId('zener-values')
  await values.getByLabel('VZ').fill('6.2')
  await values.getByLabel('IZT').fill('5m')
  await values.getByLabel('ZZT').fill('10')
  await values.getByRole('button', { name: 'Apply' }).click()
  await expect(wizard.getByRole('textbox', { name: 'Iz', exact: true })).toHaveValue('0.00500')
  await expect(wizard.getByRole('textbox', { name: 'Vz', exact: true })).toHaveValue('6.176')

  await template.selectOption('tpl:Standard templates/LED')
  await wizard.getByLabel('LED colour').selectOption('blue')
  await expect(wizard.getByRole('textbox', { name: 'N', exact: true })).toHaveValue('3.5')
  await wizard.getByRole('tab', { name: 'Data' }).click() // the colour is part data
  await expect(wizard.getByRole('combobox', { name: 'Colour' })).toHaveValue('blue')
})

test('a MOSFET fitted to its threshold and on-resistance', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'mosfet' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard
    .getByRole('combobox', { name: 'Model' })
    .selectOption('tpl:Standard templates/N-channel MOSFET')
  // 2N7002-like: Vth 2.1 V at 250 uA (Vds = Vgs), RDS(on) 1.7 ohm at 4.5 V and 1.2 ohm at 10 V.
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points Id(Vgs)' }).fill('2.1 250u')
  await wizard.getByRole('tab', { name: /^RDS\(Vgs\)/ }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points RDS(Vgs)' }).fill('4.5 1.7\n10 1.2')
  await wizard.getByRole('button', { name: /^Fit 3 values to the points/ }).click()
  await expect(wizard.getByText(/worst point/).first()).toBeVisible()
  await expect(wizard.getByRole('textbox', { name: 'Vth', exact: true })).toHaveValue('2.07')
  await expect(wizard.getByTestId('chart-RDS(Vgs)')).toBeVisible()
  // Capacitances from Ciss, Coss, Crss.
  const caps = wizard.getByTestId('mosfet-values')
  await caps.getByLabel('Ciss').fill('50p')
  await caps.getByLabel('Coss').fill('25p')
  await caps.getByLabel('Crss').fill('5p')
  await caps.getByRole('button', { name: 'Apply' }).click()
  await expect(wizard.getByRole('textbox', { name: 'Cgd', exact: true })).toHaveValue('5p')
})

test('a BJT fitted to its gain and saturation voltage', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'bjt' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/NPN transistor')
  // BC547B-like: hFE 150 / 290 / 180 at 10 uA / 2 mA / 100 mA; VCE(sat) at Ib = Ic / 20.
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points hFE(Ic)' }).fill('10u 150\n2m 290\n100m 180')
  await wizard.getByRole('tab', { name: /^VCEsat\(Ic\)/ }).click()
  await wizard.getByLabel('Forced beta of the points').fill('20')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points VCEsat(Ic)' }).fill('10m 0.09\n100m 0.2')
  await wizard.getByRole('button', { name: /^Advanced/ }).click()
  for (const field of ['IS', 'RC', 'BR']) await wizard.getByLabel(`Fit ${field}`, { exact: true }).check()
  await wizard.getByRole('button', { name: /^Fit 7 values to the points/ }).click()
  await expect(wizard.getByText(/worst point/).first()).toBeVisible()
  await expect(wizard.getByTestId('chart-VCEsat(Ic)')).toBeVisible()
  const caps = wizard.getByTestId('bjt-values')
  await caps.getByLabel('fT', { exact: true }).fill('300meg')
  await caps.getByLabel('Cobo').fill('4p')
  await caps.getByLabel('Cibo').fill('9p')
  await caps.getByRole('button', { name: 'Apply' }).click()
  await expect(wizard.getByRole('textbox', { name: 'Cjc', exact: true })).toHaveValue('4p')
})

test('a MOSFET output curve at its Vgs: the fit finds λ from its slope', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'output' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard
    .getByRole('combobox', { name: 'Model' })
    .selectOption('tpl:Standard templates/N-channel MOSFET')
  await wizard.getByRole('tab', { name: /^Id\(Vds\)/ }).click()
  await wizard.getByLabel('Vgs of the output points').fill('5')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  // A slope of 5 % per volt in saturation.
  await wizard.getByRole('textbox', { name: 'Points Id(Vds)' }).fill('4 2.4\n6 2.6\n8 2.8\n10 3.0')
  const choice = wizard.getByTestId('fit-choice')
  for (const chip of await choice.getByRole('button').all()) {
    const want = (await chip.textContent()) === 'λ' || (await chip.textContent())?.startsWith('Lambda')
    if (((await chip.getAttribute('aria-pressed')) === 'true') !== Boolean(want)) await chip.click()
  }
  await wizard.getByRole('button', { name: /^Fit 1 value/ }).click()
  await expect(wizard.getByTestId('fit-change')).toBeVisible({ timeout: 20_000 })
  await expect(wizard.getByTestId('fit-change')).toContainText(/λ|Lambda/)
})

test('a MOSFET gate charge: its capacitances from Qgs and Qgd, and the Vgs(Qg) chart', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'charge' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard
    .getByRole('combobox', { name: 'Model' })
    .selectOption('tpl:Standard templates/N-channel MOSFET')
  await expect(wizard.getByRole('tab', { name: 'Vgs(Qg)', exact: true })).toBeVisible({ timeout: 20_000 })
  const card = wizard.getByTestId('gate-charge-values')
  await card.getByLabel('Qgs').fill('2n')
  await card.getByLabel('Qgd').fill('4n')
  await card.getByLabel('Plateau').fill('4')
  await card.getByLabel('VDD').fill('20')
  await card.getByRole('button', { name: 'Apply' }).click()
  // Cgd = 4n / 20 = 200p; Cgs = 2n / 4 − 200p = 300p.
  await expect(wizard.getByRole('textbox', { name: 'Cgd', exact: true })).toHaveValue(
    /^200p$|^2e-10$|^200\.?0*p$/,
  )
  await expect(wizard.getByRole('textbox', { name: 'Cgs', exact: true })).toHaveValue(
    /^300p$|^3e-10$|^300\.?0*p$/,
  )
})
