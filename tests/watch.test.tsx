import { expect, test } from 'claude-code/testing'

import { callEnded, callStarted, callWaits, progress, quiet, shouldAlert, touch, watchStart } from '../hooks/watch'
import { fmtMs } from '../hooks/charts'
import { dayKey } from '../hooks/ledger'
import { liveStatus, stripSvg, toolTimeText } from '../hooks/sections/turns'
import type { LiveTurn } from '../hooks/sections/ui'
import { HINT, PANE, memoryStore } from './kit'
import type { Dollar, On } from './kit'

type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The engine answers these tests share; `state` moves the clock, the context, and the limits, and `afters` holds each one-shot timer.
const engine = (on: On) => {
  const state = { now: Date.UTC(2026, 10, 13, 12), tokens: 50_000, percent: 25, limits: [] as Limit[], compactAt: 160_000 as number | undefined, cost: 0.5 }
  const afters: number[] = []
  const toasts: string[] = []
  const store = memoryStore(on)
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.after', (_, e) => {
    afters.push(e.ms)
    return { value: undefined }
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: state.now }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: state.now - 600_000,
      context: {
        tokens: state.tokens,
        window: 200_000,
        percent: state.percent,
        // Pulse reads only these two fields of the breakdown.
        breakdown: { isAutoCompactEnabled: state.compactAt !== undefined, autoCompactThreshold: state.compactAt } as never,
      },
      rateLimits: state.limits,
      cost: { usd: state.cost },
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { state, afters, toasts, store }
}

const turn = async ($: Dollar, id: string) => {
  await $.turn.start({ text: 'hi', turnId: id })
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
}

test('between turns the pane and the hint count down the prompt cache, and a toast is set before it expires', async ($, on) => {
  const { state, afters } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  // No rate limits means an API key: a 5-minute cache, and a toast a minute before it expires.
  expect(afters).toEqual([300_000, 240_000])

  state.now += 4.5 * 60_000
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Prompt cache warm for 30s more' })).toBeDefined()
  await pane.unmount()
  let hint = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await hint.find({ type: 'Text', text: / · cache 1m$/ })).toBeDefined()
  await hint.unmount()

  state.now += 60_000
  const cold = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await cold.find({ type: 'Text', text: 'Prompt cache expired: the next turn writes 50.0k tokens to it again.' })).toBeDefined()
  await cold.unmount()
  hint = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await hint.find({ type: 'Text', text: / · cache cold$/ })).toBeDefined()
  await hint.unmount()
})

test('a subscription session gets an hour of cache, and the cacheMinutes option overrides the guess', { options: { cacheMinutes: 20 } }, async ($, on) => {
  const { state, afters } = engine(on)
  state.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  expect(afters).toEqual([1_200_000, 900_000])
})

test('a subscription session with no option gets an hour of cache and a toast five minutes before', async ($, on) => {
  const { state, afters } = engine(on)
  state.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  expect(afters).toEqual([3_600_000, 3_300_000])
})

test('a small context sets no cache toast', async ($, on) => {
  const { state, afters } = engine(on)
  state.tokens = 5_000
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  expect(afters).toEqual([300_000])
})

test('the context section tells the turns left before auto-compaction at the mean growth per turn', async ($, on) => {
  const { state } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [i, pct] of [10, 20, 30].entries()) {
    state.percent = pct
    await turn($, `t${i}`)
  }
  // 10 points a turn; auto-compaction at 160k of 200k is 80%, 50 points from 30%.
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'About 5 turns to auto-compact at this rate.' })).toBeDefined()
  await pane.unmount()
})

test('with auto-compaction off the context section tells no runway', async ($, on) => {
  const { state } = engine(on)
  state.compactAt = undefined
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const [i, pct] of [10, 20, 30].entries()) {
    state.percent = pct
    await turn($, `t${i}`)
  }
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: /auto-compact/ })).toBeUndefined()
  await pane.unmount()
})

