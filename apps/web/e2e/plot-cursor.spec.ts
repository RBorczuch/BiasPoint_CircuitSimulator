import { expect, type Page, test } from '@playwright/test'

/** The crosshair goes through the curve under the mouse: the vertical line at the mouse x,
 *  the horizontal one through the curve's point (KiCad / Qucs-S / LTspice do the same). */
async function expectAligned(page: Page, root: string) {
  for (const frac of [0.3, 0.7]) {
    const box = await page.locator(`${root} .u-over`).first().boundingBox()
    if (!box) throw new Error('no plot')
    const mx = box.x + box.width * frac
    await page.mouse.move(mx, box.y + box.height / 2)
    await page.waitForTimeout(150)
    const vline = await page.locator(`${root} .u-cursor-x`).first().boundingBox()
    const hline = await page.locator(`${root} .u-cursor-y`).first().boundingBox()
    const point = await page.locator(`${root} .u-cursor-pt`).first().boundingBox()
    if (!vline || !hline || !point) throw new Error('no cursor')
    expect(Math.abs(vline.x - mx)).toBeLessThan(3) // a sample is at most a pixel or two away
    expect(Math.abs(hline.y - (point.y + point.height / 2))).toBeLessThan(2)
  }
}

test('plot cursor follows the mouse in a graph node at any zoom and in full screen', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/library/examples/rc_lowpass/open')).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Transient plot' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('F5')
  await expect(page.locator('.react-flow__node .u-over')).toBeVisible({ timeout: 30_000 })
  await expectAligned(page, '.react-flow__node') // the canvas is zoomed to fit (not 100 %)
  await page.getByRole('button', { name: 'Zoom Out' }).click()
  await page.getByRole('button', { name: 'Zoom Out' }).click()
  await page.waitForTimeout(300)
  await expectAligned(page, '.react-flow__node')
  await expect(page.getByTestId('plot-readout').first()).toContainText('V(out)')
  await page.getByRole('button', { name: 'Full screen' }).first().click()
  await expectAligned(page, '[data-testid="plot-viewer"]')
})

test('crosshairs: a line with the value where the cursor crosses each trace', async ({ page, request }) => {
  const id = (await (await request.post('/api/library/examples/rc_lowpass/open')).json()).id
  await page.goto(`/?project=${id}`)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Transient plot' }).click()
  await page.getByRole('dialog').getByRole('button', { name: 'OK' }).click()
  await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } })
  await page.keyboard.press('F5')
  const over = page.locator('.react-flow__node .u-over').first()
  await expect(over).toBeVisible({ timeout: 30_000 })
  const box = await over.boundingBox()
  if (!box) throw new Error('no plot')
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2)
  const line = page.locator('.react-flow__node [data-testid="plot-crosshair"]:visible').first()
  await expect(line).toBeVisible()
  await expect(line).toContainText(/\d.*V$/) // the value of V(out) with its unit
})
