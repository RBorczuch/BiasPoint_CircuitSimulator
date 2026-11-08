/**
 * Screenshots of key views for visual checks by agents (`pnpm e2e:shots`), compared with the
 * approved baselines in e2e/shots.spec.ts-snapshots/. Update with `pnpm e2e:shots --update-snapshots`.
 */
import { expect, test } from '@playwright/test'

const CE_AMP = `VCC vcc 0 DC 12
VIN sig 0 DC 0 AC 1
CIN sig b 10u
R1 vcc b 47k
R2 b 0 10k
RC vcc c 4.7k
RE e 0 1k
Q1 c b e NPN`

for (const theme of ['dark', 'light'] as const) {
  test(`editor ${theme}`, async ({ page, request }) => {
    const id = (await (await request.post('/api/projects', { data: { name: 'shots' } })).json()).id
    await request.post(`/api/projects/${id}/circuit/import`, { data: { text: CE_AMP } })
    await page.addInitScript((t) => localStorage.setItem('bpt.theme', t), theme)
    await page.goto(`/?project=${id}`)
    await expect(page.locator('footer')).toContainText('rev 1')
    await page.evaluate(() => window.__bpt?.fit())
    await page.mouse.move(5, 5) // keep the canvas cursor out of the picture
    await expect(page).toHaveScreenshot(`editor-${theme}.png`, { mask: [page.locator('footer')] })
  })
}
