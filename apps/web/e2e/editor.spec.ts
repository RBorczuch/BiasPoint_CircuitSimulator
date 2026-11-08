import { type APIRequestContext, expect, type Page, test } from '@playwright/test'

type Point = [number, number]

async function newProject(request: APIRequestContext, name: string): Promise<string> {
  const response = await request.post('/api/projects', { data: { name } })
  return (await response.json()).id
}

async function describe(request: APIRequestContext, id: string): Promise<string> {
  return (await (await request.get(`/api/projects/${id}/circuit/describe`)).json()).text
}

async function document(request: APIRequestContext, id: string) {
  return (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[0]
}

async function open(page: Page, id: string): Promise<void> {
  await page.goto(`/?project=${id}`)
  await expect(page.getByText('Backend connected')).toBeVisible()
  await page.waitForFunction(() => window.__bpt !== undefined)
}

/** Wait until the UI shows a revision (backend changes reach the page asynchronously). */
async function uiRevision(page: Page, revision: number): Promise<void> {
  await expect(page.locator('footer')).toContainText(`rev ${revision}`)
}

async function clickWorld(page: Page, p: Point): Promise<void> {
  const [x, y] = await page.evaluate((world) => {
    if (!window.__bpt) throw new Error('editor not ready')
    return window.__bpt.toScreen(world as [number, number])
  }, p)
  await page.mouse.move(x, y)
  await page.mouse.click(x, y)
}

test('console builds a circuit from SPICE lines', async ({ page, request }) => {
  const id = await newProject(request, 'console')
  await open(page, id)
  const console = page.getByPlaceholder(/SPICE line/)
  for (const line of ['V1 in 0 DC 1', 'R1 in out 1k', 'C1 out 0 1u']) {
    await console.fill(line)
    await console.press('Enter')
    await expect(page.getByText(`> ${line}`)).toBeVisible()
  }
  await expect.poll(() => describe(request, id)).toContain('R1 in out 1k')
  await expect(page.getByText('ERC 0E')).toBeVisible()
})

test('place symbols, draw a wire, undo', async ({ page, request }) => {
  const id = await newProject(request, 'wiring')
  await open(page, id)

  // Two resistors (vertical, pins at y = +-381) 10 grid cells apart.
  await page.getByRole('button', { name: /^Resistor 1k/ }).click()
  await clickWorld(page, [0, 0])
  await clickWorld(page, [1270, 0])
  await page.keyboard.press('Escape')
  await uiRevision(page, 2)

  // W, from R1 pin 2 to R2 pin 2: the wire ends by itself on the pin.
  await page.keyboard.press('w')
  await clickWorld(page, [0, 381])
  await clickWorld(page, [1270, 381])
  await expect.poll(async () => (await document(request, id)).wires.length).toBe(1)
  const sheet = await document(request, id)
  expect(sheet.wires[0].points).toEqual([
    [0, 381],
    [1270, 381],
  ])
  await expect.poll(() => describe(request, id)).toMatch(/R1 \S+ (\S+) 1k\nR2 \S+ \1 1k/)

  await page.keyboard.press('Escape')
  await page.keyboard.press('Control+z')
  await expect.poll(async () => (await document(request, id)).wires.length).toBe(0)
})

test('rotate and delete the selection', async ({ page, request }) => {
  const id = await newProject(request, 'edit')
  await open(page, id)
  await page.getByRole('button', { name: /^Capacitor 100n/ }).click()
  await clickWorld(page, [0, 0])
  await page.keyboard.press('Escape')
  await uiRevision(page, 1)
  await clickWorld(page, [0, 0])
  await page.keyboard.press('r')
  await expect.poll(async () => (await document(request, id)).instances[0]?.rot).toBe(90)
  await page.keyboard.press('Delete')
  await expect.poll(async () => (await document(request, id)).instances.length).toBe(0)
})

test('the canvas follows its panel when the layout changes', async ({ page, request }) => {
  const id = await newProject(request, 'resize')
  await open(page, id)
  const host = page.getByTestId('schematic')
  const sizes = async () => {
    const box = await host.boundingBox()
    const canvas = await host.locator('canvas').boundingBox()
    return { host: Math.round(box?.width ?? 0), canvas: Math.round(canvas?.width ?? 0) }
  }
  const before = await sizes()
  expect(before.canvas).toBe(before.host)
  // Closing the properties panel changes the schematic panel size (no window resize).
  await page.locator('.dv-tab', { hasText: 'Properties' }).locator('.dv-default-tab-action').click()
  await expect.poll(async () => (await sizes()).host).not.toBe(before.host)
  await expect
    .poll(async () => {
      const after = await sizes()
      return after.canvas - after.host
    })
    .toBe(0)
})

async function worldToPage(page: Page, p: Point): Promise<Point> {
  return page.evaluate((world) => {
    if (!window.__bpt) throw new Error('editor not ready')
    return window.__bpt.toScreen(world as [number, number])
  }, p)
}

test('context menu rotates a part', async ({ page, request }) => {
  const id = await newProject(request, 'context')
  await open(page, id)
  await page.getByRole('button', { name: /^Capacitor 100n/ }).click()
  await clickWorld(page, [0, 0])
  await page.keyboard.press('Escape')
  await uiRevision(page, 1)
  const [x, y] = await worldToPage(page, [0, 0])
  await page.mouse.click(x, y, { button: 'right' })
  await page.getByRole('menuitem', { name: 'Rotate' }).click()
  await expect.poll(async () => (await document(request, id)).instances[0]?.rot).toBe(90)
})

test('dragging a wire segment keeps its ends', async ({ page, request }) => {
  const id = await newProject(request, 'segment')
  await open(page, id)
  await page.getByRole('button', { name: /^Resistor 1k/ }).click()
  await clickWorld(page, [0, 0])
  await clickWorld(page, [1270, 0])
  await page.keyboard.press('Escape')
  await uiRevision(page, 2)
  await page.keyboard.press('w')
  await clickWorld(page, [0, 381])
  await clickWorld(page, [1270, 381])
  await page.keyboard.press('Escape')
  await uiRevision(page, 3)
  const [x, y] = await worldToPage(page, [635, 381])
  const [, y2] = await worldToPage(page, [635, 635])
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, (y + y2) / 2, { steps: 4 })
  await page.mouse.move(x, y2, { steps: 4 })
  await page.mouse.up()
  await expect
    .poll(async () => (await document(request, id)).wires[0]?.points)
    .toEqual([
      [0, 381],
      [0, 635],
      [1270, 635],
      [1270, 381],
    ])
})

