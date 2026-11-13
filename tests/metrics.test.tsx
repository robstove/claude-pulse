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

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]
type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The engine answers every test shares; `state` lets a test move the clock, the cost, and the limits.
const engine = (on: On) => {
  const state = { now: Date.UTC(2026, 10, 13, 12), cost: 0.5, limits: [] as Limit[] }
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: state.now }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: { startedAt: state.now - 600_000, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: state.limits, cost: { usd: state.cost } },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  return { state, store }
}

const SUMMARY = { role: 'user' as const, text: 'summary', toolUses: [] }

const usage = (model: string, output: number) => ({
  model,
  input_tokens: 10,
  output_tokens: output,
  cache_read_input_tokens: 1_000,
  cache_creation_input_tokens: 0,
})

test('subagents, compactions, prompts, requests, slow calls, and files show in the pane', async ($, on) => {
  const { state } = engine(on)
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: 'a1' }))
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 150_000, tokensAfter: 20_000 }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.step', async function* (_, e) {
    state.now += 400
    yield { kind: 'text', index: 0, text: 'hi', ref: 1 }
    state.now += 2_000
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'hi',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage('claude-opus-5-5', 500),
      serverToolUses: [{ id: 's1', name: 'web_search', input: {}, startedAt: 0 }],
    }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' }, wait: false, origin: { kind: 'composer' } })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Read the stream to its end.
  }
  await $.agent.spawn({
    tool_use_id: 'u1',
    prompt: 'look around',
    description: 'Look around',
    subagentType: 'Explore',
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'claude-opus-5-5',
    permissionMode: 'default',
    background: false,
    fork: false,
  })
  await $.turn.complete({ answer: '', durationMs: 5_000, isAborted: false, turnId: 'a-t1', agentId: 'a1', reason: 'answer', usage: usage('claude-haiku-5-5', 200) })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/a.ts', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'cd "C:/my repo" && cd sub; npm test' })
  await $.turn.complete({ answer: '', durationMs: 9_000, isAborted: false, turnId: 't1', reason: 'answer', usage: usage('claude-opus-5-5', 500) })
  await $.session.compact({ trigger: 'manual', messages: [SUMMARY, SUMMARY] })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: 'Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 start · 1 type/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 compacted/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 prompts · 1 command: \/compact/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\.0 requests a turn · first token 400ms · 250 tok\/s · web_search 1×/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/a.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Slowest calls' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Bash · npm test' })).toBeDefined()
    await ui.unmount()
  }
})

test('the limits section projects when a window fills at this pace', async ($, on) => {
  const { state } = engine(on)
  const start = state.now
  const resetsAt = new Date(start + 3 * 3_600_000).toISOString()
  state.limits = [{ kind: 'five_hour', percentUsed: 30, resetsAt }, { kind: 'seven_day', percentUsed: 10 }]

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  // 10 points in 20 minutes is 30 an hour: the last 60 points take 2 hours, before the reset in 3.
  state.now = start + 20 * 60_000
  state.limits = [{ kind: 'five_hour', percentUsed: 40, resetsAt }, { kind: 'seven_day', percentUsed: 10 }]
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^5-hour full in ~2h 0m/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^5-hour: resets in 2h 40m · \+30\.0 pts\/h/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7-day: no reset time · \+0\.0 pts\/h/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the first turn has a cost, and each turn adds its cost to the day', async ($, on) => {
  const { state, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.cost = 0.8
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const saved = store.get('session:abc') as { metrics: { turns: { costUsd: number | null }[] } }
  expect(Math.abs((saved.metrics.turns[0]?.costUsd ?? 0) - 0.3) < 1e-9).toBe(true)
  const daily = store.get('daily') as Record<string, number>
  expect(Math.abs((Object.values(daily)[0] ?? 0) - 0.3) < 1e-9).toBe(true)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^today \$0\.3000 · 7 days \$0\.3000/ })).toBeDefined()
  expect(await ui.find({ type: 'Svg' })).toBeDefined()
  await ui.unmount()
})

test('interrupted turns show in red under the turns chart', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: true, turnId: 't1', reason: 'aborted' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: '1 interrupted' })).toBeDefined()
  await ui.unmount()
})

test('the activity split counts only turns timed with the gaps, not turns from before', async ($, on) => {
  const { state, store } = engine(on)
  // A save from before 0.2.0: 30s of turn time and no gap counter.
  store.set('session:abc', {
    shape: 'metrics-3',
    savedAt: 1,
    metrics: {
      mainTurns: 3, agentTurns: 0, abortedTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      turnMsTotal: 30_000, lastTurnMs: 10_000, longestTurnMs: 10_000, toolCalls: 0, toolErrors: 0, toolMsTotal: 0,
      byTool: {}, models: {}, pluginCalls: {}, turns: [], lastCostUsd: 0.4,
    },
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
  state.now += 6_000
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Claude 40% · you 60%' })).toBeDefined()
  await ui.unmount()
})
