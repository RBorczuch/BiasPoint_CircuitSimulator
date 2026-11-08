import { expect, type Page, test } from '@playwright/test'

async function powerGraph(page: Page, request: import('@playwright/test').APIRequestContext) {
  await page.setViewportSize({ width: 1400, height: 850 })
  const id = (await (await request.post('/api/projects', { data: { name: 'canvas' } })).json()).id
  await request.post(`/api/projects/${id}/circuit/import`, {
    data: { text: 'V1 in 0 DC 2\nR1 in out 1k\nR2 out 0 1k' },
  })
  await page.goto(`/?project=${id}`)
  await expect(page.locator('footer')).toContainText('rev 1')
  await page.getByRole('navigation').getByRole('button', { name: 'Analysis' }).click()
  await page.getByRole('button', { name: 'Power and its average' }).click()
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /OK|Create|Save/ })
    .click()
  await expect(page.locator('.react-flow__node-card')).toHaveCount(8)
  const graph = async () =>
    (await (await request.get(`/api/projects/${id}/document`)).json()).project.graphs[0] as {
      nodes: {
        id: string
        type: string
        title?: string
        bypass?: boolean
        version?: number
        params?: Record<string, unknown>
      }[]
      groups?: { title: string; rect: number[] }[]
      notes?: { text: string }[]
      reroutes?: { id: string }[]
      edges: { source: string; target: string }[]
    }
  return { id, graph }
}

test('a graph organised: groups around nodes, notes, reroutes, titles, bypass', async ({ page, request }) => {
  const { graph } = await powerGraph(page, request)

  // A title of its own for a node; its type stays shown beside it.
  const card = page.locator('.react-flow__node-card').filter({ hasText: 'Measure' }).first()
  await card.getByTitle(/^Rename/).dblclick()
  await page.getByRole('dialog').getByRole('textbox').fill('Average power')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /OK|Save/ })
    .click()
  await expect(card).toContainText('Average power')
  await expect
    .poll(async () => (await graph()).nodes.find((n) => n.type === 'measure/basic')?.title)
    .toBe('Average power')

  // M bypasses the selected node (and brings it back).
  await card.click({ position: { x: 150, y: 12 } })
  await page.keyboard.press('m')
  await expect(card.locator('[data-bypass="true"]')).toHaveCount(1)
  await expect
    .poll(async () => (await graph()).nodes.find((n) => n.type === 'measure/basic')?.bypass)
    .toBe(true)
  await page.keyboard.press('m')
  await expect
    .poll(async () => (await graph()).nodes.find((n) => n.type === 'measure/basic')?.bypass)
    .toBe(false)

  // Ctrl+G frames the selected node in a titled group.
  await page.keyboard.press('Control+g')
  await page.getByRole('dialog').getByRole('textbox').fill('Results')
  await page
    .getByRole('dialog')
    .getByRole('button', { name: /OK|Save/ })
    .click()
  await expect(page.locator('.react-flow__node-group')).toHaveCount(1)
  await expect.poll(async () => (await graph()).groups?.[0]?.title).toBe('Results')

  // A note and a reroute from the add-node palette.
  await page.getByRole('button', { name: 'Node', exact: true }).click()
  await page.getByPlaceholder(/Add node/).fill('Note')
  await page.getByRole('option', { name: /^Note/ }).click()
  await expect(page.locator('.react-flow__node-note')).toHaveCount(1)
  await page.getByRole('button', { name: 'Node', exact: true }).click()
  await page.getByPlaceholder(/Add node/).fill('Reroute')
  await page.getByRole('option', { name: /^Reroute/ }).click()
  await expect(page.locator('.react-flow__node-reroute')).toHaveCount(1)
  await expect
    .poll(async () => [(await graph()).notes?.length, (await graph()).reroutes?.length])
    .toEqual([1, 1])
  // New nodes record the version of their type.
  expect((await graph()).nodes.every((n) => n.version === 1)).toBe(true)
})

