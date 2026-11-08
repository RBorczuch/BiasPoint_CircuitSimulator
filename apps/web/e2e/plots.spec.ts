import { expect, test } from '@playwright/test'

test('plot axes, XY, full screen and SVG export', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'plots' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 0 AC 1 PULSE(0 1 0 1n 1n 2m 4m)\nR1 in out 1k\nC1 out 0 1u' },
  })
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_simulation',
        simulation: {
          active: 'tran',
          cards: { op: '.op', dc: '.dc V1 0 1 0.1', ac: '.ac dec 20 10 1meg', tran: '.tran 10u 8m' },
        },
      },
    },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 2')
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })
  // The labelled nets are plotted right away (ST-26); a current is added from the signal browser.
  await expect(page.getByRole('button', { name: 'V(in)', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible()
  await page.getByTitle(/Add signal/).click()
  await page.getByPlaceholder(/Signal or expression/).fill('I(R1)')
  await page.getByRole('option', { name: 'I(R1)', exact: true }).click()
  await expect(page.getByTestId('waveforms').locator('canvas')).toHaveCount(1)

  // Full screen and back.
  await page.getByTitle('Full screen').click()
  await expect(page.getByTitle(/Exit full screen/)).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTitle('Full screen')).toBeVisible()

  // AC: I(R1) is derived from the node voltages (ngspice has no R currents in AC); Bode: two panes.
  await page.getByRole('button', { name: 'AC', exact: true }).nth(1).click()
  await page.getByRole('button', { name: /Run F5/ }).click()
  await expect(page.getByText(/AC · ok/)).toBeVisible({ timeout: 20_000 })
  await expect(page.getByTestId('waveforms').locator('canvas')).toHaveCount(2)
  await expect(page.getByTitle('Not available in this run')).toHaveCount(0)

  const download = page.waitForEvent('download')
  await page.getByTitle('Export plot').click()
  await page.getByRole('menuitem', { name: /SVG, light/ }).click()
  const file = await (await download).path()
  const svg = await (await import('node:fs/promises')).readFile(file, 'utf8')
  expect(svg).toContain('Frequency [Hz]')
  expect(svg).toContain('Phase [°]')
  expect(svg).toContain('>I(R1)<')
})
