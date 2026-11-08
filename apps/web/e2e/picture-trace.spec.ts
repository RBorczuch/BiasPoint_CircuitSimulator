import { expect, type Page, test } from '@playwright/test'

/** A 500 × 300 chart picture: black axes (frame 50…450 × 30…250) and a red falling line. */
async function chartPng(page: Page): Promise<Buffer> {
  const url = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 500
    canvas.height = 300
    const ctx = canvas.getContext('2d')
    if (!ctx) return ''
    ctx.fillStyle = 'white'
    ctx.fillRect(0, 0, 500, 300)
    ctx.strokeStyle = 'black'
    ctx.lineWidth = 2
    ctx.strokeRect(50, 30, 400, 220)
    ctx.strokeStyle = 'red'
    ctx.beginPath()
    ctx.moveTo(50, 40)
    ctx.lineTo(450, 240)
    ctx.stroke()
    return canvas.toDataURL('image/png')
  })
  return Buffer.from(url.split(',')[1], 'base64')
}

test('a datasheet picture traced on log axes: drawn along the curve, the model on the picture', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'trace' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('tab', { name: '|Z|(f)', exact: true }).click()
  await wizard.getByRole('button', { name: 'Trace a picture…' }).first().click()
  const trace = wizard.getByTestId('picture-trace')
  await trace.getByLabel('Datasheet picture or PDF').setInputFiles({
    name: 'z.png',
    mimeType: 'image/png',
    buffer: await chartPng(page),
  })

  // |Z|(f): both axes log to start with; a linear axis with values decades apart gets a hint.
  await expect(trace.getByRole('button', { name: 'X axis logarithmic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await trace.getByRole('button', { name: 'Y axis linear' }).click()
  await trace.getByLabel('X at the left edge').fill('100')
  await trace.getByLabel('X at the right edge').fill('100meg') // 6 decades
  await trace.getByLabel('Y at the bottom edge').fill('1m')
  await trace.getByLabel('Y at the top edge').fill('1k')
  await trace.getByRole('button', { name: 'Log?' }).click()
  await expect(trace.getByRole('button', { name: 'Y axis logarithmic' })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(trace.getByTestId('trace-model').first()).toBeAttached() // the model on the picture

  // Drawn along the red line from 1 kHz to 1 MHz: points evenly per decade on it.
  await trace.getByRole('button', { name: 'Draw' }).click()
  const chart = trace.getByRole('application', { name: /Datasheet chart/ })
  const box = await chart.boundingBox()
  if (!box) throw new Error('no picture')
  const at = (px: number, py: number) => [box.x + (px * box.width) / 500, box.y + (py * box.height) / 300]
  const lineY = (px: number) => 40 + ((px - 50) * 200) / 400
  const [sx, sy] = at(50 + 400 / 6, lineY(50 + 400 / 6)) // 1 kHz
  await page.mouse.move(sx, sy)
  await page.mouse.down()
  for (let px = 50 + 400 / 6; px <= 50 + (4 * 400) / 6; px += 10) {
    const [mx, my] = at(px, lineY(px))
    await page.mouse.move(mx, my)
  }
  const [ex, ey] = at(50 + (4 * 400) / 6, lineY(50 + (4 * 400) / 6)) // 1 MHz
  await page.mouse.move(ex, ey)
  await page.mouse.up()
  // half the frame: about 20 points
  await expect.poll(() => trace.getByTestId('trace-point').count()).toBeGreaterThan(10)
  await trace.getByRole('button', { name: 'Done' }).click()
  // The picture stays under the chart, or goes with a click; a click on it goes back to tracing.
  await expect(wizard.getByTestId('chart-picture')).toBeVisible()
  await wizard.getByRole('button', { name: 'Picture', exact: true }).click()
  await expect(wizard.getByTestId('chart-picture')).toHaveCount(0)
  await wizard.getByRole('button', { name: 'Picture', exact: true }).click()
  await wizard.getByTestId('chart-picture').click()
  await expect(trace).toBeVisible()
  await trace.getByRole('button', { name: 'Done' }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  const rows = (await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).inputValue())
    .split('\n')
    .map((line) => line.split(' ').map(Number))
  expect(rows[0][0]).toBeGreaterThan(900)
  expect(rows[0][0]).toBeLessThan(1100)
  expect(rows.at(-1)?.[0]).toBeGreaterThan(0.9e6)
  // On the line, 1 kHz is at y 73.3 px: 1 mΩ·10^(6·(250 − 73.3)/220) = 65.8 Ω; 1 MHz at 173.3 px:
  // 0.123 Ω. Between them it falls all the way.
  expect(rows[0][1]).toBeCloseTo(65.8, -1)
  expect((rows.at(-1)?.[1] ?? 0) / 0.123).toBeCloseTo(1, 0)
  for (let i = 1; i < rows.length; i++) expect(rows[i][1]).toBeLessThan(rows[i - 1][1])
})
