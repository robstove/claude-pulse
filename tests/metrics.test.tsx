import { expect, test } from 'claude-code/testing'

import { SHAPE } from '../hooks/state'
import { PANE, costsIn, memoryStore } from './kit'
import type { Dollar, On } from './kit'
import type { Limit } from './live'

// The engine answers every test shares; `state` lets a test move the clock, the cost, and the limits.
const engine = (on: On) => {
  const state = { now: Date.UTC(2026, 10, 13, 12), cost: 0.5, limits: [] as Limit[], percent: 1 as number | undefined }
  const store = memoryStore(on)
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: state.now }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: state.now - 600_000,
      context: { tokens: state.percent === undefined ? undefined : 1_000, window: 200_000, percent: state.percent },
      rateLimits: state.limits,
      cost: { usd: state.cost },
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
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
    expect(await ui.find({ type: 'Text', text: 'Bash · npm' })).toBeDefined()
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
  expect(Math.abs((Object.values(costsIn(store))[0] ?? 0) - 0.3) < 1e-9).toBe(true)

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

test('the activity split compares turn time with the gaps between turns', async ($, on) => {
  const { state } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })
  // 6 s at the prompt, then 4 s of turns in all: Claude 40%, you 60%.
  state.now += 6_000
  await $.turn.start({ text: 'hi', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't2', reason: 'answer' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Claude 40% · you 60%' })).toBeDefined()
  await ui.unmount()
})

const turn = async ($: Dollar, id: string) => {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
}

test("a subagent's own compaction is not a compaction of the main conversation", async ($, on) => {
  engine(on)
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 150_000, tokensAfter: 20_000 }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY, SUMMARY], agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /compacted/ })).toBeUndefined()
  await ui.unmount()
})

test('a prompt that a hook dropped is not counted', async ($, on) => {
  engine(on)
  on('prompt.submit', () => ({ drop: 'blocked by a settings hook' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })
  await turn($, 't1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^0 prompts/ })).toBeDefined()
  await ui.unmount()
})

test('before the first turn ends, Activity shows the prompts and no split', async ($, on) => {
  engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'hi', wait: false, origin: { kind: 'composer' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'no turn ended yet' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude 0%/ })).toBeUndefined()
  await ui.unmount()
})

test('a new reset time starts the pace again, though the fill did not drop', async ($, on) => {
  const { state } = engine(on)
  const start = state.now
  const first = new Date(start + 3_600_000).toISOString()
  const second = new Date(start + 6 * 3_600_000).toISOString()
  state.limits = [{ kind: 'five_hour', percentUsed: 10, resetsAt: first }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  // The window reset, and other sessions filled the new one to 30% before this session read it again.
  state.now = start + 70 * 60_000
  state.limits = [{ kind: 'five_hour', percentUsed: 30, resetsAt: second }]
  await turn($, 't2')
  state.now = start + 90 * 60_000
  state.limits = [{ kind: 'five_hour', percentUsed: 40, resetsAt: second }]
  await turn($, 't3')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^5-hour: resets in .* · \+30\.0 pts\/h/ })).toBeDefined()
  await ui.unmount()
})

test('a spend limit past 100% reads as full, and a window with no reset time warns only inside its length', async ($, on) => {
  const { state } = engine(on)
  const start = state.now
  state.limits = [
    { kind: 'spend_limit', percentUsed: 50, resetsAt: new Date(start + 3 * 3_600_000).toISOString() },
    { kind: 'five_hour', percentUsed: 5 },
  ]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  state.now = start + 60 * 60_000
  state.limits = [
    { kind: 'spend_limit', percentUsed: 105, resetsAt: new Date(start + 3 * 3_600_000).toISOString() },
    { kind: 'five_hour', percentUsed: 6 },
  ]
  await turn($, 't2')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: 'Spend full' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /-\d+ms/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /5-hour full/ })).toBeUndefined()
  await ui.unmount()
})

