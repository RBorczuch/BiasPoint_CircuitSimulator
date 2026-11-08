/** The characteristic charts (docs/projekt-kreator.md §5): text inside, cursors, full screen, zoom. */
import { expect, type Page, test } from '@playwright/test'

async function mlccFitted(page: Page, request: import('@playwright/test').APIRequestContext) {
  const id = (await (await request.post('/api/projects', { data: { name: 'charts' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Part from a datasheet/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('textbox', { name: 'C', exact: true }).fill('10u')
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard
    .getByRole('textbox', { name: 'Points |Z|(f)' })
    .fill('1k 16\n10k 1.6\n100k 0.17\n1meg 0.02\n10meg 0.08')
  await wizard.getByRole('button', { name: /^Fit \d+ value/ }).click()
  await expect(wizard.getByTestId('residuals-|Z|(f)')).toBeVisible()
  return wizard
}

/** Texts of every chart that leave their svg (none should). */
async function textsOutside(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = []
    for (const svg of document.querySelectorAll<SVGSVGElement>('svg[role="img"]')) {
      const w = svg.width.baseVal.value
      const h = svg.height.baseVal.value
      for (const t of svg.querySelectorAll<SVGTextElement>('text')) {
        const b = t.getBBox()
        if (b.x < -0.5 || b.y < -0.5 || b.x + b.width > w + 0.5 || b.y + b.height > h + 0.5)
          out.push(`${svg.getAttribute('aria-label')}: ${t.textContent}`)
      }
    }
    return out
  })
}

/** A value as the form shows it (SPICE suffixes; "1.2n"). */
function parseEngineering(text: string): number {
  const m = /^([\d.e+-]+)\s*(meg|[tgkmunpf])?/i.exec(text.trim())
  if (!m) return Number.NaN
  const scale: Record<string, number> = {
    t: 1e12,
    g: 1e9,
    meg: 1e6,
    k: 1e3,
    m: 1e-3,
    u: 1e-6,
    n: 1e-9,
    p: 1e-12,
    f: 1e-15,
  }
  return Number(m[1]) * (m[2] ? scale[m[2].toLowerCase()] : 1)
}

test('chart texts stay inside at any width; family labels apart', async ({ page, request }) => {
  const wizard = await mlccFitted(page, request)
  expect(await textsOutside(page)).toEqual([])
  await page.setViewportSize({ width: 1000, height: 800 })
  await page.waitForTimeout(300)
  expect(await textsOutside(page)).toEqual([])
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/NPN transistor')
  await wizard.getByRole('button', { name: 'All charts at once' }).click()
  await expect(wizard.getByRole('img', { name: 'Ic(Vce)' })).toContainText('Ib = ')
  expect(await textsOutside(page)).toEqual([])
})

test('reading a chart: value under the mouse, cursors A and B, full screen, zoom', async ({
  page,
  request,
}) => {
  const wizard = await mlccFitted(page, request)
  const chart = wizard.getByTestId('chart-|Z|(f)')
  const surface = chart.getByTestId('chart-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('no chart')

  // The values under the mouse: the model's |Z| at that frequency.
  await page.mouse.move(box.x + box.width * 0.5, box.y + 60)
  await expect(chart.getByTestId('chart-tooltip')).toContainText('model')

  // Cursors: click places A, Shift+click B; the readout gives the difference and the slope.
  await surface.click({ position: { x: box.width * 0.25, y: 60 } })
  await surface.click({ position: { x: box.width * 0.4, y: 60 }, modifiers: ['Shift'] })
  const readout = chart.getByTestId('chart-readout')
  await expect(readout).toContainText('A')
  await expect(readout).toContainText('B')
  await expect(readout).toContainText(/slope -?\d\.\d\d \/dec/) // |Z| falls a decade per decade
  await readout.getByRole('button', { name: 'Hide the cursors' }).click()
  await expect(readout).toHaveCount(0)

  // Full screen: the same chart large, with its toolbar; Esc goes back.
  await chart.getByRole('button', { name: 'Full screen' }).click()
  const full = page.getByTestId('chart-full')
  await expect(full.getByTestId('chart-toolbar')).toBeVisible()
  await expect(full.getByRole('img', { name: '|Z|(f)' })).toBeVisible()
  const big = await full.getByRole('img', { name: '|Z|(f)' }).boundingBox()
  expect(big?.width).toBeGreaterThan(box.width * 1.5)
  // Wheel zoom (alone in full screen): the axis spans less, fit view brings it back.
  const labels = async () =>
    (await full.getByRole('img', { name: '|Z|(f)' }).locator('text').allTextContents()).join(' ')
  const before = await labels()
  const fb = await full.getByTestId('chart-surface').boundingBox()
  if (!fb) throw new Error('no full chart')
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 3)
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120)
  await expect.poll(labels).not.toBe(before)
  await full.getByRole('button', { name: 'Fit view' }).click()
  await expect.poll(labels).toBe(before)
  await page.keyboard.press('Escape')
  await expect(full).toHaveCount(0)
  await expect(wizard).toBeVisible() // Esc closed the chart, not the editor

  // In the panel, Ctrl+wheel zooms; double-click fits again.
  const inline = async () =>
    (await chart.getByRole('img', { name: '|Z|(f)' }).locator('text').allTextContents()).join(' ')
  const start = await inline()
  const now = await surface.boundingBox() // the circuit above may have grown meanwhile
  if (!now) throw new Error('no chart')
  await page.mouse.move(now.x + now.width / 2, now.y + 60)
  await page.keyboard.down('Control')
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -120)
  await page.keyboard.up('Control')
  await expect.poll(inline).not.toBe(start)
  await surface.dblclick({ position: { x: now.width / 2, y: 60 } })
  await expect.poll(inline).toBe(start)
})

test('full screen goes from chart to chart with the cursors; axes typed; Space pans; range edges', async ({
  page,
  request,
}) => {
  const wizard = await mlccFitted(page, request)
  const chart = wizard.getByTestId('chart-|Z|(f)')

  // Double click on the title: full screen. A cursor set here stays on the next chart (same x axis).
  await chart.getByTestId('chart-title').dblclick()
  const full = page.getByTestId('chart-full')
  await expect(full.getByRole('img', { name: '|Z|(f)' })).toBeVisible()
  const area = await full.getByTestId('chart-surface').boundingBox()
  if (!area) throw new Error('no chart')
  await page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.4)
  await expect(full.getByTestId('chart-readout')).toContainText('A')

  // B to the resonance of |Z|: the cursor stands in the curve's dip.
  await full.getByRole('button', { name: 'B → resonance' }).click()
  await expect(full.getByTestId('chart-readout')).toContainText(/B [\d.]+ [kM]?Hz/)

  const before = await full.getByTestId('chart-title').textContent()
  await full.getByRole('button', { name: 'Next chart' }).click()
  await expect(full.getByTestId('chart-title')).not.toHaveText(before ?? '')
  await expect(full.getByTestId('chart-readout')).toContainText('A') // still there
  await page.keyboard.press('PageUp')
  await expect(full.getByTestId('chart-title')).toHaveText(before ?? '')

  // A click on the x axis types its range; an impossible one is refused, the view stays.
  const labels = async () =>
    (await full.getByRole('img', { name: '|Z|(f)' }).locator('text').allTextContents()).join(' ')
  const fb = await full.getByTestId('chart-surface').boundingBox()
  if (!fb) throw new Error('no full chart')
  await page.mouse.click(fb.x + fb.width / 2, fb.y + fb.height - 6)
  const form = full.getByTestId('axis-entry')
  await form.getByLabel('X axis from').fill('1 MHz')
  await form.getByLabel('X axis to').fill('1 kHz')
  await form.getByRole('button', { name: 'OK' }).click()
  await expect(form.getByLabel('X axis from')).toHaveAttribute('aria-invalid', 'true')
  await form.getByLabel('X axis from').fill('1k')
  await form.getByLabel('X axis to').fill('10k')
  const wide = await labels()
  await form.getByRole('button', { name: 'OK' }).click()
  await expect(form).toHaveCount(0)
  await expect.poll(labels).not.toBe(wide)
  await expect.poll(labels).toContain('1 kHz')

  // Space + drag moves the view.
  const typed = await labels()
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 3)
  await page.keyboard.down('Space')
  await page.mouse.down()
  await page.mouse.move(fb.x + fb.width / 2 + 120, fb.y + fb.height / 3)
  await page.mouse.up()
  await page.keyboard.up('Space')
  await expect.poll(labels).not.toBe(typed)
  await page.keyboard.press('Escape')
  await expect(full).toHaveCount(0)

  // The ends of the fitting range drag.
  await wizard.getByRole('button', { name: 'Fit range' }).click()
  const surface = chart.getByTestId('chart-surface')
  const box = await surface.boundingBox()
  if (!box) throw new Error('no chart')
  await page.mouse.move(box.x + box.width * 0.3, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.6, box.y + 60)
  await page.mouse.up()
  const from = wizard.getByRole('textbox', { name: 'Fit range from' })
  const start = await from.inputValue()
  expect(start).not.toBe('')
  const edge = await chart.getByTestId('range-edge-0').boundingBox()
  if (!edge) throw new Error('no edge')
  await page.mouse.move(edge.x + edge.width / 2, box.y + 60)
  await page.mouse.down()
  await page.mouse.move(edge.x + 40, box.y + 60)
  await page.mouse.up()
  await expect(from).not.toHaveValue(start)
})