test('a table made of values, shown with its columns and units', async ({ page, request }) => {
  const { id, graph } = await powerGraph(page, request)
  const g = (await graph()) as unknown as {
    name: string
    nodes: { id: string; type: string; pos: number[]; size: null; params: Record<string, string> }[]
    edges: { source: string; output: string; target: string; input: string }[]
  }
  const measure = g.nodes.find((n) => n.type === 'measure/basic')?.id as string
  g.nodes.push(
    { id: 'tab', type: 'table/make', pos: [900, 400], size: null, params: { name: 'results' } },
    { id: 'see', type: 'view/table', pos: [1250, 400], size: null, params: {} },
  )
  g.edges.push(
    { source: measure, output: 'value', target: 'tab', input: 'values' },
    { source: 'tab', output: 'table', target: 'see', input: 'table' },
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_graph', name: g.name, graph: g } },
  })
  await expect(page.locator('.react-flow__node-card')).toHaveCount(10)
  await page.getByRole('button', { name: /Run graph/ }).click()
  const grid = page.getByTestId('node-table')
  await expect(grid).toContainText('1 mW', { timeout: 20_000 })
  await expect(grid.locator('th')).toHaveCount(1) // one column: the average power, with its unit
  await expect(grid.locator('th')).toContainText('[W]')
})

test('the inspector shows the selected node: parameters, sockets, state; "?" explains it', async ({
  page,
  request,
}) => {
  const { graph } = await powerGraph(page, request)
  const card = page.locator('.react-flow__node-card').filter({ hasText: 'Measure' }).first()
  await card.click({ position: { x: 150, y: 40 } }) // between its sockets: selects the node
  const inspector = page.getByTestId('node-inspector')
  await expect(inspector).toContainText('measure/basic')
  await expect(inspector).toContainText('· out') // what feeds its input: node · output
  await expect(page.getByTestId('inspector-status')).toHaveText('not run yet')

  await inspector.getByRole('button', { name: 'Measure' }).click() // several measures at once
  await page.getByRole('menuitemcheckbox', { name: 'max' }).click()
  await page.keyboard.press('Escape')
  await expect
    .poll(async () => (await graph()).nodes.find((n) => n.type === 'measure/basic')?.params?.op)
    .toBe('avg, max')
  await expect(card).toContainText('max') // its own output
  await page.getByRole('button', { name: /Run graph/ }).click()
  await expect(page.getByTestId('inspector-status')).toContainText('done', { timeout: 20_000 })

  await inspector.getByRole('button', { name: 'Close the inspector' }).click()
  await expect(inspector).toHaveCount(0)
  await page.getByRole('button', { name: 'Inspector' }).click()
  await expect(page.getByTestId('node-inspector')).toBeVisible()

  await card.getByRole('button', { name: 'What Measure does' }).hover()
  await expect(page.getByTestId('node-help')).toContainText('Inputs')
})

test('Measure 2.0: several measures, an output each and a table of them', async ({ page, request }) => {
  const { id, graph } = await powerGraph(page, request)
  const g = (await graph()) as unknown as {
    name: string
    nodes: { id: string; type: string; pos: number[]; size: null; params: Record<string, unknown> }[]
    edges: { source: string; output: string; target: string; input: string }[]
  }
  const measure = g.nodes.find((n) => n.type === 'measure/basic')
  if (!measure) throw new Error('no Measure node')
  measure.params = { ...measure.params, op: 'avg, max, rms' }
  g.nodes.push(
    { id: 'peak', type: 'view/value', pos: [1250, 250], size: null, params: {} },
    { id: 'all', type: 'view/table', pos: [1250, 450], size: null, params: {} },
  )
  g.edges.push(
    { source: measure.id, output: 'max', target: 'peak', input: 'value' },
    { source: measure.id, output: 'table', target: 'all', input: 'table' },
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_graph', name: g.name, graph: g } },
  })
  await expect(page.locator('.react-flow__node-card')).toHaveCount(10)
  await page.getByRole('button', { name: /Run graph/ }).click()
  const grid = page.getByTestId('node-table')
  await expect(grid.locator('th')).toHaveCount(3, { timeout: 20_000 })
  await expect(grid).toContainText('1 mW') // the average: power of a DC divider is constant
  const peak = page.locator('.react-flow__node-card').filter({ hasText: 'max(P)' })
  await expect(peak.getByTestId('node-value')).toHaveText('1 mW')
})

