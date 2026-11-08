import { expect, test } from '@playwright/test'

test('symbol editor tab: shapes by clicks or by dragging, lines end cleanly, undo', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'drawing' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Draw a symbol/ }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  await expect(page.getByRole('tab', { name: 'Symbol editor' })).toBeVisible() // a tab, not a popup
  const canvas = editor.getByRole('application', { name: 'Symbol canvas' })
  const box = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const
  const rects = canvas.locator('rect')

  // Rectangle by two clicks: the second click ends it (it used to start a new one).
  await page.keyboard.press('r')
  await page.mouse.click(...at(0.3, 0.3))
  await page.mouse.move(...at(0.45, 0.45))
  await page.mouse.click(...at(0.45, 0.45))
  await expect(rects).toHaveCount(1)

  // Rectangle by dragging.
  await page.mouse.move(...at(0.55, 0.3))
  await page.mouse.down()
  await page.mouse.move(...at(0.65, 0.4), { steps: 5 })
  await page.mouse.up()
  await expect(rects).toHaveCount(2)

  // Undo takes the last one back.
  await page.keyboard.press('Control+z')
  await expect(rects).toHaveCount(1)

  // Line: clicks, then a double click ends it without extra points.
  await page.keyboard.press('l')
  await page.mouse.click(...at(0.3, 0.7))
  await page.mouse.click(...at(0.5, 0.7))
  await page.mouse.dblclick(...at(0.5, 0.85))
  const lines = canvas.locator('polyline')
  await expect(lines).toHaveCount(1)
  const points = (await lines.first().getAttribute('points'))?.trim().split(/\s+/) ?? []
  expect(points).toHaveLength(3)

  // Leaving with changes asks first.
  await editor.getByRole('button', { name: 'Close', exact: true }).click()
  await page.getByRole('button', { name: 'Close without saving' }).click()
  await expect(page.getByRole('tab', { name: 'Symbol editor' })).toHaveCount(0)
})

test('symbol editor: box selection moves several items together; texts have handles', async ({
  page,
  request,
}) => {
  const id = (await (await request.post('/api/projects', { data: { name: 'select' } })).json()).id
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.getByRole('button', { name: 'New part' }).click()
  await page.getByRole('menuitem', { name: /Draw a symbol/ }).click()
  const editor = page.getByRole('application', { name: 'Symbol editor' })
  const canvas = editor.getByRole('application', { name: 'Symbol canvas' })
  const box = (await canvas.boundingBox()) ?? { x: 0, y: 0, width: 0, height: 0 }
  const at = (fx: number, fy: number) => [box.x + box.width * fx, box.y + box.height * fy] as const
  await expect(canvas.getByTestId('handle-ref')).toBeVisible() // the reference text can be grabbed

  await page.keyboard.press('r')
  for (const [x, y] of [
    [0.3, 0.3],
    [0.5, 0.3],
  ]) {
    await page.mouse.click(...at(x, y))
    await page.mouse.click(...at(x + 0.08, y + 0.1))
  }
  await page.keyboard.press('s')
  // A box around both rectangles selects them; dragging one moves both.
  await page.mouse.move(...at(0.25, 0.25))
  await page.mouse.down()
  await page.mouse.move(...at(0.65, 0.45), { steps: 5 })
  await page.mouse.up()
  const rects = canvas.locator('rect.text-amber-400:not([data-testid])') // selected shapes, not handles
  await expect(rects).toHaveCount(2)
  const before = await canvas.locator('rect').evaluateAll((els) => els.map((e) => e.getAttribute('y')))
  await page.mouse.move(...at(0.3, 0.35))
  await page.mouse.down()
  await page.mouse.move(...at(0.3, 0.6), { steps: 5 })
  await page.mouse.up()
  const after = await canvas.locator('rect').evaluateAll((els) => els.map((e) => e.getAttribute('y')))
  expect(after.slice(0, 2)).not.toEqual(before.slice(0, 2))
  expect(after[0]).not.toEqual(before[0])
  expect(after[1]).not.toEqual(before[1])

  // Ctrl+A and Delete remove the drawing; Ctrl+Z brings it back.
  await page.keyboard.press('Control+a')
  await page.keyboard.press('Delete')
  await expect(canvas.locator('rect[fill="none"]:not([data-testid])')).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(canvas.locator('rect[fill="none"]:not([data-testid])')).toHaveCount(2)
})
