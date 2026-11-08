import { expect, test } from '@playwright/test'

test('a manufacturer model pasted in the inspector: checked in ngspice, a broken one says where', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'paste' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'V1 a 0 DC 1\nD1 a 0 DX' } })
  const doc = async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project
  const part = (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'D1')
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())
  const [x, y] = await page.evaluate(
    (at) => window.__bpt?.toScreen(at as [number, number]) ?? [0, 0],
    part.at,
  )
  await page.mouse.click(x, y)

  await page.getByRole('button', { name: 'Paste…' }).click()
  const dialog = page.getByTestId('paste-model')
  // A transistor's model does not fit a diode; a subcircuit that does not read says its line.
  await dialog
    .getByLabel('Model text')
    .fill(
      '.model QX NPN(IS=1f BF=100)\n.subckt BAD a b\nQ1 a b 0 NOSUCHMODEL\n.ends\n.model D1N4148 D(IS=2.52n N=1.752 RS=0.568)',
    )
  await dialog.getByRole('button', { name: 'Check' }).click()
  const items = dialog.getByTestId('paste-model-items')
  await expect(items).toContainText('line 3 of the text: Q1 a b 0 NOSUCHMODEL')
  await dialog.getByRole('radio', { name: /QX npn/ }).check()
  await expect(dialog).toContainText('a NPN model does not fit this part')
  await expect(dialog.getByRole('button', { name: 'Use for this part' })).toBeDisabled()
  await dialog.getByRole('radio', { name: /D1N4148 d/ }).check()
  await dialog.getByRole('button', { name: 'Use for this part' }).click()
  await expect(dialog).toHaveCount(0)
  await expect
    .poll(
      async () => (await doc()).sheets[0].instances.find((i: { ref: string }) => i.ref === 'D1').model.model,
    )
    .toBe('D1N4148')
  expect(Object.keys((await doc()).models)).toContain('D1N4148')
})
