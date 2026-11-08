import { expect, test } from '@playwright/test'

test('save a sheet as a part, place it in another project, look inside, make a copy', async ({
  page,
  request,
}) => {
  await request.delete('/api/library/libraries/e2e-parts') // left by an interrupted run
  const maker = (await (await request.post('/api/projects', { data: { name: 'maker' } })).json()).id
  await request.post(`/api/projects/${maker}/commands`, {
    data: { command: { type: 'add_sheet', sheet: { name: 'esrcap' } } },
  })
  await request.post(`/api/projects/${maker}/circuit/import`, {
    data: { text: 'C1 p mid 22u\nR1 mid n 30m', sheet: 'esrcap' },
  })
  const doc = (await (await request.get(`/api/projects/${maker}/document`)).json()).project
  const cap = doc.sheets.find((s: { name: string }) => s.name === 'esrcap')
  const ports = cap.labels
    .filter((l: { text: string }) => ['p', 'n'].includes(l.text))
    .map((l: { text: string; at: number[] }) => ({ kind: 'port', text: l.text, at: l.at }))
  await request.post(`/api/projects/${maker}/commands`, {
    data: { command: { type: 'add_objects', sheet: 'esrcap', labels: ports } },
  })

  await page.goto(`/?project=${maker}`)
  await page.getByRole('tab', { name: 'esrcap' }).click()
  // The block's inspector: Save as a part… opens the part editor on its data.
  await page.getByRole('button', { name: 'Save as a part…' }).click()
  const editor = page.getByTestId('component-wizard')
  await editor.getByRole('textbox', { name: 'Part name' }).fill('E2ECAP22U')
  await editor.getByRole('textbox', { name: 'Library' }).fill('e2e-parts')
  await editor.getByLabel('Category').selectOption('Capacitors')
  await editor.getByRole('textbox', { name: /Rated voltage/ }).fill('25')
  await editor.getByRole('button', { name: 'Save to library' }).click()
  await expect(page.getByText('E2ECAP22U saved in library “e2e-parts”')).toBeVisible()

  // Another project: the part is in the library under Capacitors; placing it brings its circuit.
  const user = (await (await request.post('/api/projects', { data: { name: 'user' } })).json()).id
  await page.goto(`/?project=${user}`)
  await page.getByRole('textbox', { name: 'Search parts' }).fill('E2ECAP22U')
  await page
    .getByTestId('library-group-Capacitors')
    .getByRole('button', { name: /^E2ECAP22U/ })
    .click()
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 400, y: 300 } })
  await page.keyboard.press('Escape')
  const placed = async () => (await (await request.get(`/api/projects/${user}/document`)).json()).project
  await expect
    .poll(async () => (await placed()).sheets.map((s: { owner?: string }) => s.owner ?? null))
    .toEqual([null, 'cmp:e2e-parts/E2ECAP22U'])
  const part = (await placed()).sheets[0].instances[0]
  expect(part.ref).toBe('C1')
  const netlist = await (await request.get(`/api/projects/${user}/export/netlist`)).text()
  expect(netlist.toLowerCase()).toContain('.subckt sheet_e2ecap22u')

  // Inside the part: read-only until copied.
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate(
    (at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0],
    part.at,
  )
  await page.mouse.dblclick(x, y)
  await expect(page.getByText(/Library part E2ECAP22U · capacitor · v1/)).toBeVisible()
  await page.getByRole('button', { name: 'Make a copy' }).click()
  await expect(page.getByText(/Library part E2ECAP22U/)).toHaveCount(0)
  await request.delete('/api/library/libraries/e2e-parts')
})
