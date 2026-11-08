import { cpSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'

test('unsaved work left by a backend restart is offered back and restored', async ({ page, request }) => {
  const root = process.env.BPT_RECOVERY_DIR as string
  const id = (await (await request.post('/api/projects', { data: { name: 'lost work' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'R7 a 0 4k7' } })
  await expect.poll(() => existsSync(join(root, id, 'recovery.json')), { timeout: 10_000 }).toBe(true)

  // What a crash leaves behind: the autosave copy without the open project.
  const kept = mkdtempSync(join(tmpdir(), 'bpt-e2e-copy-'))
  cpSync(join(root, id), kept, { recursive: true })
  await request.delete(`/api/projects/${id}`)
  cpSync(kept, join(root, id), { recursive: true })

  await page.goto(`/?project=${id}`)
  const dialog = page.getByRole('dialog', { name: 'Restore unsaved projects' })
  await expect(dialog).toContainText('“lost work”')
  await dialog.getByRole('button', { name: 'Restore' }).click()
  await expect(page.getByText(/^Restored lost work/)).toBeVisible()
  const projects = await (await request.get('/api/projects')).json()
  expect(projects.find((p: { id: string }) => p.id === id)?.dirty).toBe(true)
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^R7 .* 4.7k$/m)
  await request.delete(`/api/projects/${id}`)
})