test('a closed panel comes back from View > Panels', async ({ page, request }) => {
  const id = await newProject(request, 'panels')
  await open(page, id)
  await page.locator('.dv-tab', { hasText: 'Properties' }).locator('.dv-default-tab-action').click()
  await expect(page.locator('.dv-tab', { hasText: 'Properties' })).toHaveCount(0)
  await page.getByRole('button', { name: 'View' }).click()
  await page.getByRole('menuitem', { name: 'Panels' }).click()
  await page.getByRole('menuitem', { name: 'Properties' }).click()
  await expect(page.locator('.dv-tab', { hasText: 'Properties' })).toHaveCount(1)
})

test('dropping a symbol from the library places it there', async ({ page, request }) => {
  const id = await newProject(request, 'drop')
  await open(page, id)
  const [x, y] = await worldToPage(page, [1270, 635])
  const canvas = page.getByTestId('schematic')
  const box = await canvas.boundingBox()
  await page
    .getByRole('button', { name: /^Inductor 10u/ })
    .dragTo(canvas, { targetPosition: { x: x - (box?.x ?? 0), y: y - (box?.y ?? 0) } })
  await expect.poll(async () => (await document(request, id)).instances[0]?.at).toEqual([1270, 635])
})

test('changes made by an agent are announced and can be undone', async ({ page, request }) => {
  const id = await newProject(request, 'agent')
  await open(page, id)
  // The MCP server talks to the same API: add a part as an agent would.
  await request.post(`/api/projects/${id}/circuit/components`, {
    data: { symbol: 'resistor', nets: ['a', '0'] },
  })
  await expect(page.getByText('Changed by another client')).toBeVisible()
  await page.locator('[data-sonner-toast]').getByRole('button', { name: 'Undo' }).click()
  await expect.poll(async () => (await document(request, id)).instances.length).toBe(0)
})

