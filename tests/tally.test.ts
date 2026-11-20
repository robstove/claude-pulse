import { expect, test } from 'claude-code/testing'

import { EMPTY } from '../hooks/state'
import { apply } from '../hooks/tally'
import type { Observation } from '../hooks/tally'

// The tally's rules, fed plain observations: no engine, no store, no pane.

const call = (over: Partial<Extract<Observation, { kind: 'tool' }>> = {}): Observation => ({
  kind: 'tool',
  tool: 'Bash',
  input: { command: 'ls' },
  asked: false,
  denied: false,
  deny: false,
  isError: false,
  result: {},
  aborted: false,
  startedAt: 1_000,
  endedAt: 1_400,
  ...over,
})

const run = (...os: Observation[]) => os.reduce(apply, EMPTY)

test('a call refused by a rule, a plugin, or a no at the dialog counts as refused, with no time and no running call', async () => {
  const m = run(
    { kind: 'turn-start', now: 0 },
    call({ denied: true, isError: true }),
    call({ deny: true }),
    call({ asked: true, isError: true, text: "The user doesn't want to proceed with this tool use." }),
  )
  expect(m.toolRefusals).toBe(3)
  expect(m.toolCalls).toBe(0)
  expect(m.toolErrors).toBe(0)
  expect(m.byTool.Bash?.refused).toBe(3)
  expect(m.running.toolCalls).toBe(0)
})

test('an asked call keeps its span as wait time; an interrupted call is no failure; an error is one', async () => {
  const m = run(call({ asked: true }), call({ isError: true, aborted: true }), call({ isError: true }))
  expect(m.toolWaited).toBe(1)
  expect(m.toolWaitMs).toBe(400)
  expect(m.toolMsTotal).toBe(800)
  expect(m.toolErrors).toBe(1)
  expect(m.byTool.Bash?.samples).toEqual([400, 400])
})

test("a subagent's call and step count in the totals but not in the running main turn", async () => {
  const m = run(
    { kind: 'turn-start', now: 0 },
    call({ agentId: 'a1' }),
    { kind: 'step', agentId: 'a1', startedAt: 0, firstAt: 100, endedAt: 500, output: 50, serverTools: [], stopReason: 'end_turn' },
  )
  expect(m.toolCalls).toBe(1)
  expect(m.steps.count).toBe(1)
  expect(m.running).toEqual({ startedAt: 0, toolCalls: 0, steps: 0 })
})

test('a main turn records its calls, steps, and cost, and an input count that holds the cache', async () => {
  const usage = { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1_000, cache_creation_input_tokens: 90 }
  const session = { costUsd: 1.5, contextPct: 12, rateLimits: [] }
  const m = run(
    { kind: 'session-end', costUsd: 1 },
    { kind: 'turn-start', now: 0 },
    call(),
    { kind: 'step', startedAt: 0, firstAt: 100, endedAt: 500, output: 50, serverTools: [], stopReason: 'end_turn' },
    { kind: 'turn-end', durationMs: 2_000, isAborted: false, reason: 'answer', usage, now: 2_000, session },
  )
  expect(m.turns).toEqual([{ ms: 2_000, inputTokens: 1_100, outputTokens: 5, costUsd: 0.5, contextPct: 12, toolCalls: 1, isAborted: false, steps: 1, reason: 'answer' }])
  expect(m.inputTokens).toBe(10)
  expect(m.cacheReadTokens).toBe(1_000)
  expect(m.lastCostUsd).toBe(1.5)
  expect(m.running.startedAt).toBeNull()
})

test('with no clock at its end a turn keeps the cost baseline, so the next turn carries its spend to the ledger', async () => {
  const session = { costUsd: 1.4, contextPct: 12, rateLimits: [] }
  const m = run(
    { kind: 'session-end', costUsd: 1 },
    { kind: 'turn-start', now: 0 },
    { kind: 'turn-end', durationMs: 2_000, isAborted: false, reason: 'answer', session },
  )
  expect(m.turns[0]?.costUsd).toBeNull()
  expect(m.lastCostUsd).toBe(1)
  expect(m.mainTurns).toBe(1)
})

test("a precompute, a subagent's compaction, a skipped one, and a prompt that is not the person's change nothing", async () => {
  const m = run(
    { kind: 'compaction', at: 1, trigger: 'precompute', isSkipped: false },
    { kind: 'compaction', at: 1, trigger: 'auto', agentId: 'a1', isSkipped: false },
    { kind: 'compaction', at: 1, trigger: 'auto', isSkipped: true },
    { kind: 'prompt', origin: 'task-notification', isMeta: false, isDropped: false },
    { kind: 'prompt', isMeta: false, isDropped: true },
  )
  expect(m).toEqual(EMPTY)
})

test('a background task is timed from its call to the notification that ends it', async () => {
  const m = run(
    call({ result: { status: 'async_launched', agentId: 'task-1' }, input: { description: 'Review the diff' } }),
    { kind: 'notice', text: '<task-notification><task-id>task-1</task-id><status>completed</status></task-notification>', now: 9_000 },
  )
  expect(m.tasks).toEqual({})
  expect(m.background).toEqual({ count: 1, failed: 0, stopped: 0, ms: 8_000 })
  expect(m.slowest[0]).toEqual({ tool: 'Bash', ms: 8_000, label: 'Review the diff', background: true })
})