test('a running turn shows its quiet time, amber past the stall limit, and a toast says so once', async ($, on) => {
  const { state, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.now += 4 * 60_000
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const found = await pane.find({ type: 'Text', text: 'Working · quiet 4m 0s · 0 requests · 0 calls' })
  expect(found?.props.color).toBe('warning')
  await pane.unmount()
  expect(toasts).toEqual(['\u26a0 Pulse: no model output or tool call for 4m 0s.'])
})

test('the stall watch alerts once per quiet stretch and names a call that runs long', async () => {
  watchStart(0)
  callStarted('c1', 'Bash', 1_000)
  expect(shouldAlert(100_000, 180_000)).toBe(false)
  expect(shouldAlert(200_000, 180_000)).toBe(true)
  expect(shouldAlert(210_000, 180_000)).toBe(false)
  expect(quiet(210_000)).toEqual({ ms: 209_000, call: { tool: 'Bash', ms: 209_000 } })
  // A chunk counts as progress at the next check, so a long stream is no stall.
  touch()
  expect(quiet(250_000)?.ms).toBe(0)
  progress(260_000)
  expect(shouldAlert(450_000, 180_000)).toBe(true)
  expect(shouldAlert(500_000, 0)).toBe(false)
})

test('a call that waits at the permission dialog keeps the turn from going quiet', async () => {
  watchStart(0)
  callStarted('c1', 'Bash', 1_000)
  callWaits('c1')
  expect(shouldAlert(600_000, 180_000)).toBe(false)
  expect(quiet(600_000)?.ms).toBe(0)
  callEnded('c1', 700_000)
  expect(shouldAlert(800_000, 180_000)).toBe(false)
  expect(shouldAlert(900_000, 180_000)).toBe(true)
})

test('tool.check, which runs inside the tool call, marks the call as waiting before the person answers', async ($, on) => {
  const { state, toasts } = engine(on)
  // The engine runs tool.check inside tool.call's next, then shows the dialog. The person takes 5 minutes, and the running
  // turn's ticks run while the dialog is open: none of them may call the turn stalled.
  on('tool.check', () => ({ decision: 'ask' }))
  // A real wait, so the engine's tick timers run while the dialog is open; the test types carry no DOM timer.
  const { setTimeout } = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }
  on('classic.PermissionRequest', async () => {
    state.now += 5 * 60_000
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    return { decision: { behavior: 'allow' } }
  })
  on('tool.call', () => ({ result: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'u1' })
  expect(toasts).toEqual([])
})

// A step mock: one chunk, then an answer.
const step = (on: On) =>
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'hi', ref: 1 }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })

const runStep = async ($: Dollar, turnId: string) => {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Read the stream to its end.
  }
}

test('the cache countdown runs from the last request, and /clear leaves no countdown for the new conversation', async ($, on) => {
  const { state } = engine(on)
  step(on)
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await runStep($, 't1')
  // The answer streams for 2 minutes after its request started: 3 of the 5 cache minutes are left at the turn's end.
  state.now += 2 * 60_000
  await $.turn.complete({ answer: '', durationMs: 120_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const hint = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await hint.find({ type: 'Text', text: / · cache 3m$/ })).toBeDefined()
  await hint.unmount()

  await $.session.end({ reason: 'clear', sessionId: 'abc', resume: { id: 'abc' } })
  const cleared = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await cleared.find({ type: 'Text', text: /cache/ })).toBeUndefined()
  await cleared.unmount()
})