test('clicking a free pin end starts a wire', async ({ page, request }) => {
  const id = await newProject(request, 'pinwire')
  await open(page, id)
  await page.getByRole('button', { name: /^Resistor 1k/ }).click()
  await clickWorld(page, [0, 0])
  await clickWorld(page, [1270, 0])
  await page.keyboard.press('Escape')
  await uiRevision(page, 2)
  await clickWorld(page, [0, 381]) // free end of R1 pin 2, select tool
  await expect(page.locator('footer')).toContainText('wire')
  await clickWorld(page, [1270, 381])
  await expect.poll(async () => (await document(request, id)).wires.length).toBe(1)
})

test('an example project opens as an unsaved copy', async ({ page, request }) => {
  const id = await newProject(request, 'before-example')
  await open(page, id)
  await page.getByRole('button', { name: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Open example…' }).click()
  await page.getByRole('button', { name: /Sallen-Key low-pass/ }).click()
  await expect(page.getByRole('banner')).toContainText('sallen_key_lowpass (unsaved)')
  await expect(page.locator('footer')).toContainText('ERC 0E 0W')
})

test('labels and junctions go onto wires; crossings can join automatically', async ({ page, request }) => {
  const id = await newProject(request, 'labels')
  await page.addInitScript(() =>
    localStorage.setItem('bpt.settings', JSON.stringify({ autoJunctions: true })),
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'root',
        wires: [
          {
            id: '01a00000-0000-7000-8000-000000000001',
            points: [
              [0, 0],
              [1270, 0],
            ],
          },
        ],
      },
    },
  })
  await open(page, id)
  await uiRevision(page, 1)

  // A label dropped one grid step below the wire lands on it.
  await page.keyboard.press('l')
  await page.getByRole('textbox').fill('out')
  await page.keyboard.press('Enter')
  await clickWorld(page, [508, 127])
  await uiRevision(page, 2)
  await page.keyboard.press('Escape')
  expect((await document(request, id)).labels[0].at).toEqual([508, 0])

  // A vertical wire across the horizontal one gets a junction at the crossing.
  await page.keyboard.press('w')
  await clickWorld(page, [889, -508])
  await page.mouse.dblclick(...(await worldToPage(page, [889, 508])))
  await uiRevision(page, 3)
  await page.keyboard.press('Escape')
  expect((await document(request, id)).junctions.map((j: { at: Point }) => j.at)).toEqual([[889, 0]])

  // The junction tool places where clicked, not at a stale cursor.
  await page.getByRole('button', { name: 'Place junction' }).click()
  await clickWorld(page, [254, 0])
  await uiRevision(page, 4)
  expect((await document(request, id)).junctions).toHaveLength(2)
})

test('sheets: add from the tabs, rename, list in the project panel, delete and undo', async ({
  page,
  request,
}) => {
  const id = await newProject(request, 'sheets')
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'V1 in 0 DC 1\nR1 in 0 1k' } })
  await open(page, id)
  await page.getByRole('button', { name: 'Add sheet' }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('power')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'power' })).toHaveAttribute('aria-selected', 'true')
  await expect
    .poll(
      async () => (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets.length,
    )
    .toBe(2)

  await page.getByRole('tab', { name: 'power' }).dblclick()
  await page.getByRole('dialog').getByRole('textbox').fill('supply')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: 'supply' })).toBeVisible()

  await page.locator('.dv-tab', { hasText: /^Project$/ }).click()
  const panel = page.getByTestId('project-panel')
  await expect(panel).toContainText('supply')
  await expect(panel).toContainText('4 parts') // root: V1, R1 and two ground symbols
  await page.getByRole('button', { name: 'Delete supply' }).click({ force: true })
  await expect(page.getByRole('tab', { name: 'supply' })).toHaveCount(0)
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('tab', { name: 'supply' })).toBeVisible()
})