test('a parameter card explains it and highlights its part of the curve; typing locks it', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'help' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Part from a datasheet/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')

  await wizard.getByRole('button', { name: 'About ESL' }).hover()
  const card = page.getByTestId('param-help-esl')
  await expect(card).toContainText('Equivalent series inductance')
  await expect(card).toContainText('highlighted on |Z|(f)')
  await expect(card).toContainText('Typical')
  await expect(wizard.getByTestId('chart-|Z|(f)').getByTestId('chart-highlight')).toBeVisible()
  // Limits of the fit are set in the card and shown by the field.
  await card.getByLabel('Maximum of ESL').fill('2n')
  await page.mouse.move(5, 5)
  await expect(card).toHaveCount(0)
  await expect(wizard.getByTestId('chart-|Z|(f)').getByTestId('chart-highlight')).toHaveCount(0)
  await expect(wizard.getByTestId('field-esl')).toContainText('fit within … – 2n')

  // A typed value is locked (the fit leaves it); the lock lets it be fitted again.
  const lock = wizard.getByRole('checkbox', { name: 'Fit ESR' })
  await expect(lock).toHaveAttribute('aria-checked', 'true')
  await wizard.getByRole('textbox', { name: 'ESR', exact: true }).fill('10m')
  await expect(lock).toHaveAttribute('aria-checked', 'false')
  await lock.click()
  await expect(lock).toHaveAttribute('aria-checked', 'true')

  // A diode's series resistance: the right end of the forward curve.
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/Diode (signal)')
  await wizard.getByRole('button', { name: 'About RS' }).click() // a click (touch, keyboard) opens it too
  await expect(page.getByTestId('param-help-rs')).toContainText('high current')
  await expect(wizard.getByTestId('chart-I-V forward').getByTestId('chart-highlight')).toBeVisible()
})

