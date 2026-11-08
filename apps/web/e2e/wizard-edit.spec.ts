import { expect, test } from '@playwright/test'

/** |Z|(f) of 4.7 uF with 20 mOhm ESR and 1 nH ESL. */
function impedancePoints(): string {
  const lines: string[] = []
  for (let k = 0; k <= 12; k++) {
    const f = 10 ** (2 + k * 0.5)
    const w = 2 * Math.PI * f
    const x = w * 1e-9 - 1 / (w * 4.7e-6)
    lines.push(`${f.toPrecision(4)} ${Math.hypot(0.02, x).toPrecision(5)}`)
  }
  return lines.join('\n')
}

test('the wizard keeps where each value came from, suggests E24 and undoes', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'edit' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('button', { name: /^Continue with/ }).click() // step 1: the default template
  const c = wizard.getByRole('textbox', { name: 'C', exact: true })

  await c.fill('4.6u')
  await expect(wizard.getByTestId('origin-Cnom')).toHaveAttribute('data-origin', 'user')
  // A value typed by hand is locked: the fit leaves it unless it is unlocked.
  await expect(wizard.getByRole('checkbox', { name: 'Fit C' })).toHaveAttribute('aria-checked', 'false')
  // The parameter's card: what it is, and the nearest E24 value to use.
  await wizard.getByRole('button', { name: 'About C' }).hover()
  const card = page.getByTestId('param-help-Cnom')
  await expect(card).toContainText('Capacitance')
  await expect(card).toContainText('From the datasheet')
  await card.getByRole('button', { name: /^Use E24 4\.7 µF/ }).click()
  await expect(c).toHaveValue('4.7u')
  await page.mouse.move(5, 5)
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(c).toHaveValue('4.6u')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text

  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill(impedancePoints())
  await wizard.getByRole('checkbox', { name: 'Fit C' }).check() // unlocked: the fit may change it
  await wizard.getByRole('button', { name: /^Fit \d+ values? to the points/ }).click()
  await expect(c).toHaveValue('4.7u')
  await expect(wizard.getByTestId('origin-Cnom')).toHaveAttribute('data-origin', 'fit')
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(c).toHaveValue('4.6u')
  await wizard.getByRole('button', { name: 'Redo', exact: true }).click()
  await expect(c).toHaveValue('4.7u')
})

test('dragging the self-resonance on |Z|(f) sets ESL and ESR', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'drag' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('button', { name: /^Continue with/ }).click() // step 1: the default template
  const esl = wizard.getByRole('textbox', { name: 'ESL', exact: true })
  const before = await esl.inputValue()
  const handle = wizard.getByTestId('handle-SRF')
  const box = await handle.boundingBox()
  if (!box) throw new Error('no SRF handle')
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2]
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 30, y - 10, { steps: 5 }) // lower resonance, more loss
  await page.mouse.up()
  await expect(esl).not.toHaveValue(before)
  await expect(wizard.getByTestId('origin-esl')).toHaveAttribute('data-origin', 'user')
  // One drag is one undo step.
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(esl).toHaveValue(before)
})

test('a fit over a chosen range leaves the points outside out', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'range' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('button', { name: /^Continue with/ }).click() // step 1: the default template
  // The same capacitor, and a measurement glitch at 100 MHz (far off the curve).
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill(`${impedancePoints()}\n1e8 50`)
  await wizard.getByRole('button', { name: 'Fit range' }).click()
  await wizard.getByLabel('Fit range to').fill('10meg')
  await wizard.getByRole('button', { name: /^Fit \d+ values? to the points/ }).click()
  await expect(wizard.getByRole('textbox', { name: 'C', exact: true })).toHaveValue('4.7u')
  await expect(wizard.getByText(/Fitted in \d+ steps: 0\.\d+ % RMS/)).toBeVisible()
})
