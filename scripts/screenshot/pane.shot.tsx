// A made-up session for the README screenshot. scripts/screenshot.mjs copies this file into a temporary copy of the
// plugin as a test, runs it, and reads the pane's drawn tree from the line it logs. It holds no real session data.
import { expect, test } from 'claude-code/testing'

const DAY = 86_400_000
const START = Date.UTC(2026, 10, 13, 14)

test('screenshot session', async ($, on) => {
  const state = { now: START, cost: 0, context: 4, tokens: 8_000, five: 12, seven: 41 }
  const store = new Map<string, unknown>([
    ['daily', Object.fromEntries([3.1, 0, 7.4, 5.2, 0, 0, 9.8, 4.4, 6.1, 0, 2.7, 8.3, 5.9].map((usd, i) => [dayOf(START - (13 - i) * DAY), usd]))],
  ])
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: state.now }))
  on('session.id', () => ({ value: 'demo' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: START,
      context: { tokens: state.tokens, window: 1_000_000, percent: state.context },
      rateLimits: [
        { kind: 'five_hour', percentUsed: state.five, resetsAt: new Date(START + 4 * 3_600_000).toISOString() },
        { kind: 'seven_day', percentUsed: state.seven, resetsAt: new Date(START + 3 * DAY).toISOString() },
      ],
      cost: { usd: state.cost },
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_, e) => {
    const input = e as unknown as Record<string, unknown>
    state.now += Number(input.ms ?? 800)
    if (input.refuse) return { deny: 'Refused by a rule' }
    if (input.background) return { result: { stdout: '', backgroundTaskId: 'build1' } }
    return input.fail ? { result: 'error', text: 'error', isError: true } : { result: {} }
  })
  on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'sub1' }))
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 610_000, tokensAfter: 90_000 }))
  on('turn.step', async function* (_, e) {
    state.now += 1_600
    yield { kind: 'text', index: 0, text: 'ok', ref: 1 }
    state.now += 4_200
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn',
      usage: usage(e.model, 900),
      serverToolUses: e.index === 1 ? [{ id: 's1', name: 'web_search', input: {}, startedAt: 0 }] : [],
    }
  })
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const calls = [
    { tool: 'Read', file_path: '/app/src/server.ts', ms: 300 },
    { tool: 'Grep', pattern: 'x', ms: 900 },
    { tool: 'Edit', file_path: '/app/src/server.ts', ms: 600 },
    { tool: 'Bash', command: 'npm test', description: 'Run the unit tests', ms: 41_000 },
    { tool: 'Edit', file_path: '/app/src/routes/users.ts', ms: 500, fail: true },
    { tool: 'Bash', command: 'npm run lint', ms: 9_000 },
    { tool: 'Write', file_path: '/app/src/routes/users.test.ts', ms: 7_000 },
    { tool: 'Glob', pattern: 'x', ms: 200 },
    { tool: 'Bash', command: 'git push', ms: 100, refuse: true },
  ]
  for (let turn = 1; turn <= 18; turn += 1) {
    state.now += turn === 9 ? 3_600_000 : 90_000
    await $.prompt.submit({ text: 'next step', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'next step', turnId: `t${turn}` })
    for (let step = 0; step < 1 + (turn % 3); step += 1) {
      for await (const _ of $.turn.step({ turnId: `t${turn}`, index: step, model: 'claude-opus-5-5', messageCount: 1 })) {
        // Read the stream to its end.
      }
    }
    for (const { fail, refuse, ...call } of calls.slice(0, 2 + (turn % calls.length))) {
      // One failed edit and one refused push in the session, not one per turn.
      const flags = { ...(fail && turn === 5 ? { fail } : {}), ...(refuse && turn === 8 ? { refuse } : {}) }
      await $.tool.call({ ...call, ...flags, tool_use_id: `u${turn}-${call.tool}-${call.ms}` } as never)
    }
    if (turn === 6) {
      await $.agent.spawn({
        tool_use_id: 'a1',
        prompt: 'look around',
        description: 'Map the routes',
        subagentType: 'Explore',
        provider: { plugin: 'engine', tier: 'core' },
        parentModel: 'claude-opus-5-5',
        permissionMode: 'default',
        background: false,
        fork: false,
      })
      await $.turn.complete({ answer: '', durationMs: 48_000, isAborted: false, turnId: 'a-t1', agentId: 'sub1', reason: 'answer', usage: usage('claude-sonnet-5-5', 3_000) })
    }
    if (turn === 12) await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', run_in_background: true, background: true, ms: 400, tool_use_id: 'bg' } as never)
    if (turn === 14) {
      state.now += 380_000
      await $.prompt.submit({ text: '<task-notification>\n<task-id>build1</task-id>\n<status>completed</status>\n</task-notification>', wait: false, origin: { kind: 'task-notification' } })
    }
    state.cost += 0.35 + (turn % 4) * 0.22
    state.tokens = turn === 11 ? 90_000 : state.tokens + 42_000 + (turn % 5) * 9_000
    state.context = Math.round(state.tokens / 10_000)
    state.five = Math.min(96, state.five + 2)
    state.seven = Math.min(96, state.seven + (turn % 4 === 0 ? 1 : 0))
    if (turn === 11) await $.session.compact({ trigger: 'auto', messages: [] })
    const durationMs = 20_000 + (turn % 5) * 14_000 + (turn === 7 ? 160_000 : 0)
    await $.turn.complete({ answer: '', durationMs, isAborted: turn === 15, turnId: `t${turn}`, reason: turn === 15 ? 'aborted' : 'answer', usage: usage('claude-opus-5-5', 2_400) })
  }

  const ui = await $.ui.mount({
    plugin: 'pulse',
    component: 'Pane',
    requestId: 'pulse',
    surface: 'desktop',
    props: { title: 'Pulse', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 200 }, view: {} },
  })
  expect(await ui.find({ type: 'Text', text: 'Slowest calls' })).toBeDefined()
  console.log(`PULSE_SCREENSHOT ${JSON.stringify(await ui.drawn())}`)
  await ui.unmount()
})

function usage(model: string, output: number) {
  return { model, input_tokens: 40, output_tokens: output, cache_read_input_tokens: 58_000, cache_creation_input_tokens: 3_100 }
}

function dayOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}
