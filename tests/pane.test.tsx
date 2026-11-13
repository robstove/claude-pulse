import { expect, test } from 'claude-code/testing'

const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: {
    title: 'Pulse',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('the pane shows tool counts and session figures, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 12_000, window: 200_000, percent: 6 }, rateLimits: [], cost: { usd: 0.0123 } },
  }))
  on('tool.call', () => ({ result: {} }))
  let tick = 0
  on('clock.now', () => ({ value: (tick += 250) }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })
  await $.tool.call({ tool: 'Bash', command: 'pwd' })

  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })

    expect(await ui.find({ type: "Text", text: /^2 calls · / })).toBeDefined()
    expect(await ui.find({ type: "Text", text: "$0.0123" })).toBeDefined()
    expect(await ui.find({ type: "Text", text: /12\.0k \/ 200\.0k/})).toBeDefined()
    expect(await ui.find({ type: "Text", text: "6%" })).toBeDefined()
    expect(await ui.find({ type: "Text", text: "Session cost" })).toBeDefined()
    if (surface === "terminal") {
      expect(await ui.find({ type: "Text", text: /^2× / })).toBeDefined()
    } else {
      expect(await ui.find({ type: "Svg" })).toBeDefined()
    }
    await ui.unmount()
  }
})

test('the prompt hint carries the summary with no plugin label', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 170_000, window: 200_000, percent: 85 }, rateLimits: [], cost: { usd: 1.5 } },
  }))
  on('tool.call', () => ({ result: {} }))
  let tick = 0
  on('clock.now', () => ({ value: (tick += 100) }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}{e.props.tail ?? ''}</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls' })

  const HINT = { plugin: 'pulse', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const
  const desktop = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await desktop.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  expect(await desktop.find({ type: 'Text', text: '■ ctx 85% · $1.50 · 1 tools' })).toBeDefined()
  await desktop.unmount()

  const terminal = await $.ui.mount({ ...HINT, surface: 'terminal' })
  expect(await terminal.find({ type: 'Text', text: '? for shortcuts  ■ ctx 85% · $1.50 · 1 tools' })).toBeDefined()
  await terminal.unmount()
})

test('a running turn ticks once a second and stops when it ends', async ($, on) => {
  const periods: number[] = []
  let invalidations = 0
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => {
    invalidations += 1
    return { value: undefined }
  })
  on('clock.every', (_, e) => {
    periods.push(e.ms)
    return { value: undefined }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  let now = 10_000
  on('clock.now', () => ({ value: now }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(periods).toEqual([1000])
  expect(invalidations).toBeGreaterThan(0)

  now = 22_400
  const running = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await running.find({ type: 'Text', text: /^Running 12s/ })).toBeDefined()
  await running.unmount()

  await $.turn.complete({ answer: '', durationMs: 12_400, isAborted: false, turnId: 't1', reason: 'answer' })
  const done = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await done.find({ type: 'Text', text: /^Running/ })).toBeUndefined()
  expect(await done.find({ type: 'Text', text: /^1 · avg 12s/ })).toBeDefined()
  await done.unmount()
})
