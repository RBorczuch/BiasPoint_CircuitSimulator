/** Regression tests for problems found by the UI stress tests (StessTests.md, ST-xx). */
import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

async function project(request: APIRequestContext, name: string, netlist = ''): Promise<string> {
  const id = (await (await request.post('/api/projects', { data: { name } })).json()).id
  if (netlist) await request.post(`/api/projects/${id}/circuit/import`, { data: { text: netlist } })
  return id
}

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/?project=${id}`)
  await page.waitForFunction(() => window.__bpt !== undefined)
  await page.waitForTimeout(300) // the first fit-to-view happens just after load
}

async function worldClick(page: Page, p: [number, number]): Promise<void> {
  const [x, y] = await page.evaluate((w) => {
    if (!window.__bpt) throw new Error('editor not ready')
    return window.__bpt.toScreen(w as [number, number])
  }, p)
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
}

const RC = 'V1 in 0 DC 1 AC 1\nR1 in out 1k\nC1 out 0 1u'

test('ST-01: the analysis chosen in the panel is what F5 runs', async ({ page, request }) => {
  await open(page, await project(request, 'st01', RC))
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.getByRole('button', { name: 'TRAN', exact: true }).nth(1).click()
  await page.keyboard.press('F5')
  await expect(page.getByText(/TRAN · ok/)).toBeVisible({ timeout: 20_000 })
})

test('ST-07: undo past the start of history stays quiet', async ({ page, request }) => {
  await open(page, await project(request, 'st07', RC))
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z')
  await expect(page.locator('footer')).toContainText('rev 2')
  await expect(page.getByText('nothing to undo')).toHaveCount(0)
})

test('ST-08: a new project asks about unsaved changes', async ({ page, request }) => {
  await open(page, await project(request, 'st08', RC)) // the import is an unsaved change
  await page.keyboard.press('Control+n')
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByText('Unsaved changes')).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(page.locator('header')).toContainText('st08')
  await page.keyboard.press('Control+n')
  await page.getByRole('dialog').getByRole('button', { name: "Don't save" }).click()
  await expect(page.getByRole('dialog').getByText('New project')).toBeVisible()
})

test('ST-15: a run stopped by ERC says what to fix', async ({ page, request }) => {
  await open(page, await project(request, 'st15', 'V1 a b DC 1\nR1 a b 1k'))
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5')
  await expect(page.getByText('Not simulated – fix the circuit first:')).toBeVisible()
  await expect(page.getByText(/Add a ground symbol/).first()).toBeVisible()
})

test('ST-02/ST-05: Esc leaves the label tool; E edits the value', async ({ page, request }) => {
  const id = await project(request, 'st05', RC)
  await open(page, id)
  const sheet = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
  const r1 = sheet.instances.find((i: { ref: string }) => i.ref === 'R1')
  await page.keyboard.press('l')
  await page.getByRole('dialog').getByRole('textbox').fill('n1')
  await page.keyboard.press('Enter')
  await worldClick(page, [r1.at[0] + 1270, r1.at[1]])
  await page.keyboard.press('Escape') // right away, while the label is still being added
  await expect(page.locator('footer')).toContainText('rev 2')
  await expect(page.locator('footer')).toContainText('select ·')

  await worldClick(page, r1.at)
  await page.keyboard.press('e')
  await expect(page.getByRole('textbox', { name: 'R', exact: true })).toBeFocused()
})

test('ST-23: node search finds the node by its name', async ({ page, request }) => {
  const id = await project(request, 'st23', RC)
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_graph',
        name: 'g',
        graph: { name: 'g', nodes: [{ id: 'c', type: 'core/circuit', pos: [0, 0] }], edges: [] },
      },
    },
  })
  await open(page, id)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Node', exact: true }).click()
  await page.getByPlaceholder(/Add node/).fill('measure')
  await page.keyboard.press('Enter')
  await expect(page.locator('.react-flow__node').filter({ hasText: 'Measure' })).toHaveCount(1)
})

test('ST-26/27: results are visible right after a run', async ({ page, request }) => {
  await open(page, await project(request, 'st27', RC))
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.keyboard.press('F5') // OP: a table, there is no schematic here to annotate
  await expect(page.getByTestId('op-table')).toContainText('V(out)')
  await page.getByRole('button', { name: 'TRAN', exact: true }).nth(1).click()
  await page.keyboard.press('F5') // waveforms: the labelled nets are plotted without asking
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible({ timeout: 20_000 })
})

test('ST-28/29/30: drag keeps wires, source form, duplicate reference', async ({ page, request }) => {
  const id = await project(request, 'st28', 'V1 in 0 DC 5\nR1 in out 1k\nR2 out 0 2k')
  await open(page, id)
  const describe = async () => (await (await request.get(`/api/projects/${id}/circuit/describe`)).json()).text
  const sheet = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
  const at = (ref: string) => sheet.instances.find((i: { ref: string }) => i.ref === ref).at
  const screen = (p: number[]) =>
    page.evaluate((w) => window.__bpt?.toScreen(w as [number, number]) ?? [0, 0], p)

  // ST-28: a plain drag moves the part with its wires.
  const [x, y] = await screen(at('R2'))
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 60, y + 30, { steps: 6 })
  await page.mouse.up()
  await expect.poll(describe).toContain('R2 out 0 2k')

  // ST-30: a reference that is taken is refused with an explanation.
  await page.keyboard.press('e')
  const reference = page.getByRole('textbox', { name: 'Reference' })
  await reference.fill('R1')
  await expect(page.getByText('R1 is already used by another part')).toBeVisible()
  await reference.press('Enter')
  await expect.poll(describe).toContain('R2 out 0 2k')

  // ST-29: a pulse source from the form, values with units.
  await worldClick(page, at('V1'))
  await page.getByRole('combobox', { name: 'Transient waveform' }).selectOption('pulse')
  const period = page.getByRole('textbox', { name: 'Period' })
  await period.fill('2 ms')
  await period.press('Enter')
  await expect.poll(describe).toContain('PULSE(0 1 0 1u 1u 0.5m 2m)')
})

test('ST-32: undo works in the Analysis workspace', async ({ page, request }) => {
  const id = await project(request, 'st32', RC)
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'set_graph',
        name: 'g',
        graph: {
          name: 'g',
          nodes: [
            { id: 'c', type: 'core/circuit', pos: [0, 0] },
            { id: 'm', type: 'measure/basic', pos: [400, 0] },
          ],
          edges: [],
        },
      },
    },
  })
  await open(page, id)
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  const measure = page.locator('.react-flow__node').filter({ hasText: 'Measure' })
  await measure
    .locator('span', { hasText: /^Measure$/ })
    .first()
    .click()
  await page.keyboard.press('Delete')
  await expect(measure).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(measure).toHaveCount(1)
})

test('send a marked screenshot to the agent; the agent can capture the plot', async ({ page, request }) => {
  const id = await project(request, 'agent', RC)
  await open(page, id)
  await page.keyboard.press('F9')
  const shot = page.getByTestId('agent-shot')
  await expect(shot).toBeVisible({ timeout: 20_000 }) // the picture of the whole window takes seconds
  const box = await shot.boundingBox()
  if (!box) throw new Error('no picture')
  await page.mouse.move(box.x + 40, box.y + 40)
  await page.mouse.down()
  await page.mouse.move(box.x + 160, box.y + 120, { steps: 4 })
  await page.mouse.up()
  await page.getByRole('textbox', { name: 'Comment for the agent' }).fill('Why is this here?')
  await page.getByRole('button', { name: /^Send/ }).click()
  await expect(page.getByText('Sent to the agent')).toBeVisible()
  const inbox = await (await request.get(`/api/projects/${id}/captures?unread=true`)).json()
  expect(inbox[0].comment).toBe('Why is this here?')

  // Agent side: a picture of the waveform viewer, with what is plotted in the description.
  await page.getByRole('navigation').getByRole('button', { name: 'Simulate' }).click()
  await page.getByRole('button', { name: 'TRAN', exact: true }).nth(1).click()
  await page.keyboard.press('F5')
  await expect(page.getByRole('button', { name: 'V(out)', exact: true })).toBeVisible({ timeout: 20_000 })
  const plot = await (
    await request.post('/api/capture', { data: { project_id: id, target: 'plot', max_px: 600 } })
  ).json()
  expect(plot.image.length).toBeGreaterThan(1000)
  expect(plot.description).toContain('plotted: V(in), V(out)')
})
