import { expect, type Page, test } from '@playwright/test'

async function newMlcc(page: Page, request: import('@playwright/test').APIRequestContext) {
  const id = (await (await request.post('/api/projects', { data: { name: 'points' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  return wizard
}

test('one row of tabs; points added on the chart and removed from it', async ({ page, request }) => {
  const wizard = await newMlcc(page, request)
  const tabs = wizard.getByRole('tablist', { name: 'Characteristics' })
  await expect(tabs.getByRole('tab', { name: 'C(V)', exact: true })).toBeVisible()
  await expect(tabs.getByRole('tab', { name: 'L(I)', exact: true })).toHaveCount(0) // not of a capacitor
  await tabs.getByRole('tab', { name: 'ESR(f)', exact: true }).click()
  await expect(wizard.getByTestId('points-kind')).toHaveText('ESR(f)') // the same tab chooses the points
  await tabs.getByRole('tab', { name: '|Z|(f)', exact: true }).click()
  await expect(wizard.getByTestId('points-guide')).toBeVisible()

  await wizard.getByRole('button', { name: '+ Add points' }).click()
  await expect(wizard.getByTestId('chart-tool-hint')).toContainText('Click the chart to add a point')
  const surface = wizard.getByTestId('chart-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('no chart')
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.3)
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4)
  await expect(tabs.getByRole('tab', { name: '|Z|(f)', exact: true })).toHaveText('|Z|(f) (2)')
  await expect(wizard.getByRole('textbox', { name: 'Point 2 x' })).not.toHaveValue('')
  // In the order of x, whatever the order of the clicks.
  await page.mouse.click(box.x + box.width * 0.45, box.y + box.height * 0.35)
  const xOf = async (n: number) => wizard.getByRole('textbox', { name: `Point ${n} x` }).inputValue()
  await expect.poll(() => xOf(3)).not.toBe('')
  // A click on the curve adds a point too (the mouse does not pull the curve with the tool on).
  await page.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.4, { button: 'right' })
  await expect(tabs.getByRole('tab', { name: '|Z|(f)', exact: true })).toHaveText('|Z|(f) (2)')
  await page.keyboard.press('Escape')
  await expect(wizard.getByTestId('chart-tool-hint')).toHaveCount(0)
})

test('the fit says what it may change, shows was and is now, and is undone in one click', async ({
  page,
  request,
}) => {
  const wizard = await newMlcc(page, request)
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill('1k 16\n100k 0.16\n10meg 0.03')
  await expect(wizard.getByTestId('points-guide')).toHaveCount(0)
  const esr = wizard.getByRole('textbox', { name: 'ESR', exact: true })
  const before = await esr.inputValue()
  // V½ kept: the switches and the locks by the fields are the same choice.
  const vhalf = wizard.getByRole('button', { name: 'V½: changed by the fit' })
  if ((await vhalf.getAttribute('aria-pressed')) === 'true') await vhalf.click()
  await expect(wizard.getByRole('checkbox', { name: 'Fit V½' })).toHaveAttribute('aria-checked', 'false')

  await wizard.locator('#fit-button').click()
  const change = wizard.getByTestId('fit-change')
  await expect(change).toContainText('was')
  await expect(change).toContainText('ESR')
  await expect(change).not.toContainText('V½')
  const fitted = await esr.inputValue()
  expect(fitted).not.toBe(before)
  await change.getByRole('button', { name: 'Undo the fit' }).click()
  await expect(esr).toHaveValue(before)
  await expect(change).toHaveCount(0)
  await expect(wizard.getByTestId('fit-result')).toHaveCount(0)

  await wizard.locator('#fit-button').click()
  await expect(change).toBeVisible()
  await change.getByRole('button', { name: 'Keep' }).click()
  await expect(change).toHaveCount(0)
  await expect(esr).toHaveValue(fitted)
  await expect(wizard.getByTestId('fit-result')).toBeVisible()
  // Anything else changing a value ends the comparison.
  await wizard.locator('#fit-button').click()
  await expect(change).toBeVisible()
  await esr.fill('7m')
  await expect(change).toHaveCount(0)
})

test('the fit range selected by dragging on the chart, cleared by its ✕', async ({ page, request }) => {
  const wizard = await newMlcc(page, request)
  await expect(wizard.getByTestId('fit-range')).toHaveCount(0)
  await wizard.getByRole('button', { name: 'Fit range' }).click()
  const box = await wizard.getByTestId('chart-surface').boundingBox()
  if (!box) throw new Error('no chart')
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.5)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.5, { steps: 5 })
  await page.mouse.up()
  const range = wizard.getByTestId('fit-range')
  await expect(range.getByLabel('Fit range from')).not.toHaveValue('')
  await expect(range.getByLabel('Fit range to')).not.toHaveValue('')
  await expect(wizard.getByTestId('chart-tool-hint')).toHaveCount(0) // selected: the tool is off
  await range.getByRole('button', { name: 'All the points: no fit range' }).click()
  await expect(wizard.getByTestId('fit-range')).toHaveCount(0)
})
