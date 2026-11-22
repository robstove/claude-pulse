import { expect, test } from 'claude-code/testing'

import { callEnded, callStarted, callWaits, progress, quiet, shouldAlert, touch, watchStart } from '../hooks/watch'
import { fmtMs } from '../hooks/charts'
import { liveStatus, stripSvg, toolTimeText } from '../hooks/sections/turns'
import type { LiveTurn } from '../hooks/sections/ui'
import { HINT, PANE } from './kit'
import type { Dollar } from './kit'
import { engine, runStep, step } from './live'

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

// /compact as the person types it in the terminal.
const COMPACT = { command: 'compact', args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 80 } }

// The context caption of the pane: the compaction count, the tokens, and the fill.
const contextLine = async ($: Dollar) => {
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const text = (await pane.find({ type: 'Text', text: / \/ 200\.0k/ }))?.text
  await pane.unmount()
  return text
}

test('a /compact between turns redraws the context with its estimate, though a policy plugin keeps session.compact from Pulse', async ($, on) => {
  const { state } = engine(on)
  // The engine's /compact, with no session.compact raise: the policy plugin passes that event past user plugins. As live on
  // 2.1.326, the API count stays set (the compaction request's own count), and only the local count shrinks.
  on('command.run', { command: 'compact' }, () => {
    state.estimate = 30_000
    return { text: 'Compacted' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.command.run(COMPACT)
  expect(await contextLine($)).toBe('1 compacted · ~30.0k / 200.0k  ~15%')
  // The next response counts the window, and the estimate goes.
  state.tokens = 40_000
  state.percent = 20
  await turn($, 't2')
  expect(await contextLine($)).toBe('1 compacted · 40.0k / 200.0k  20%')
})

test('the context says it compacts while /compact runs, and stops when it ends', async ($, on) => {
  const { state } = engine(on)
  let during: string | undefined
  on('command.run', { command: 'compact' }, async () => {
    during = await contextLine($)
    state.estimate = 30_000
    return { text: 'Compacted' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.command.run(COMPACT)
  expect(during).toBe('50.0k / 200.0k  compacting…')
  expect(await contextLine($)).toBe('1 compacted · ~30.0k / 200.0k  ~15%')
})

test('a /compact that fails records no compaction', async ($, on) => {
  engine(on)
  on('command.run', { command: 'compact' }, () => ({ text: 'Error: Not enough messages to compact.' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.command.run(COMPACT)
  expect(await contextLine($)).toBe('50.0k / 200.0k  25%')
})

test('where session.compact reaches Pulse, a /compact counts once and shows the size the compaction reports', async ($, on) => {
  const { state } = engine(on)
  on('session.compact', () => ({ messages: [{ role: 'user' as const, text: 'summary', toolUses: [] }], tokensBefore: 150_000, tokensAfter: 20_000 }))
  on('command.run', { command: 'compact' }, async () => {
    const summary = { role: 'user' as const, text: 'summary', toolUses: [] }
    await $.session.compact({ trigger: 'manual', messages: [summary, summary] })
    state.tokens = undefined
    state.percent = undefined
    return { text: 'Compacted' }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await turn($, 't1')
  await $.command.run(COMPACT)
  expect(await contextLine($)).toBe('1 compacted · ~20.0k / 200.0k  ~10%')
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

// The header alone says Idle; the strip says only that no turn ran yet.
const stripIdle = async (pane: { find: (q: { type: string; text: string }) => Promise<unknown> }) =>
  (await pane.find({ type: 'Text', text: 'No turn yet' })) !== undefined

test('between turns the strip stays, still, with the last turn faded; before a turn and after /clear it says no turn ran', async ($, on) => {
  const { state } = engine(on)
  step(on)
  on('session.end', () => ({ sessionId: 'abc' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const fresh = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await stripIdle(fresh)).toBe(true)
  await fresh.unmount()

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await runStep($, 't1')
  state.now += 4_000
  state.cost = 0.68
  await $.turn.complete({ answer: '', durationMs: 4_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await term.find({ type: 'Text', text: 'Last turn 4s · $0.1800 · 1 request · 0 calls' })).toBeDefined()
  expect(await term.findAll({ type: 'Text', text: /^Idle ·/ })).toEqual([])
  await term.unmount()
  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const strip = (await desk.findAll({ type: 'Svg' })).find(c => String(c.props.alt).startsWith('Last turn'))
  expect(String(strip?.props.source)).toContain('opacity="0.45"')
  expect(String(strip?.props.source)).not.toContain('class="sweep"')
  expect(String(strip?.props.source)).not.toContain('class="ring"')
  await desk.unmount()

  await $.session.end({ reason: 'clear', sessionId: 'abc', resume: { id: 'abc' } })
  const cleared = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await stripIdle(cleared)).toBe(true)
  await cleared.unmount()
})

test('a turn that ran no step, as /compact does, still shows as the last turn', async ($, on) => {
  engine(on)
  step(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: '/compact', turnId: 't1' })
  await $.turn.complete({ answer: '', durationMs: 3_000, isAborted: false, turnId: 't1', reason: 'answer' })
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await stripIdle(term)).toBe(false)
  expect(await term.find({ type: 'Text', text: /^Last turn 3s/ })).toBeDefined()
  await term.unmount()
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