test("after a resume, a turn's cost comes from this process's ledger, not the saved total", async ($, on) => {
  const { state, store } = engine(on)
  store.set('session:abc', {
    shape: SHAPE,
    savedAt: 1,
    metrics: {
      mainTurns: 1, agentTurns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
      turnMsTotal: 1_000, lastTurnMs: 1_000, longestTurnMs: 1_000, toolCalls: 0, toolErrors: 0, toolMsTotal: 0,
      byTool: {}, models: {}, pluginCalls: {}, turns: [], lastCostUsd: 12.3,
    },
  })
  state.cost = 0.5
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.cost = 0.8
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(Math.abs((Object.values(costsIn(store))[0] ?? 0) - 0.3) < 1e-9).toBe(true)
})

test('the session end saves what changed after the last turn, and its cost', async ($, on) => {
  const { state, store } = engine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' }, wait: false, origin: { kind: 'composer' } })
  state.cost = 0.7
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'abc', resume: { id: 'abc' } })

  const saved = store.get('session:abc') as { metrics: { prompts?: number } }
  expect(saved.metrics.prompts).toBe(1)
  expect(Math.abs((Object.values(costsIn(store))[0] ?? 0) - 0.2) < 1e-9).toBe(true)
})

test('two sessions add to their own cost keys, so neither loses the other, and the old shared total still counts', async ($, on) => {
  const { state, store } = engine(on)
  const today = '2026-11-13'
  // Another session spent $0.40 today under its own key, and a version before 0.4.4 left $1.00 in the shared total.
  store.set(`cost:${today}:other:400000`, true)
  store.set('daily', { [today]: 1 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.cost = 0.8
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'hi', turnId: 't2' })
  state.cost = 0.9
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't2', reason: 'answer' })

  // This session's two turns ($0.30 and $0.10) sit in one key of its own; the other session's key is untouched.
  expect([...store.keys()].filter(k => k.startsWith('cost:')).sort()).toEqual([`cost:${today}:abc:400000`, `cost:${today}:other:400000`])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^today \$1\.80 · 7 days \$1\.80/ })).toBeDefined()
  await ui.unmount()
})

test('a context fill that is not known yet shows as a dash, not as a safe 0%', async ($, on) => {
  const { state } = engine(on)
  state.percent = undefined
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.tail ?? ''}</Text>
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const hint = await $.ui.mount({ plugin: 'pulse', component: 'PromptHint', surface: 'terminal', props: { isDraft: false, isWorking: false, hint: '' } })
  expect(await hint.find({ type: 'Text', text: /^ {2}ctx - · / })).toBeDefined()
  await hint.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: '-' })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: '0%' })).toBeUndefined()
  await pane.unmount()
})

test('each window shows how far it is past or short of an even spread, with a marker at now', async ($, on) => {
  const { state } = engine(on)
  // 2 of 5 hours gone is 40%; 30% used is 10 points under an even spread. 6 of 7 days gone is 86%; 90% used is 4 over.
  state.limits = [
    { kind: 'five_hour', percentUsed: 30, resetsAt: new Date(state.now + 3 * 3_600_000).toISOString() },
    { kind: 'seven_day', percentUsed: 90, resetsAt: new Date(state.now + 24 * 3_600_000).toISOString() },
  ]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await turn($, 't1')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^5-hour: resets in 3h 0m · pace after 10 min · 10 pts under even pace$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^7-day: resets in .* · 4 pts over even pace$/ })).toBeDefined()
    await ui.unmount()
  }
  // The caret sits under the 12th of the 30 bar cells, 40% of the way; the 7-day caret under the 25th, 6 of 7 days in.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^ {8}[ ╵]{12}▲[ ╵]*$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {8}[ ╵]{25}▲[ ╵]*$/ })).toBeDefined()
  await ui.unmount()
})

test('on the terminal a Limits row fits the pane: the label and the bar fill the cells together', async ($, on) => {
  const { state } = engine(on)
  state.limits = [{ kind: 'five_hour', percentUsed: 30 }]
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await turn($, 't1')

  // A body of 40 columns gives 38 cells: an 8-cell label and a 30-cell bar.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^5-hour  [█░]{30}$/ })).toBeDefined()
  await ui.unmount()
})