test('hierarchy: a sheet with ports becomes a block; double-click goes inside', async ({ page, request }) => {
  const id = await newProject(request, 'hier')
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_sheet',
        sheet: {
          id: '01a00000-0000-7000-8000-0000000000f1',
          name: 'filter',
          instances: [],
          wires: [],
          junctions: [],
          labels: [],
          directives: [],
        },
      },
    },
  })
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'R1 in out 1k\nC1 out 0 159.15n', sheet: 'filter' },
  })
  const filter = (await (await request.get(`/api/projects/${id}/document`)).json()).project.sheets[1]
  for (const label of filter.labels)
    await request.post(`/api/projects/${id}/commands`, {
      data: { command: { type: 'update_label', sheet: 'filter', id: label.id, kind: 'port' } },
    })
  await request.post(`/api/projects/${id}/circuit/import`, { data: { text: 'V1 vin 0 DC 0 AC 1' } })
  await open(page, id)

  // The sheet is in the library under "Project subcircuits"; place it.
  await page.getByRole('button', { name: /^filter X1$/ }).click()
  await clickWorld(page, [1905, 0])
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await document(request, id)).instances.map((i: { ref: string }) => i.ref))
    .toContain('X1')
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toContain('.subckt sheet_filter in out')

  // Double-click the block: its sheet opens.
  const x1 = (await document(request, id)).instances.find((i: { ref: string }) => i.ref === 'X1')
  await page.keyboard.press('Escape')
  const [x, y] = await worldToPage(page, x1.at)
  // The backend has X1 before the page applies the change: click until the block is selectable.
  await expect(async () => {
    await page.mouse.click(x, y)
    await expect(page.getByText('1 selected')).toBeVisible({ timeout: 500 })
  }).toPass()
  await page.mouse.dblclick(x, y)
  await expect(page.getByRole('tab', { name: 'filter' })).toHaveAttribute('aria-selected', 'true')
  // Inside: the path shows where the block is; Alt+Backspace leaves it.
  await expect(page.getByRole('navigation', { name: 'Hierarchy' })).toContainText('root›X1')
  await page.keyboard.press('Alt+Backspace')
  await expect(page.getByRole('tab', { name: 'root' })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('navigation', { name: 'Hierarchy' })).toHaveCount(0)

  // Block parameters: a default on the sheet, overridden on the block in the inspector.
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_parameter', sheet: 'filter', name: 'R', value: '1k' } },
  })
  const [bx, by] = await worldToPage(page, x1.at) // the view was fitted again on return
  await expect(async () => {
    await page.mouse.click(bx, by)
    await expect(page.getByRole('textbox', { name: 'R', exact: true })).toBeVisible({ timeout: 500 })
  }).toPass()
  const field = page.getByRole('textbox', { name: 'R', exact: true })
  await expect(field).toHaveAttribute('placeholder', '1k (sheet default)')
  await field.fill('2k')
  await field.press('Enter')
  await expect
    .poll(async () => (await request.get(`/api/projects/${id}/export/netlist`)).text())
    .toContain('sheet_filter R=2k')
})