test('a compaction inside a turn is no stall, however long it runs', async ($, on) => {
  const { state, toasts } = engine(on)
  const { setTimeout } = globalThis as unknown as { setTimeout: (fn: () => void, ms: number) => void }
  on('session.compact', async () => {
    state.now += 5 * 60_000
    await new Promise<void>(resolve => setTimeout(resolve, 50))
    return { messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 20_000 }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
  await $.session.compact({ trigger: 'auto', messages: [summary, summary] })
  expect(toasts).toEqual([])
})

test("the 7-day bar draws each day's spend between its day ticks", async ($, on) => {
  const { state } = engine(on)
  state.limits = [{ kind: 'seven_day', percentUsed: 40, resetsAt: new Date(state.now + 3 * 24 * 3_600_000).toISOString() }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  state.cost = 2.5
  await turn($, 't2')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const charts = await pane.findAll({ type: 'Svg' })
  const limits = charts.find(c => String(c.props.alt).startsWith('Rate limits'))
  expect(String(limits?.props.source)).toContain('2026-11-13: $2.00 spent by the sessions on this computer')
  expect(String(limits?.props.source)).toContain('>Spend</text>')
  expect(String(limits?.props.source)).toContain('>$2.00</text>')
  await pane.unmount()
})

test('the sections option draws only the named sections, in its order', { options: { sections: 'tokens, Limits, nothing' } }, async ($, on) => {
  const { state } = engine(on)
  state.limits = [{ kind: 'five_hour', percentUsed: 10 }]
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const titles = (await pane.findAll({ type: 'Text', text: /^(Tokens|Limits|Context|Turns|Session cost)$/ })).map(t => t.text)
  expect(titles).toEqual(['Tokens', 'Limits'])
  await pane.unmount()
})

test('a span past two days reads in days and hours', async () => {
  expect(fmtMs((175 * 60 + 27) * 60_000)).toBe('7d 7h')
  expect(fmtMs((54 * 60 + 18) * 60_000)).toBe('2d 6h')
  expect(fmtMs((47 * 60 + 5) * 60_000)).toBe('47h 5m')
})

const running = (over: Partial<LiveTurn> = {}): LiveTurn => ({
  ms: 72_000,
  toolCalls: 1,
  steps: [
    { kind: 'request', name: 'Model request', detail: '', fromMs: 0, toMs: 6_000, waits: false },
    { kind: 'tool', name: 'Read', detail: 'src/a.ts', fromMs: 6_000, toMs: 7_000, waits: false },
    { kind: 'request', name: 'Model request', detail: '', fromMs: 7_000, toMs: 61_000, waits: false },
    { kind: 'tool', name: 'Bash', detail: 'npm', fromMs: 61_000, toMs: null, waits: false },
  ],
  quietMs: 11_000,
  stallMs: 180_000,
  ...over,
})

test('the step strip names the open step and how long it has run, and animates it in green', async () => {
  const live = running()
  expect(liveStatus(live).now).toBe('Bash · npm · running 11s')
  expect(liveStatus(live).counts).toBe('2 requests · 2 calls')
  const source = stripSvg(400, live)
  expect(source).toContain('#3fb950')
  expect(source).toContain('class="sweep"')
  expect(source).toContain('class="ring"')
  // The phase comes from the turn's time, so each redraw continues the sweep where the last one was.
  expect(source).toContain('animation-delay:-0ms')
  expect(stripSvg(400, running({ ms: 72_400 }))).toContain('animation-delay:-400ms')
})

test('past the stall limit the open step is amber and still', async () => {
  const live = running({ ms: 300_000, quietMs: 240_000 })
  expect(liveStatus(live).now).toBe('Bash · npm · quiet 4m 0s')
  const source = stripSvg(400, live)
  expect(source).toContain('#d29922')
  expect(source).not.toContain('class="sweep"')
  expect(source).not.toContain('class="ring"')
})

test('a call put to approval shows as running, green and moving, and never counts as quiet', async () => {
  // In auto mode the classifier decides nearly every call that writes, so these calls are usually running.
  const steps = running().steps.map(st => (st.toMs === null ? { ...st, waits: true } : st))
  const live = running({ steps, ms: 300_000, quietMs: 240_000 })
  expect(liveStatus(live).now).toBe('Bash · npm · running 3m 59s')
  expect(liveStatus(live).stalled).toBe(false)
  const source = stripSvg(400, live)
  expect(source).toContain('#3fb950')
  expect(source).toContain('class="sweep"')
  expect(source).not.toContain('#d29922')
})

test('a turn quiet past 30 s but under the stall limit says so, still in green', async () => {
  expect(liveStatus(running({ quietMs: 45_000 })).now).toBe('Bash · npm · running 11s · quiet 45s')
})

test('with no open step the strip says the turn is working since its last step ended', async () => {
  const live = running({ steps: running().steps.map(st => ({ ...st, toMs: st.toMs ?? 70_000 })) })
  expect(liveStatus(live).now).toBe('Working · running 2s')
  expect(stripSvg(400, live)).not.toContain('class="sweep"')
})

test('the running turn draws its requests and calls as a strip, and the terminal shows its status line', async ($, on) => {
  const { state } = engine(on)
  step(on)
  on('tool.call', () => {
    state.now += 3_000
    return { result: {} }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await runStep($, 't1')
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/a.ts', tool_use_id: 'u1' })
  state.now += 5_000
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'Working · running 5s · 1 request · 1 call' })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const strip = (await desk.findAll({ type: 'Svg' })).find(c => String(c.props.alt).startsWith('Running turn'))
  expect(strip?.props.alt).toBe('Running turn: Working · running 5s')
  await desk.unmount()
})

test('a request that throws mid-stream ends its step, so the strip shows nothing still running', async ($, on) => {
  const { state } = engine(on)
  on('turn.step', async function* () {
    yield { kind: 'text', index: 0, text: 'hi', ref: 1 }
    throw new Error('overloaded')
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  try {
    for await (const _ of $.turn.step({ turnId: 't1', index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
      // Read the stream until it throws.
    }
  } catch {
    // The engine retries or ends the turn; the strip must not keep the step open.
  }
  state.now += 2_000
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'Working · running 2s · 1 request · 0 calls' })).toBeDefined()
  await term.unmount()
})

test('between turns the strip stays, still, with the last turn faded; before a turn and after /clear it says Idle', async ($, on) => {
  const { state } = engine(on)
  step(on)
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const fresh = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await fresh.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  await fresh.unmount()

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await runStep($, 't1')
  state.now += 4_000
  state.cost = 0.68
  await $.turn.complete({ answer: '', durationMs: 4_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'Idle · last turn 4s · $0.1800 · 1 request · 0 calls' })).toBeDefined()
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const strip = (await desk.findAll({ type: 'Svg' })).find(c => String(c.props.alt).startsWith('Idle'))
  expect(String(strip?.props.source)).toContain('opacity="0.45"')
  expect(String(strip?.props.source)).not.toContain('class="sweep"')
  expect(String(strip?.props.source)).not.toContain('class="ring"')
  await desk.unmount()

  await $.session.end({ reason: 'clear', sessionId: 'abc', resume: { id: 'abc' } })
  const cleared = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await cleared.find({ type: 'Text', text: 'Idle' })).toBeDefined()
  await cleared.unmount()
})

test('the pane header has a dot that pulses green while a turn runs and stays grey and still between turns', async ($, on) => {
  const { state } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const dot = async () => {
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const found = (await pane.findAll({ type: 'Svg' })).find(c => c.props.width === 12)
    await pane.unmount()
    return found
  }
  const idle = await dot()
  expect(idle?.props.alt).toBe('No turn running')
  expect(String(idle?.props.source)).toContain('#8b949e')
  expect(String(idle?.props.source)).not.toContain('class="ring"')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.now += 12_000
  const busy = await dot()
  expect(busy?.props.alt).toBe('Working · running 12s')
  expect(String(busy?.props.source)).toContain('#3fb950')
  expect(String(busy?.props.source)).toContain('class="ring"')
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: '●' }))?.props.color).toBe('success')
  expect(await term.find({ type: 'Text', text: 'Elapsed · running 12s' })).toBeDefined()
  await term.unmount()
})

