import { expect, test } from 'claude-code/testing'

import { VERSION } from '../hooks/version'

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

test('the pane title carries the version, so the person sees which Pulse runs', async ($, on) => {
  const titles: (string | undefined)[] = []
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', (_, e) => {
    titles.push(e.title)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'pulse', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
  expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  expect(titles).toEqual([`Pulse ${VERSION}`, `Pulse ${VERSION}`])
})

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
  expect(await done.find({ type: 'Text', text: /^1 turn · avg 12s/ })).toBeDefined()
  await done.unmount()
})

test('each model gets its own row of turns and tokens', async ($, on) => {
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 1_000 }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  const usage = (model: string, output: number) => ({
    model,
    input_tokens: 10,
    output_tokens: output,
    cache_read_input_tokens: 1_000,
    cache_creation_input_tokens: 0,
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [id, model, out] of [['t1', 'claude-opus-5-5', 2_000], ['t2', 'claude-haiku-5-5', 300], ['t3', 'claude-opus-5-5', 1_000]] as const) {
    await $.turn.start({ text: 'hi', turnId: id })
    await $.turn.complete({ answer: '', durationMs: 4_000, isAborted: false, turnId: id, reason: 'answer', usage: usage(model, out) })
  }

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: '2 models' })).toBeDefined()
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: /^2 turns · 3\.0k out · avg 4s/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^1 turn · 300 out/ })).toBeDefined()
    } else {
      expect(await ui.find({ type: 'Svg' })).toBeDefined()
    }
    await ui.unmount()
  }
})

// The store and session id the persistence tests share; each test gets its own copy.
const world = (on: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1], entries: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(entries))
  const ids = { current: 'abc' }
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: 5_000 }))
  on('session.id', () => ({ value: ids.current }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  return { store, ids }
}

const saved = (mainTurns: number) => ({
  shape: 'metrics-4',
  savedAt: 1,
  metrics: {
    mainTurns, agentTurns: 0, abortedTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    turnMsTotal: mainTurns * 3_000, lastTurnMs: 3_000, longestTurnMs: 3_000, toolCalls: 0, toolErrors: 0, toolMsTotal: 0,
    byTool: {}, models: {}, pluginCalls: {}, turns: [], lastCostUsd: 0.4,
  },
})

test('a resumed session reloads the metrics it saved', async ($, on) => {
  world(on, { 'session:abc': saved(5) })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^5 turns · avg 3s/ })).toBeDefined()
  await ui.unmount()
})

test('each turn saves the session and the store keeps the newest 50', async ($, on) => {
  const old = Array.from({ length: 50 }, (_, i) => ({ id: `s${i}`, savedAt: i }))
  const { store } = world(on, {
    sessions: old,
    ...Object.fromEntries(old.map(x => [`session:${x.id}`, saved(1)])),
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const mine = store.get('session:abc') as { metrics: { mainTurns: number; sessionId: string } }
  expect(mine.metrics.mainTurns).toBe(1)
  expect(mine.metrics.sessionId).toBe('abc')
  const index = store.get('sessions') as { id: string }[]
  expect(index.length).toBe(50)
  expect(index[index.length - 1]?.id).toBe('abc')
  expect(store.has('session:s0')).toBe(false)
  expect(store.has('session:s1')).toBe(true)
})

// The engine raises session.end with reason `clear` and then no session.start: the process goes on under the new id.
test('after /clear the pane starts empty, and the new turns save under the new id', async ($, on) => {
  const { ids, store } = world(on)
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })

  await $.session.end({ reason: 'clear', sessionId: 'abc', resume: { id: 'abc' } })
  ids.current = 'after-clear'
  const empty = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await empty.find({ type: 'Text', text: 'none yet' })).toBeDefined()
  await empty.unmount()

  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })
  const old = store.get('session:abc') as { metrics: { mainTurns: number } }
  const fresh = store.get('session:after-clear') as { metrics: { mainTurns: number } }
  expect(old.metrics.mainTurns).toBe(1)
  expect(fresh.metrics.mainTurns).toBe(1)
})

test('with no session.end, a new session id at the next turn still starts the figures over', async ($, on) => {
  const { ids, store } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })

  ids.current = 'after-clear'
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })
  expect((store.get('session:abc') as { metrics: { mainTurns: number } }).metrics.mainTurns).toBe(1)
  expect((store.get('session:after-clear') as { metrics: { mainTurns: number } }).metrics.mainTurns).toBe(1)
})

test('a save from 0.4.0, which has no plugin-call counts, still draws', async ($, on) => {
  const { metrics, ...rest } = saved(5)
  const { pluginCalls: _, ...without } = metrics
  world(on, { 'session:abc': { ...rest, metrics: without } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^5 turns · avg 3s/ })).toBeDefined()
  await ui.unmount()
})

test('a resumed subagent is not a second start', async ($, on) => {
  world(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  const spawn = {
    tool_use_id: 'u1',
    prompt: 'look around',
    description: 'Look around',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    permissionMode: 'default',
    background: true,
    fork: false,
  } as const
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.agent.spawn(spawn)
  await $.agent.spawn({ ...spawn, tool_use_id: 'u2', resume: { agentId: 'a1' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^1 start · 1 type/ })).toBeDefined()
  await ui.unmount()
})