test('dragging: feature handles with locks, Esc, keys and typed values; pulling the curve', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'drag' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Part from a datasheet/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  const esl = wizard.getByRole('textbox', { name: 'ESL', exact: true })
  const esr = wizard.getByRole('textbox', { name: 'ESR', exact: true })
  const [esl0, esr0] = [await esl.inputValue(), await esr.inputValue()]
  const srf = wizard.getByTestId('handle-SRF')
  const center = async () => {
    const b = await srf.boundingBox()
    if (!b) throw new Error('no handle')
    return [b.x + b.width / 2, b.y + b.height / 2] as const
  }

  // Hovering the handle shows what it changes; while dragging the new values are shown; Esc cancels.
  let [x, y] = await center()
  await page.mouse.move(x, y)
  await expect(wizard.getByTestId('field-esl').locator('.text-amber-600')).toHaveCount(1)
  await page.mouse.down()
  await page.mouse.move(x - 40, y - 15, { steps: 5 })
  await expect(wizard.getByTestId('handle-readout')).toContainText('ESL')
  await expect(esl).not.toHaveValue(esl0)
  await page.keyboard.press('Escape')
  await page.mouse.up()
  await expect(esl).toHaveValue(esl0)
  await expect(esr).toHaveValue(esr0)

  // A locked value stays: with ESL locked the resonance handle moves ESR only.
  await wizard.getByRole('checkbox', { name: 'Fit ESL' }).click()
  ;[x, y] = await center()
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x - 40, y - 20, { steps: 5 })
  await page.mouse.up()
  await expect(esl).toHaveValue(esl0)
  await expect(esr).not.toHaveValue(esr0)
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(esr).toHaveValue(esr0)
  await wizard.getByRole('checkbox', { name: 'Fit ESL' }).click()

  // Keys on a focused handle; a double-click to type where it goes.
  await srf.focus()
  await page.keyboard.press('ArrowLeft')
  await expect(esl).not.toHaveValue(esl0)
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await srf.dblclick()
  const entry = wizard.getByTestId('handle-entry')
  await entry.getByLabel('SRF x').fill('1meg')
  await entry.getByRole('button', { name: 'OK' }).click()
  const typed = await esl.inputValue()
  expect(typed).not.toBe(esl0) // ESL = 1 / ((2π·1 MHz)²·C)

  // Pulling the curve anywhere: the unlocked values follow, one undo step puts them back.
  const before = {
    esl: await esl.inputValue(),
    esr: await esr.inputValue(),
    c: await wizard.getByRole('textbox', { name: 'C', exact: true }).inputValue(),
  }
  const point = await wizard.getByTestId('chart-|Z|(f)').evaluate((chart) => {
    const path = chart.querySelector<SVGPathElement>('path[stroke="#3b82f6"]')
    const svg = chart.querySelector('svg[role="img"]')
    if (!path || !svg) return null
    const p = path.getPointAtLength(path.getTotalLength() * 0.3)
    const b = svg.getBoundingClientRect()
    return [b.x + p.x, b.y + p.y]
  })
  if (!point) throw new Error('no curve')
  await page.mouse.move(point[0], point[1])
  await page.mouse.down()
  await page.mouse.move(point[0], point[1] - 30, { steps: 6 })
  await expect(wizard.getByTestId('chart-pull')).toBeVisible()
  await expect(wizard.getByTestId('pull-readout')).toBeVisible()
  await page.mouse.up()
  const after = {
    esl: await esl.inputValue(),
    esr: await esr.inputValue(),
    c: await wizard.getByRole('textbox', { name: 'C', exact: true }).inputValue(),
  }
  expect(after).not.toEqual(before)
  await wizard.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(esl).toHaveValue(before.esl)
  await expect(esr).toHaveValue(before.esr)

  // A diode's handles on its forward curve: RS from the bend at high current.
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/Diode (signal)')
  const rs = wizard.getByRole('textbox', { name: 'RS', exact: true })
  const rs0 = await rs.inputValue()
  const handle = wizard.getByTestId('handle-RS')
  await expect(handle).toBeVisible({ timeout: 15_000 })
  const hb = await handle.boundingBox()
  if (!hb) throw new Error('no RS handle')
  await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2)
  await page.mouse.down()
  await page.mouse.move(hb.x + hb.width / 2 + 25, hb.y + hb.height / 2, { steps: 5 })
  await page.mouse.up()
  await expect(rs).not.toHaveValue(rs0)
})

