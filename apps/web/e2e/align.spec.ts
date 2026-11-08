import { expect, test } from '@playwright/test'

test('align parts through the Edit menu; wires and labels follow, the circuit stays the same', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'align' } })).json()).id
  // R1 at y 0, R2 one grid row lower, joined by a wire; labels on their outer pins.
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'root',
        instances: [
          { ref: 'R1', symbol: 'bpt:resistor', at: [0, 0] },
          { ref: 'R2', symbol: 'bpt:resistor', at: [1270, 254] },
        ],
        wires: [
          {
            points: [
              [0, 381],
              [635, 381],
              [635, -127],
              [1270, -127],
            ],
          },
        ],
        labels: [
          { text: 'a', at: [0, -381] },
          { text: 'b', at: [1270, 635] },
        ],
      },
    },
  })
  const netlist = async () => (await request.get(`/api/projects/${id}/export/netlist`)).text()
  const before = await netlist()
  expect(before).toMatch(/^R1 a (\S+) 1k$/m)
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText(/rev [1-9]/)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 5, y: 5 } })
  await page.keyboard.press('Control+a')
  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('menuitem', { name: 'Align top edges' }).click()
  await expect
    .poll(async () => {
      const sheet = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
      return sheet.instances.map((i: { at: number[] }) => i.at[1])
    })
    .toEqual([0, 0])
  expect(await netlist()).toBe(before)
})
