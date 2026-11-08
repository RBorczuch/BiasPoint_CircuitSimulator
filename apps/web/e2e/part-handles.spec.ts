import { expect, type Page, test } from '@playwright/test'

async function newPart(page: Page, request: import('@playwright/test').APIRequestContext, template: string) {
  const id = (await (await request.post('/api/projects', { data: { name: 'handles' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption(template)
  return { id, wizard }
}

/** Drag a handle by (dx, dy) px. */
async function dragHandle(page: Page, handle: import('@playwright/test').Locator, dx: number, dy: number) {
  const box = await handle.boundingBox()
  if (!box) throw new Error('no handle')
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + dx / 2, y + dy / 2)
  await page.mouse.move(x + dx, y + dy)
  await page.mouse.up()
}

test('a MOSFET: the flat end of RDS(Vgs) sets RD and RS, and the curve follows at once', async ({
  page,
  request,
}) => {
  const { wizard } = await newPart(page, request, 'tpl:Standard templates/N-channel MOSFET')
  await wizard.getByRole('tab', { name: /^RDS\(Vgs\)/ }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  await wizard.getByRole('textbox', { name: 'Points RDS(Vgs)' }).fill('4 0.8\n10 0.4')
  const chart = wizard.getByTestId('chart-RDS(Vgs)')
  const handle = chart.getByTestId('handle-RDS')
  await expect(handle).toBeVisible()
  for (const name of ['RD', 'RS']) {
    const lock = wizard.getByLabel(`Fit ${name}`, { exact: true })
    if (!(await lock.isChecked())) await lock.check()
  }
  const rd = wizard.getByRole('textbox', { name: 'RD', exact: true })
  const before = await rd.inputValue()
  await dragHandle(page, handle, 0, -40)
  await expect(rd).not.toHaveValue(before)
})

test('a BJT: ISE on the low-current fall of its gain', async ({ page, request }) => {
  const { wizard } = await newPart(page, request, 'tpl:Standard templates/NPN transistor')
  await wizard.getByRole('tab', { name: /^hFE\(Ic\)/ }).click()
  const chart = wizard.getByTestId('chart-hFE(Ic)')
  const handle = chart.getByTestId('handle-ISE')
  await expect(handle).toBeVisible({ timeout: 20_000 })
  await wizard.getByRole('button', { name: /^Advanced/ }).click()
  const lock = wizard.getByLabel('Fit ISE', { exact: true })
  if (!(await lock.isChecked())) await lock.check()
  await wizard.getByRole('button', { name: /^Advanced/ }).click() // folded: shown while it changes
  await handle.hover()
  const ise = wizard.getByRole('textbox', { name: 'ISE', exact: true })
  await expect(ise).toBeVisible()
  const before = await ise.inputValue()
  await dragHandle(page, handle, 0, 30)
  await wizard.getByRole('button', { name: /^Advanced/ }).click()
  await expect(ise).not.toHaveValue(before)
})

test("a user's model: its curve pulled, fitted by simulation when released", async ({ page, request }) => {
  const lib = 'e2e-pull'
  await request.delete(`/api/library/libraries/${lib}`)
  const pid = (await (await request.post('/api/projects', { data: { name: 'source' } })).json()).id
  const opened = await (
    await request.post(`/api/projects/${pid}/templates/open`, { data: { template: 'capacitor' } })
  ).json()
  const doc = (await (await request.get(`/api/projects/${pid}/document`)).json()).project
  const form = doc.sheets.find((s: { name: string }) => s.name === opened.sheet).form
  const saved = await request.post('/api/components/templates', {
    data: {
      project_id: pid,
      sheet: opened.sheet,
      library: lib,
      name: 'My cap',
      kind: 'capacitor',
      description: '',
      category: '',
      fields: form,
    },
  })
  expect(saved.ok()).toBe(true)

  const { wizard } = await newPart(page, request, `tpl:${lib}/My cap`)
  const surface = wizard.getByTestId('chart-|Z|(f)').getByTestId('chart-surface')
  await expect(wizard.getByTestId('chart-|Z|(f)').locator('path').first()).toBeAttached({ timeout: 20_000 })
  const c = wizard.getByRole('textbox', { name: 'C', exact: true })
  const before = await c.inputValue()
  const box = await surface.boundingBox()
  if (!box) throw new Error('no chart')
  // Along the falling curve's line: find it where the cursor turns to a grab.
  const x = box.x + box.width * 0.2
  let found = false
  for (let y = box.y + 12; y < box.y + box.height - 30; y += 3) {
    await page.mouse.move(x, y)
    if ((await surface.getAttribute('class'))?.includes('cursor-grab')) {
      found = true
      await page.mouse.down()
      await page.mouse.move(x, y + 30)
      await page.mouse.move(x, y + 60)
      await page.mouse.up()
      break
    }
  }
  expect(found).toBe(true)
  await expect(page.getByText(/The curve follows the point/)).toBeVisible({ timeout: 30_000 })
  await expect(c).not.toHaveValue(before)
  await request.delete(`/api/library/libraries/${lib}`)
})

test('an op-amp: GBW sideways on its simulated Aol(f)', async ({ page, request }) => {
  const { wizard } = await newPart(page, request, 'tpl:Standard templates/Op-amp macromodel')
  await wizard.getByRole('tab', { name: 'Aol(f)', exact: true }).click()
  const handle = wizard.getByTestId('chart-Aol(f)').getByTestId('handle-GBW')
  await expect(handle).toBeVisible({ timeout: 20_000 })
  const lock = wizard.getByLabel('Fit GBW', { exact: true })
  if (!(await lock.isChecked())) await lock.check()
  const gbw = wizard.getByRole('textbox', { name: 'GBW', exact: true })
  const before = await gbw.inputValue()
  await dragHandle(page, handle, -40, 0)
  await expect(gbw).not.toHaveValue(before)
})

test('an op-amp fitted to its gain plot: only what the plot sets is offered', async ({ page, request }) => {
  const { wizard } = await newPart(page, request, 'tpl:Standard templates/Op-amp macromodel')
  await wizard.getByRole('tab', { name: 'Aol(f)', exact: true }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  // Gain of a part with GBW 3 MHz: 20 dB per decade, 0 dB at 3 MHz.
  await wizard.getByRole('textbox', { name: 'Points Aol(f)' }).fill('100 89.5\n10k 49.5\n300k 20')
  const choice = wizard.getByTestId('fit-choice')
  await expect(choice.getByRole('button')).toHaveText(['Aol', 'GBW'])
  const gbw = wizard.getByRole('textbox', { name: 'GBW', exact: true })
  await wizard.getByRole('button', { name: 'Fit 2 values to the points' }).click()
  await expect(wizard.getByTestId('fit-change')).toBeVisible({ timeout: 30_000 })
  await expect(gbw).toHaveValue(/^(2\.[89]|3|3\.[01])\d*meg$/)
})

test('a hybrid-pi transistor: β and Cπ fitted to its h21(f) points', async ({ page, request }) => {
  const { wizard } = await newPart(page, request, 'tpl:Standard templates/Hybrid-pi BJT (small signal)')
  await wizard.getByRole('tab', { name: 'h21(f)', exact: true }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  // β 150, fT ≈ 280 MHz at 1 mA (Cπ + Cμ ≈ 22 pF).
  await wizard.getByRole('textbox', { name: 'Points h21(f)' }).fill('1k 150\n10meg 28\n100meg 2.8')
  await expect(wizard.getByTestId('fit-choice').getByRole('button')).toHaveText(['β', 'rx', 'Cπ', 'Cμ'])
  await wizard.getByRole('button', { name: /^Fit 2 values/ }).click()
  await expect(wizard.getByTestId('fit-change')).toBeVisible({ timeout: 30_000 })
  await expect(wizard.getByRole('textbox', { name: 'β', exact: true })).toHaveValue(/^1[45]\d/)
})

test('points can weigh more: a column of weights when asked for', async ({ page, request }) => {
  const { wizard } = await newPart(page, request, 'mlcc')
  await wizard.getByRole('tab', { name: '|Z|(f)', exact: true }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill('1k 16\n100k 0.17')
  await wizard.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(wizard.getByLabel('Point 1 weight')).toHaveCount(0)
  await wizard.getByRole('button', { name: 'Weights', exact: true }).click()
  await wizard.getByLabel('Point 1 weight').fill('5')
  await wizard.getByLabel('Point 1 weight').press('Enter')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(wizard.getByRole('textbox', { name: 'Points |Z|(f)' })).toHaveValue('1k 16 5\n100k 0.17')
  // A weight that means something keeps the column there.
  await wizard.getByRole('button', { name: 'Table', exact: true }).click()
  await expect(wizard.getByLabel('Point 1 weight')).toHaveValue('5')
})