test('create block from selection: parts move to a new sheet, a block takes their place', async ({
  page,
  request,
}) => {
  const id = await newProject(request, 'extract')
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 vin 0 DC 2\nR1 vin mid 1k\nR2 mid out 1k\nR3 out 0 2k' },
  })
  await open(page, id)
  await uiRevision(page, (await (await request.get(`/api/projects/${id}/document`)).json()).revision)
  const parts = (await document(request, id)).instances
  const at = (ref: string) => parts.find((i: { ref: string }) => i.ref === ref).at
  const [ax, ay] = await worldToPage(page, at('R1'))
  const [bx, by] = await worldToPage(page, at('R2'))
  await page.mouse.click(ax, ay)
  await page.keyboard.down('Shift')
  await page.mouse.click(bx, by)
  await page.keyboard.up('Shift')
  await expect(page.getByText('2 selected')).toBeVisible()

  await page.getByRole('button', { name: 'Edit' }).click()
  await page.getByRole('menuitem', { name: /Create block from selection/ }).click()
  await page.getByRole('dialog').getByRole('textbox').fill('divider')
  await page.keyboard.press('Enter')

  await expect(page.getByRole('tab', { name: 'divider' })).toBeVisible()
  await expect(page.getByText(/Block X1 \(divider\) with ports/)).toBeVisible()
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toContain('.subckt sheet_divider')
  expect(netlist).toMatch(/^X1 .* sheet_divider/m)
  // One undo step brings the parts back.
  await page.keyboard.press('Control+z')
  await expect(page.getByRole('tab', { name: 'divider' })).toHaveCount(0)
  await expect
    .poll(async () => (await document(request, id)).instances.map((i: { ref: string }) => i.ref))
    .toContain('R1')
})

test('a sheet used twice: entering X2 names the path X2; block pins can change side', async ({
  page,
  request,
}) => {
  const id = await newProject(request, 'twice')
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 vin 0 DC 1\nR1 vin out 1k\nC1 out 0 1n\nR3 out 0 10k' },
  })
  const parts = (await document(request, id)).instances
  const ids = parts
    .filter((i: { ref: string }) => ['R1', 'C1'].includes(i.ref))
    .map((i: { id: string }) => i.id)
  await request.post(`/api/projects/${id}/blocks`, { data: { sheet: 'root', ids, name: 'rc' } })
  // A second block of the same sheet, away from the first.
  await request.post(`/api/projects/${id}/commands`, {
    data: {
      command: {
        type: 'add_objects',
        sheet: 'root',
        instances: [
          { id: '01a00000-0000-7000-8000-0000000000b2', ref: 'X2', symbol: 'sheet:rc', at: [0, 5080] },
        ],
      },
    },
  })
  await open(page, id)
  await expect(page.locator('footer')).toContainText('rev 3')
  await page.evaluate(() => window.__bpt?.fit())
  const [x, y] = await worldToPage(page, [0, 5080])
  await expect(async () => {
    await page.mouse.click(x, y)
    await expect(page.getByText('1 selected')).toBeVisible({ timeout: 500 })
  }).toPass()
  await page.mouse.dblclick(x, y)
  await expect(page.getByRole('navigation', { name: 'Hierarchy' })).toContainText('root›X2')

  // Nothing selected on the block sheet: its pins; "out" goes to the top of the symbol.
  await page.keyboard.press('Escape')
  await page.getByRole('combobox', { name: 'Side of out' }).selectOption('top')
  await expect
    .poll(async () => {
      const doc = await (await request.get(`/api/projects/${id}/document`)).json()
      return doc.project.sheets.find((s: { name: string }) => s.name === 'rc').port_sides
    })
    .toEqual({ vin: 'left', out: 'top' })
  const netlist = await (await request.get(`/api/projects/${id}/export/netlist`)).text()
  expect(netlist).toMatch(/^X1 vin out sheet_rc$/m) // the labels on X1's pins moved with them
})

test('bus tool draws a bus (thick, not a wire of a net)', async ({ page, request }) => {
  const id = await newProject(request, 'bus')
  await open(page, id)
  await page
    .locator('canvas')
    .first()
    .click({ position: { x: 300, y: 300 } })
  await page.keyboard.press('b')
  await expect(page.locator('footer')).toContainText('bus · A bus only groups nets')
  await clickWorld(page, [0, 0])
  await clickWorld(page, [2540, 0])
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await document(request, id)).wires.map((w: { bus?: boolean }) => w.bus))
    .toEqual([true])
})
