import { expect, test } from '@playwright/test'

test('markers: automatic -3 dB and peak, Alt+click on a trace, the delta of two', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'markers' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 AC 1\nR1 in out 1k\nC1 out 0 159.15n' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_simulation',
        simulation: { active: 'ac', cards: { op: '.op', ac: '.ac dec 50 10 1meg', tran: '.tran 10u 1m' } },
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 2')
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/AC · ok/)).toBeVisible({ timeout: 20_000 })

  await page.getByRole('button', { name: 'Markers' }).click()
  await page.getByRole('menuitem', { name: '-3 dB' }).click()
  const bar = page.getByTestId('plot-markers')
  await expect(bar).toContainText('M1')
  await expect(bar).toContainText(/1(\.0+)? kHz/) // fc = 1/(2π RC) = 1 kHz

  // Alt+click on the magnitude curve near 100 Hz (left part of the plot): a marker on the trace.
  const over = page.getByTestId('waveforms').locator('.u-over').first()
  const box = await over.boundingBox()
  if (!box) throw new Error('no plot')
  await page.mouse.move(box.x + box.width * 0.25, box.y + 20)
  const line = page.getByTestId('waveforms').locator('[data-testid="plot-crosshair"]:visible').first()
  const lineBox = await line.boundingBox()
  if (!lineBox) throw new Error('no crosshair')
  await over.click({ modifiers: ['Alt'], position: { x: box.width * 0.25, y: lineBox.y - box.y + 3 } })
  await expect(bar).toContainText('M2')
  await expect(bar).toContainText('M2−M1: Δ')
  // A plain click places cursor A (clicks used to be swallowed: the snapped cursor looked like a drag).
  await over.click({ position: { x: box.width * 0.5, y: 40 } })
  await expect(page.getByText('click: A, Shift+click: B', { exact: false })).toBeVisible()
  await page.getByRole('button', { name: 'Remove marker M1' }).click()
  await expect(bar).not.toContainText('M1 ')
})