test('typed in full units, M is mega: a handle set to 20 MHz and 50 mΩ', async ({ page, request }) => {
  const wizard = await mlccFitted(page, request)
  const chart = wizard.getByTestId('chart-|Z|(f)')
  await chart.getByTestId('handle-SRF').dblclick()
  const entry = chart.getByTestId('handle-entry')
  await entry.getByLabel('SRF x').fill('20 MHz')
  await entry.getByLabel('SRF y').fill('50 mΩ')
  await entry.getByRole('button', { name: 'OK' }).click()
  // The resonance moved there: 1/(2π·20 MHz)²/C for the ESL, not a value a million million off.
  const esl = Number(
    await wizard.getByRole('textbox', { name: 'ESL', exact: true }).inputValue().then(parseEngineering),
  )
  const c = Number(
    await wizard.getByRole('textbox', { name: 'C', exact: true }).inputValue().then(parseEngineering),
  )
  expect(1 / (2 * Math.PI * Math.sqrt(esl * c))).toBeGreaterThan(15e6)
  expect(1 / (2 * Math.PI * Math.sqrt(esl * c))).toBeLessThan(25e6)
})

test('points: a table to paste into, rows checked and left out, edited on the chart; helper cards', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'points' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Part from a datasheet/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  const table = wizard.getByTestId('points-|Z|(f)')

  // Empty: what the points are and an example that fits (an impedance here, not a voltage).
  await expect(table).toContainText('Impedance magnitude against frequency')
  // Columns pasted from a spreadsheet (tab separated, a decimal comma, a bad row).
  await table.getByRole('textbox', { name: 'New point x' }).focus()
  await page.evaluate(() => {
    const data = new DataTransfer()
    data.setData('text', '1k\t16\n10k\t1,6\n100k\tx\n1meg\t0,02')
    document.activeElement?.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  })
  await expect(table.getByRole('textbox', { name: 'Point 4 y' })).toHaveValue('0,02')
  await expect(table.getByRole('row', { name: /100k/ })).toHaveAttribute('title', '“x” is not a number')
  // A row typed with a unit prefix: 10 in the MHz column is 10 MHz.
  await table.getByLabel('Unit of frequency').selectOption('meg')
  await table.getByRole('textbox', { name: 'New point x' }).fill('10')
  await table.getByRole('textbox', { name: 'New point y' }).fill('0.08')
  await table.getByRole('textbox', { name: 'New point y' }).press('Enter')
  await expect(table.getByRole('textbox', { name: 'Point 5 x' })).toHaveValue('10meg')
  // Left out of the fit, still shown (hollow on the chart).
  await table.getByRole('checkbox', { name: 'Fit point 1' }).uncheck()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  await expect(wizard.getByRole('textbox', { name: 'Points |Z|(f)' })).toHaveValue(/^1k 16 0\n/)
  await wizard.getByRole('button', { name: 'Table', exact: true }).click()

  // On the chart: right click puts the point back in; dragging a point corrects its reading.
  const chart = wizard.getByTestId('chart-|Z|(f)')
  const dot = async (n: number) =>
    chart.evaluate((c, k) => {
      const svg = c.querySelector('svg[role="img"]')
      const dots = [...(svg?.querySelectorAll('circle') ?? [])].filter(
        (d) => d.getAttribute('stroke') === '#f97316' || d.getAttribute('fill') === '#f97316',
      )
      const b = svg?.getBoundingClientRect()
      const d = dots[k]
      return d && b ? [b.x + Number(d.getAttribute('cx')), b.y + Number(d.getAttribute('cy'))] : null
    }, n)
  const first = await dot(0)
  if (!first) throw new Error('no point')
  await page.mouse.click(first[0], first[1], { button: 'right' })
  await expect(table.getByRole('checkbox', { name: 'Fit point 1' })).toBeChecked()
  await page.mouse.move(first[0], first[1])
  await page.mouse.down()
  await page.mouse.move(first[0], first[1] - 25, { steps: 5 })
  await page.mouse.up()
  await expect(table.getByRole('textbox', { name: 'Point 1 y' })).not.toHaveValue('16')

  // Alt+drag on the chart: the fitting range (its fields follow).
  const box = await chart.getByTestId('chart-surface').boundingBox()
  if (!box) throw new Error('no chart')
  await page.keyboard.down('Alt')
  await page.mouse.move(box.x + box.width * 0.4, box.y + 100)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.8, box.y + 100, { steps: 4 })
  await page.mouse.up()
  await page.keyboard.up('Alt')
  await expect(chart.getByTestId('chart-range')).toBeVisible()
  await expect(wizard.getByLabel('Fit range from')).not.toHaveValue('')

  // A helper card shows what Apply would set; a folded card stays folded.
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/Zener diode')
  const zener = wizard.getByTestId('zener-values')
  await expect(zener.getByTestId('zener-values-preview')).toContainText('→ BV')
  await zener.getByRole('button', { name: /Zener from the datasheet table/ }).click()
  await expect(zener.getByLabel('VZ')).toHaveCount(0)
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('tpl:Standard templates/Zener diode')
  await expect(wizard.getByTestId('zener-values').getByLabel('VZ')).toHaveCount(0)
})
