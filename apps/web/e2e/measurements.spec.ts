import { expect, test } from '@playwright/test'

const LCR = `# LCR meter export
Frequency [kHz];|Z| [mOhm];Phase [deg]
1,0;15900;-89,2
10,0;1590;-88,7
100,0;170;-80,1
`

test('measured points: a CSV with units in its headers, a measurement file opened and saved', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'measure' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: /New part/ }).click()
  const wizard = page.getByTestId('component-wizard')
  await wizard.getByRole('combobox', { name: 'Model' }).selectOption('mlcc')
  await wizard.getByRole('tab', { name: '|Z|(f)', exact: true }).click()

  // The CSV: semicolons, decimal commas, kHz and mOhm in the headers.
  await wizard
    .getByLabel('CSV file')
    .setInputFiles({ name: 'lcr.csv', mimeType: 'text/csv', buffer: Buffer.from(LCR) })
  const dialog = page.getByTestId('csv-import')
  await expect(dialog).toContainText('3 rows, semicolon between columns, decimal comma')
  await expect(dialog.getByLabel('X column')).toHaveValue('0')
  await dialog.getByRole('button', { name: 'Use 3 points' }).click()
  await wizard.getByRole('button', { name: 'Text', exact: true }).click()
  const text = await wizard.getByRole('textbox', { name: 'Points |Z|(f)' }).inputValue()
  const first = text.split('\n')[0].split(' ').map(Number)
  expect(first[0]).toBeCloseTo(1000, 6) // kHz to Hz
  expect(first[1]).toBeCloseTo(15.9, 6) // mOhm to Ohm

  // A measurement file with its |Z|(f) and C(V) points.
  const measurement = {
    format: 'bptm',
    version: 1,
    name: 'sample 3',
    characteristics: [
      {
        name: '|Z|(f)',
        points: [
          [1000, 16],
          [100000, 0.2],
        ],
      },
      {
        name: 'C(V)',
        points: [
          [0, 1e-5],
          [10, 4e-6],
        ],
      },
    ],
  }
  await wizard.getByLabel('Measurement file').setInputFiles({
    name: 's3.bptm.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(measurement)),
  })
  await expect(page.getByText(/Measured points of \|Z\|\(f\), C\(V\)/)).toBeVisible()
  await expect(wizard.getByRole('textbox', { name: 'Points |Z|(f)' })).toHaveValue(/^1000 16\n/)
  await expect(wizard.getByRole('textbox', { name: 'Where the |Z|(f) points come from' })).toHaveValue(
    'measurement sample 3',
  )

  const download = page.waitForEvent('download')
  await wizard.getByRole('button', { name: 'Save as measurement…' }).click()
  const saved = JSON.parse(
    await (await (await download).createReadStream()).toArray().then((b) => Buffer.concat(b).toString()),
  )
  expect(saved.format).toBe('bptm')
  expect(saved.characteristics.map((c: { name: string }) => c.name)).toEqual(
    expect.arrayContaining(['|Z|(f)', 'C(V)']),
  )
})
