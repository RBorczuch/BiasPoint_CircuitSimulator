import { expect, type Page, test } from '@playwright/test'

type Point = [number, number]

async function clickWorld(page: Page, p: Point): Promise<void> {
  await page.waitForFunction(() => window.__bpt !== undefined)
  const [x, y] = await page.evaluate((world) => window.__bpt?.toScreen(world as Point) ?? [0, 0], p)
  await page.mouse.click(x, y)
}

test('wire angle: Shift+Space switches to 45°, the wire runs straight then diagonally', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'wires' } })).json()).id
  await page.addInitScript(() => localStorage.removeItem('bpt.settings'))
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 0') // the project is loaded
  await page.keyboard.press('W')
  await page.keyboard.press('Shift+Space')
  await expect(page.getByText('Wire: 45°')).toBeVisible()
  await clickWorld(page, [0, 0])
  await clickWorld(page, [1270, 508])
  await clickWorld(page, [1270, 508]) // a second click on the same point ends the wire
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return doc.project.sheets[0].wires.map((w: { points: Point[] }) => w.points)
    })
    .toEqual([
      [
        [0, 0],
        [762, 0],
        [1270, 508],
      ],
    ])
})
