import { expect, test } from '@playwright/test'

test('K17: a B source switched between a voltage and a current output in the inspector', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'bsource' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'B1 out 0 V=2*time\nR1 out 0 1k' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const b1 = () => doc().then((p) => p.sheets[0].instances.find((i: { ref: string }) => i.ref === 'B1'))
  const [x, y] = await page.evaluate(
    (p) => window.__bpt?.toScreen(p) ?? [0, 0],
    (await b1()).at as [number, number],
  )
  await page.mouse.click(x, y)

  const output = page.getByLabel('Behavioral output')
  await expect(output).toHaveValue('v')
  await expect(page.getByLabel('Voltage expression')).toHaveValue('2*time')
  await output.selectOption('i')
  await expect.poll(async () => (await b1()).model.params).toEqual({ i: '2*time' })
  await page.getByLabel('Current expression').fill('V(out)/2k')
  await page.keyboard.press('Enter')
  await expect.poll(async () => (await b1()).model.params.i).toBe('V(out)/2k')
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^B1 out 0 I=\{?V\(out\)\/2k\}?/im)
  await output.selectOption('v')
  await expect.poll(async () => (await b1()).model.params).toEqual({ v: 'V(out)/2k' })
})

test('K7: an electrolytic from the catalogue maxima (tan δ, Z at 100 kHz, leakage)', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'electrolytic' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('electrolytic')
  await wizard.getByRole('textbox', { name: 'C', exact: true }).fill('220u')
  // Nichicon UPW1E221MPD: tan δ 0.14, Z 0.117 Ω at 100 kHz, 165 µA after a minute at 25 V.
  const values = wizard.getByTestId('electrolytic-values')
  await values.getByLabel('tan δ').fill('0.14')
  await values.getByLabel('Z at 100 kHz').fill('0.117')
  await values.getByLabel('Leakage current').fill('165u')
  await values.getByLabel('Rated voltage').fill('25')
  await expect(values).toContainText('ESR at 120 Hz: 0.844 Ω')
  await values.getByRole('button', { name: 'Apply' }).click()
  await expect(wizard.getByRole('textbox', { name: 'ESR (HF)', exact: true })).toHaveValue('117m')
  await expect(wizard.getByRole('textbox', { name: 'ESR rise', exact: true })).toHaveValue('737m')
  await expect(wizard.getByRole('textbox', { name: 'R leak', exact: true })).toHaveValue('152k')
})

test('K8: an MLCC DC bias curve typed in ΔC % turned into capacitance', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'mlcc' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('textbox', { name: 'C', exact: true }).fill('10u')
  await wizard.getByRole('tab', { name: /^C\(V\)/ }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  const points = wizard.getByRole('textbox', { name: 'Points C(V)' })
  await points.fill('0 0\n6.3 -50%\n10 -70')
  await wizard.getByRole('button', { name: 'ΔC % → F' }).click()
  await expect(points).toHaveValue('0 10u\n6.3 5u\n10 3u')
})

test('K10: values fitted to one curve only, in a pass of their own', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'passes' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('tab', { name: /^\|Z\|\(f\)/ }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).fill('1k 16\n100k 0.16\n10meg 0.03')
  await wizard.getByRole('tab', { name: /^ESR\(f\)/ }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click() // the points as text
  await wizard.getByRole('textbox', { name: 'Points ESR(f)' }).fill('100k 0.01\n1meg 0.005')
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/components/templates/fit'))
  await wizard.getByRole('button', { name: 'Fit to ESR(f) only' }).click()
  const body = (await sent).postDataJSON()
  expect(body.characteristics.map((c: { name: string }) => c.name)).toEqual(['ESR(f)'])
  await expect(page.getByText(/Fitted in \d+ steps/)).toBeVisible()
})

/** A two-page PDF (200 × 150 pt), the second page a chart: a frame and a curve. */
function chartPdf(): Buffer {
  const pages = [
    'BT /F1 12 Tf 20 120 Td (Datasheet) Tj ET',
    '2 w 20 15 160 120 re S 1 0 0 RG 20 15 m 180 135 l S',
  ]
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    ...pages.flatMap((text, k) => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150] /Contents ${4 + 2 * k} 0 R /Resources << /Font << /F1 7 0 R >> >> >>`,
      `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    ]),
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let out = '%PDF-1.4\n'
  const offsets = objects.map((body, k) => {
    const at = out.length
    out += `${k + 1} 0 obj\n${body}\nendobj\n`
    return at
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

test('K12: a chart traced from a PDF page, its axes on the found frame', async ({ page, request }) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'pdf' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('tab', { name: /^C\(V\)/ }).click()
  await wizard.getByRole('button', { name: 'Trace a picture…' }).first().click()

  // The picture takes the chart's place.
  const trace = wizard.getByTestId('picture-trace')
  await trace.getByLabel('Datasheet picture or PDF').setInputFiles({
    name: 'datasheet.pdf',
    mimeType: 'application/pdf',
    buffer: chartPdf(),
  })
  await expect(trace.getByTestId('pdf-pages')).toContainText('page 1 / 2')
  await trace.getByRole('button', { name: 'Next page' }).click()
  await expect(trace.getByTestId('pdf-pages')).toContainText('page 2 / 2')
  // The frame sits on the chart's axes: x 20 and 180 pt, y 15 and 135 pt from the bottom, at
  // 2 px per pt.
  const edge = (name: string, attr: string) =>
    trace.getByTestId(`trace-edge-${name}`).evaluate((l, a) => Number(l.getAttribute(a)), attr)
  // (within a pixel: the line's middle)
  await expect.poll(async () => Math.round(await edge('left', 'x1'))).toBe(40)
  expect(Math.round(await edge('right', 'x1'))).toBe(360)
  expect(Math.round(await edge('bottom', 'y1'))).toBe(270)
  expect(Math.round(await edge('top', 'y1'))).toBe(30)
  await expect(trace.getByRole('button', { name: 'Points', exact: true })).toBeDisabled() // not calibrated yet
  await trace.getByLabel('X at the left edge').fill('0')
  await trace.getByLabel('X at the right edge').fill('10')
  await trace.getByLabel('Y at the bottom edge').fill('0')
  await trace.getByLabel('Y at the top edge').fill('100u')
  await expect(trace.getByTestId('trace-grid').locator('line').first()).toBeAttached() // the control grid

  // The middle of the frame (page 100, 75 pt; pixel 200, 150) is 5 V, 50 µF.
  const chart = trace.getByRole('application', { name: /Datasheet chart/ })
  const box = await chart.boundingBox()
  if (!box) throw new Error('no picture')
  await page.mouse.click(box.x + (200 * box.width) / 400, box.y + (150 * box.height) / 300)
  await expect(trace.getByTestId('trace-point')).toHaveCount(1)
  await trace.getByRole('button', { name: 'Done' }).click()
  // The point is a row of the points table, straight away.
  const x = Number(await wizard.getByRole('textbox', { name: 'Point 1 x' }).inputValue())
  const y = Number(await wizard.getByRole('textbox', { name: 'Point 1 y' }).inputValue())
  expect(x).toBeCloseTo(5, 1)
  expect(y / 1e-6).toBeCloseTo(50, 0)
})
