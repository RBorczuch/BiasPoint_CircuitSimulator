import { expect, test } from '@playwright/test'

test("a selected part's texts can be dragged and turned; rotating the part keeps them around it", async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'texts' } })).json()).id
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'root',
        instances: [{ ref: 'R1', symbol: 'bpt:resistor', at: [0, 0] }],
        labels: [{ text: 'out', kind: 'global', at: [1270, 0], rot: 90 }],
      },
    },
  })
  const r1 = async () => {
    const { project } = await (await request.get(`/api/projects/${id}/document`)).json()
    return project.sheets[0].instances[0]
  }
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.evaluate(() => window.__bpt?.fit())

  // Select the part, then drag its reference (the symbol puts it right of the body).
  const body = await page.evaluate(() => window.__bpt?.toScreen([0, 0]) ?? [0, 0])
  await page.mouse.click(body[0], body[1])
  const ref = await page.evaluate(() => window.__bpt?.toScreen([210, -64]) ?? [0, 0])
  await page.mouse.move(ref[0], ref[1])
  await page.mouse.down()
  await page.mouse.move(ref[0] + 40, ref[1] - 60, { steps: 6 })
  await page.keyboard.press('r') // turns the text being dragged, not the part
  await page.mouse.up()
  await expect.poll(async () => (await r1()).texts?.ref?.rot).toBe(90)
  const moved = (await r1()).texts.ref.at
  expect(moved[1]).toBeLessThan(-200) // went up
  expect((await r1()).rot).toBe(0) // the part did not turn

  await expect(page.locator('footer')).toContainText('rev 2') // the editor has the new place
  // Rotating the part turns the hand-placed offset with it.
  await page.mouse.click(body[0], body[1])
  await page.keyboard.press('r')
  await expect.poll(async () => (await r1()).rot).toBe(90)
  const turned = (await r1()).texts.ref.at
  expect(turned).toEqual([-moved[1], moved[0]])

  // The inspector puts it back where the symbol has it.
  await page.getByRole('button', { name: 'Placement' }).click()
  await page.getByRole('button', { name: 'Reset the reference text' }).click()
  await expect.poll(async () => (await r1()).texts?.ref).toBeUndefined()
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await r1()).texts?.ref).toBeDefined()
})
