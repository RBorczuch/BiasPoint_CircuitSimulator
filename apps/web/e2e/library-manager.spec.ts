import { expect, test } from '@playwright/test'

test('Ś12: libraries managed in one window: create, move, copy a standard part, recategorise', async ({
  page,
  request,
}) => {
  for (const name of ['e2e-lm-a', 'e2e-lm-b', 'e2e-lm-c'])
    await request.delete(`/api/library/libraries/${name}`)
  const body = { template: 'electrolytic', form: { Cnom: '47u' }, library: 'e2e-lm-a', name: 'E47U' }
  expect((await request.post('/api/components/from-template', { data: body })).ok()).toBe(true)
  const id = (await (await request.post('/api/projects', { data: { name: 'libraries' } })).json()).id
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev/)

  // New → Manage libraries…: a new library made in the window.
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: 'Manage libraries…' }).click()
  const manager = page.getByTestId('library-manager')
  await manager.getByRole('textbox', { name: 'New library name' }).fill('e2e-lm-b')
  await manager.getByRole('button', { name: 'Create' }).click()
  await expect(manager.getByRole('button', { name: 'e2e-lm-b' })).toHaveAttribute('aria-pressed', 'true')

  // Move the part from library a to b (two clicks after choosing it).
  await manager.getByRole('button', { name: 'e2e-lm-a' }).click()
  await manager.getByRole('checkbox', { name: 'Select E47U' }).check()
  await manager.getByLabel('Target library').fill('e2e-lm-b')
  await manager.getByRole('button', { name: 'Move', exact: true }).click()
  await expect(manager.getByText('Empty.')).toBeVisible()
  const parts = async () => Object.keys(await (await request.get('/api/library/components')).json())
  expect(await parts()).toContain('cmp:e2e-lm-b/E47U')
  expect(await parts()).not.toContain('cmp:e2e-lm-a/E47U')

  // Its category changed for the whole library.
  await manager.getByRole('button', { name: 'e2e-lm-b' }).click()
  await manager.getByRole('checkbox', { name: 'Select E47U' }).check()
  await manager.getByLabel('New category').selectOption('Capacitors/Film')
  await manager.getByRole('button', { name: 'Set category' }).click()
  await expect(manager.getByRole('row', { name: /E47U/ })).toContainText('Capacitors/Film')

  // A standard part is copied (the standard library stays read-only: no Move there).
  const standard = manager.getByRole('button', { name: /^Standard parts/ })
  await standard.click()
  await expect(manager.getByRole('button', { name: 'Move', exact: true })).toHaveCount(0)
  await manager.getByRole('checkbox', { name: 'Select 1N4148' }).check()
  await manager.getByLabel('Target library').fill('e2e-lm-b')
  await manager.getByRole('button', { name: 'Copy' }).click()
  await expect.poll(parts).toContain('cmp:e2e-lm-b/1N4148')

  // Rename the library: its items follow.
  await manager.getByRole('button', { name: 'e2e-lm-b' }).click()
  await manager.getByRole('button', { name: 'Rename…' }).click()
  await manager.getByRole('textbox', { name: 'Library name', exact: true }).fill('e2e-lm-c')
  await manager.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(parts).toContain('cmp:e2e-lm-c/E47U')
  await expect(manager.getByRole('row', { name: /1N4148/ })).toBeVisible()

  for (const name of ['e2e-lm-a', 'e2e-lm-b', 'e2e-lm-c'])
    await request.delete(`/api/library/libraries/${name}`)
})