test('Plot 2.0: a panel per unit, a right axis, reference lines and limits', async ({ page, request }) => {
  const { id, graph } = await powerGraph(page, request)
  const g = (await graph()) as unknown as {
    name: string
    nodes: { id: string; type: string; params: Record<string, unknown> }[]
    edges: { source: string; output: string; target: string; input: string }[]
  }
  const plot = g.nodes.find((n) => n.type === 'view/plot')
  if (!plot) throw new Error('no Plot node')
  plot.params = { ...plot.params, panels: 'per unit', lines: '0.5 mW; x = 0.5 ms' }
  g.edges.push(
    { source: 'v', output: 'signal', target: plot.id, input: 'signals' },
    { source: 'i', output: 'signal', target: plot.id, input: 'signals' },
    { source: 'avg', output: 'value', target: plot.id, input: 'limits' },
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_graph', name: g.name, graph: g } },
  })
  const card = page.locator('.react-flow__node-card').filter({ hasText: 'Plot' })
  await expect(card).toContainText('more in the inspector: Groups, Right axis, Lines')
  await page.getByRole('button', { name: /Run graph/ }).click()
  await expect(card.locator('canvas')).toHaveCount(3, { timeout: 20_000 }) // W, V and A
})

test('a parameter taken from an input: a number from another node sets it', async ({ page, request }) => {
  const { id, graph } = await powerGraph(page, request)
  const card = page.locator('.react-flow__node-card').filter({ hasText: 'Measure' }).first()
  await card.getByRole('button', { name: 'Take Band % from an input' }).click()
  await expect(card.locator('[data-handleid="band"]')).toHaveCount(1)
  await expect(card).toContainText('from the input')
  await expect
    .poll(async () => (await graph()).nodes.find((n) => n.type === 'measure/basic')?.param_inputs)
    .toEqual(['band'])
  await card.getByRole('button', { name: 'Set Band % here again' }).click() // unconnected: it would block
  await expect(card.locator('[data-handleid="band"]')).toHaveCount(0)

  // A second measure whose window starts where the first one's number says (1 mW -> 1 ms).
  const g = (await graph()) as unknown as {
    name: string
    nodes: Record<string, unknown>[]
    edges: { source: string; output: string; target: string; input: string }[]
  }
  g.nodes.push(
    {
      id: 'late',
      type: 'measure/basic',
      version: 2,
      pos: [1480, 700],
      size: null,
      params: { op: 'avg' },
      param_inputs: ['start'],
    },
    { id: 'show2', type: 'view/value', pos: [1860, 700], size: null, params: {} },
  )
  g.edges.push(
    { source: 'p', output: 'out', target: 'late', input: 'signal' },
    { source: 'avg', output: 'value', target: 'late', input: 'start' },
    { source: 'late', output: 'value', target: 'show2', input: 'value' },
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_graph', name: g.name, graph: g } },
  })
  await page.getByRole('button', { name: /Run graph/ }).click()
  await expect(page.getByTestId('node-value')).toHaveText(['1 mW', '1 mW'], { timeout: 20_000 })
})

test('Number and Equation: a worked formula with the values put in', async ({ page, request }) => {
  const { id, graph } = await powerGraph(page, request)
  const g = (await graph()) as unknown as {
    name: string
    nodes: Record<string, unknown>[]
    edges: { source: string; output: string; target: string; input: string }[]
  }
  g.nodes.push(
    { id: 'vin', type: 'math/number', pos: [0, 700], size: null, params: { value: '12 V', name: 'Vin' } },
    { id: 'r', type: 'math/number', pos: [0, 860], size: null, params: { value: '4k7', name: 'R' } },
    {
      id: 'eq',
      type: 'view/equation',
      pos: [380, 760],
      size: null,
      params: { expr: 'a/b', name: 'I', unit: 'A' },
    },
  )
  g.edges.push(
    { source: 'vin', output: 'value', target: 'eq', input: 'a' },
    { source: 'r', output: 'value', target: 'eq', input: 'b' },
  )
  await request.post(`/api/projects/${id}/commands`, {
    data: { command: { type: 'set_graph', name: g.name, graph: g } },
  })
  await page.getByRole('button', { name: /Run graph/ }).click()
  const equation = page.getByTestId('node-equation')
  await expect(equation).toContainText('I = a/b', { timeout: 20_000 })
  await expect(equation).toContainText('= (12 V)/(4.7 k)')
  await expect(equation).toContainText('2.553 mA')
})