test('a tool that fails 3 times in a row gives one toast; a success or a new turn starts the count again', async ($, on) => {
  const { toasts } = engine(on)
  const answers: Record<string, unknown> = { Bash: { result: {}, isError: true, text: 'exit 1' }, Read: { result: {} } }
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', (_, e) => (answers[e.tool] ?? { result: {} }) as never)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const call = (tool: string, n: number) => $.tool.call({ tool, command: 'npm test', file_path: '/a.ts', tool_use_id: `${tool}${n}` } as never)
  await call('Bash', 1)
  // Another tool between the failures does not break the loop.
  await call('Read', 2)
  await call('Bash', 3)
  expect(toasts).toEqual([])
  await call('Bash', 4)
  expect(toasts).toEqual(['\u26a0 Pulse: Bash (npm) failed 3 times in a row.'])
  await call('Bash', 5)
  expect(toasts.length).toBe(1)

  answers.Bash = { result: {} }
  await call('Bash', 6)
  answers.Bash = { result: {}, isError: true, text: 'exit 1' }
  await call('Bash', 7)
  await call('Bash', 8)
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: 'again', turnId: 't2' })
  await call('Bash', 9)
  await call('Bash', 10)
  expect(toasts.length).toBe(1)
  await call('Bash', 11)
  expect(toasts.length).toBe(2)
})

