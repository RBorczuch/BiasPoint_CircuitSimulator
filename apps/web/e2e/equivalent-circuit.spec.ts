import { expect, test } from '@playwright/test'

test('an op-amp and a transformer get characteristics, shown beside the enlarged equivalent circuit', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'multipin' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  const template = wizard.getByRole('combobox', { name: 'Model' })

  await template.selectOption('tpl:Standard templates/Op-amp macromodel')
  const tabs = wizard.getByRole('tablist', { name: 'Characteristics' })
  for (const name of ['Aol(f)', 'Aol phase(f)', 'Vout(Vin)', 'Vout(t)'])
    await expect(tabs.getByRole('tab', { name, exact: true })).toBeVisible()
  // The drawing names the parts by what they do, not by the long expressions inside.
  await expect(wizard.getByTestId('template-circuit')).toContainText('I = gm·Vd')
  await wizard.getByTestId('template-circuit').click()
  const dialog = page.getByRole('dialog', { name: /Equivalent circuit/ })
  await expect(dialog.getByTestId('circuit-big')).toContainText('31.83 MΩ')
  await dialog.getByRole('tab', { name: 'Vout(Vin)', exact: true }).click()
  await expect(dialog.getByTestId('chart-Vout(Vin)')).toBeVisible()
  await page.keyboard.press('Escape')

  await template.selectOption('tpl:Standard templates/Real transformer')
  await expect(tabs.getByRole('tab', { name: 'Ratio(f)', exact: true })).toBeVisible()
  await tabs.getByRole('tab', { name: '|Zin|(f)', exact: true }).click()
  // Two curves: the secondary open (magnetizing) and shorted (leakage).
  await expect(wizard.getByTestId('chart-|Zin|(f)')).toContainText('secondary shorted')
  await expect(wizard.getByTestId('template-circuit')).toContainText('R core')
})
