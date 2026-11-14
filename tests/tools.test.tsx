import { expect, test } from 'claude-code/testing'

import { ran } from './calls'

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: { title: 'Pulse', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const HINT = { plugin: 'pulse', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } } as const

// A clock the test moves, and a store. tool.check refuses the tools in `denies`; the tool itself never runs in the kit.
const world = (on: On, denies: readonly string[] = []) => {
  const clock = { now: 10_000 }
  const store = new Map<string, unknown>()
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: clock.now }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 140_000, window: 200_000, percent: 70 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('tool.check', (_, e) => ({ decision: denies.includes(e.tool) ? 'deny' : 'allow', reason: 'a rule' }))
  on('tool.call', () => ({ result: {} }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('classic.PermissionDenied', () => ({}))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  return { clock }
}

const hintLine = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]) => {
  const ui = await $.ui.mount({ ...HINT, surface: 'desktop' })
  const line = (await ui.find({ type: 'Text', text: /ctx/ }))?.text
  await ui.unmount()
  return line
}

test('a call a rule or auto mode refused counts as refused, not as an error, and adds no time', async ($, on) => {
  world(on, ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', tool_use_id: 'u1' })
  await $.classic.PermissionDenied({ tool_name: 'Write', tool_input: {}, tool_use_id: 'u2', reason: 'the classifier' })
  // A second report of one refusal counts once.
  await $.classic.PermissionDenied({ tool_name: 'Write', tool_input: {}, tool_use_id: 'u2', reason: 'the classifier' })
  await ran($, 'Read', { file_path: '/a.ts' }, { ms: 3_000 })

  expect(await hintLine($)).toContain('3 tools (2 refused)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^3 calls · 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / · 2 refused/ })).toBeDefined()
  await ui.unmount()
})

test('a call that ran after a deny Pulse saw counts as run, not refused', async ($, on) => {
  world(on, ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'u1' })
  // A plugin above Pulse turned the deny into an allow, and the tool ran.
  await ran($, 'Bash', { command: 'ls' }, { id: 'u1' })
  expect(await hintLine($)).toMatch(/ 1 tools$/)
})

test('a tool failure is an error, and an interrupt is not', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await ran($, 'Bash', { command: 'false' }, { failed: true })
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: { command: 'sleep 99' }, tool_use_id: 'u9', error: 'stopped', is_interrupt: true, duration_ms: 50 })
  expect(await hintLine($)).toContain('2 tools (1 err)')
})

test('tool time is the engine duration_ms, which holds no permission wait', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A person took two minutes to approve; the engine reports the 4s the tool ran.
  clock.now += 120_000
  await ran($, 'Bash', { command: 'git push' }, { ms: 4_000 })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^1 calls · 4s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Bash +.*1× 4s$/ })).toBeDefined()
  await ui.unmount()
})

test('a background task is timed to its notification, which is no prompt of the person', async ($, on) => {
  const { clock } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'build it', wait: false, origin: { kind: 'composer' } })
  const input = { command: 'npm run build', description: 'Build the app', run_in_background: true }
  await ran($, 'Bash', input, { ms: 3_000, response: { stdout: '', backgroundTaskId: 'bg1' } })

  const running = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await running.find({ type: 'Text', text: / · 1 in background/ })).toBeDefined()
  await running.unmount()

  clock.now += 600_000
  const notice = '<task-notification>\n<task-id>bg1</task-id>\n<status>failed</status>\n<summary>secret output</summary>\n</task-notification>'
  await $.prompt.submit({ text: notice, wait: false, origin: { kind: 'task-notification' } })

  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: / · 1 background done in 10m 3s, 1 failed/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /Bash \(background\) · Build the app/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /^1 prompt/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /secret/ })).toBeUndefined()
  await done.unmount()
})

test('the warnAt and alertAt options set when a meter turns amber and red', { options: { warnAt: 50, alertAt: 65 } }, async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await hintLine($)).toContain('■ ctx 70%')
})

test('with no options, 70% context is amber', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(await hintLine($)).toContain('▲ ctx 70%')
})