test('a subagent counts its failures apart and says so; a refused call starts the count again; parallel failures are one try', async ($, on) => {
  const { state, toasts } = engine(on)
  // Each call takes 1 s on the clock, so calls in a row never overlap.
  on('tool.check', (_, e) => ({ decision: e.tool_use_id === 'b5' ? 'deny' : 'allow' }))
  on('tool.call', (_, e) => {
    state.now += 1_000
    return (e.tool_use_id === 'b5' ? { deny: 'Permission denied' } : { result: {}, isError: true, text: 'exit 1' }) as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const bash = (n: number, agentId?: string, command = 'npm test') => $.tool.call({ tool: 'Bash', command, tool_use_id: `b${n}`, agentId } as never)
  await bash(1)
  await bash(2, 'a1')
  await bash(3)
  await bash(4, 'a1')
  // A refusal is no failure, so the main loop's count starts again.
  await bash(5, undefined, 'rm -rf /')
  await bash(6)
  await bash(7, 'a1')
  expect(toasts).toEqual(['\u26a0 Pulse: Bash (npm) failed 3 times in a row in a subagent.'])
  await bash(8)
  expect(toasts.length).toBe(1)

  // Three failures that run together are one try, so no toast.
  await $.turn.start({ text: 'again', turnId: 't2' })
  await Promise.all([bash(9), bash(10), bash(11)])
  expect(toasts.length).toBe(1)
})

test('the last turn names the three tools that took the most time, with their counts, and leaves out calls put to approval', () => {
  const tool = (name: string, fromMs: number, toMs: number, waits = false) => ({ kind: 'tool' as const, name, detail: '', fromMs, toMs, waits })
  const steps = [
    { kind: 'request' as const, name: 'model', detail: '', fromMs: 0, toMs: 90_000, waits: false },
    tool('Bash', 0, 20_000),
    tool('Bash', 20_000, 42_000),
    tool('Read', 0, 2_000),
    tool('Grep', 0, 1_000),
    tool('Glob', 0, 500),
    tool('Edit', 0, 600_000, true),
  ]
  expect(toolTimeText(steps)).toBe('Tool time: Bash 42s (2) · Read 2s · Grep 1s')
  expect(toolTimeText(steps.slice(0, 1))).toBeNull()
})

test('between turns the pane names the tool time of the last turn, without the call that waited on the person', async ($, on) => {
  const { state } = engine(on)
  on('tool.check', (_, e) => ({ decision: e.tool_use_id === 'p1' ? 'ask' : 'allow' }))
  on('classic.PermissionRequest', () => {
    state.now += 5 * 60_000
    return { decision: { behavior: 'allow' } }
  })
  on('tool.call', () => {
    state.now += 2_000
    return { result: {} } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Edit', file_path: '/a.ts', old_string: 'a', new_string: 'b', tool_use_id: 'p1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b1' } as never)
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: 'Tool time: Bash 2s' })).toBeDefined()
  await pane.unmount()
})

test("the budget mark of another session holds back a toast only for the same day and the same budget", { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, toasts, store } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const passWith = async (mark: { day: string; level: number; budget: number }, id: string) => {
    store.set('budget', mark)
    await $.turn.start({ text: 'hi', turnId: id })
    state.cost += 2
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
  }
  // The ledger keys the local day, so the test reads it the same way; an earlier day's mark is a day that has passed.
  const today = dayKey(state.now)
  await passWith({ day: today, level: 1, budget: 1 }, 't1')
  expect(toasts).toEqual([])
  await passWith({ day: today, level: 1, budget: 2 }, 't2')
  expect(toasts.length).toBe(1)
  await passWith({ day: '2000-01-01', level: 1, budget: 1 }, 't3')
  expect(toasts.length).toBe(2)
})

test('a spend that jumps past the budget in one turn gives one toast, and the History caption turns red', { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.cost = 2
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(toasts).toEqual(["\u26a0 Pulse: today's spend of $1.50 has passed the $1.00 daily budget."])
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await pane.find({ type: 'Text', text: 'Today is at 150% of the daily budget.' }))?.props.color).toBe('error')
  await pane.unmount()
})

test('a daily budget toasts once at 80% and once at 100%, and the History meta shows the share', { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, toasts } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const spend = async (id: string, cost: number) => {
    await $.turn.start({ text: 'hi', turnId: id })
    state.cost = cost
    await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
  }
  await spend('t1', 1.0)
  expect(toasts).toEqual([])
  await spend('t2', 1.3)
  expect(toasts).toEqual(["\u26a0 Pulse: today's spend of $0.8000 is 80% of the $1.00 daily budget."])
  await spend('t3', 1.4)
  expect(toasts.length).toBe(1)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^today \$0\.9000 of \$1\.00 · 7 days/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: 'Today is at 90% of the daily budget.' }))?.props.color).toBe('warning')
  await pane.unmount()
  await spend('t4', 1.6)
  expect(toasts[1]).toBe("\u26a0 Pulse: today's spend of $1.10 has passed the $1.00 daily budget.")
  await spend('t5', 1.7)
  expect(toasts.length).toBe(2)
})

test("a subagent's end starts its count again, and the main loop's count goes on", async ($, on) => {
  const { state, toasts } = engine(on)
  on('tool.check', () => ({ decision: 'allow' }))
  on('tool.call', () => {
    state.now += 1_000
    return { result: {}, isError: true, text: 'exit 1' } as never
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  const bash = (n: number, agentId?: string) => $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: `b${n}`, agentId } as never)
  await bash(1, 'a1')
  await bash(2, 'a1')
  await bash(3)
  await bash(4)
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 'a1-turn', reason: 'answer', agentId: 'a1' } as never)
  await bash(5, 'a1')
  expect(toasts).toEqual([])
  await bash(6)
  expect(toasts).toEqual(['\u26a0 Pulse: Bash (npm) failed 3 times in a row.'])
})
