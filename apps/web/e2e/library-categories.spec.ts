import { expect, test } from '@playwright/test'

test('parts in categories: a transistor found in the tree, its card on hover, filters by data and origin', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'categories' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)

  // Ś2: Transistors → BJT NPN → BC547B (the ideal NPN first, standard parts after it).
  const npn = page.getByTestId('library-group-Transistors/BJT NPN')
  await expect(npn.getByRole('button', { name: /^NPN transistor/ })).toBeVisible()
  const bc547 = page.getByTestId('part-BC547B')
  await expect(bc547).toContainText('Diotec')
  await bc547.hover()
  const card = page.getByTestId('part-card')
  await expect(card).toContainText('Transistors/BJT NPN')
  await expect(card).toContainText('VCEO')
  await expect(card).toContainText('45 V')
  await page.mouse.move(700, 500)

  // A template sits in its category: a new MLCC from a datasheet.
  await page
    .getByTestId('library-group-Capacitors/Ceramic')
    .getByRole('button', { name: /^Ceramic/ })
    .click()
  await expect(page.getByTestId('template-MLCC class 2 (DC bias)')).toBeVisible()

  // Filter by data: ceramic capacitors with an X7R dielectric.
  await page.getByRole('button', { name: 'Filter by data' }).click()
  await page.getByLabel('Filter category').selectOption('Capacitors/Ceramic')
  await page.getByTestId('library-filters').getByRole('button', { name: 'X7R' }).click()
  const results = page.getByTestId('library-results')
  await expect(results).toContainText('CL10B104KB85PNC')
  await expect(results).not.toContainText('CL21A106KAYNNNG') // X5R
  // A range of rated voltage (SPICE suffixes accepted): only the 50 V part is above 30 V.
  await page.getByTestId('library-filters').getByRole('button', { name: 'X7R' }).click()
  await page.getByLabel('Rated voltage from').fill('30')
  await expect(results).toContainText('CL10B104KB85PNC')
  await expect(results).not.toContainText('CL21A106KAYNNNG') // 25 V
  await page.getByRole('button', { name: 'Filter by data' }).click()

  // Origin: only the ideal parts.
  await page.getByRole('button', { name: 'Ideal', exact: true }).click()
  await expect(page.getByTestId('part-BC547B')).toHaveCount(0)
  await expect(page.getByTestId('part-Resistor')).toBeVisible()
})
