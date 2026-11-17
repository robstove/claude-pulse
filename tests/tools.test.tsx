import { expect, test } from 'claude-code/testing'

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: { title: 'Pulse', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const HINT = { plugin: 'pulse', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '' } } as const

// A clock the test moves, and a store; `tool.call` answers from `answers` by tool name. tool.check asks for the tools in `asks`,
// holding each for 5 s as a person would, and refuses those in `denies`, as a permission rule does.
const world = (on: On, answers: Record<string, unknown> = {}, asks: readonly string[] = [], denies: readonly string[] = []) => {
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
  on('tool.check', (_, e) => {
    if (denies.includes(e.tool)) return { decision: 'deny' }
    if (!asks.includes(e.tool)) return { decision: 'allow' }
    clock.now += 5_000
    return { decision: 'ask' }
  })
  on('tool.call', (_, e) => {
    clock.now += 3_000
    return (answers[e.tool] ?? { result: {} }) as never
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
  return { clock }
}

const hintLine = async ($: Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]) => {
  const ui = await $.ui.mount({ ...HINT, surface: 'desktop' })
  const line = (await ui.find({ type: 'Text', text: /ctx/ }))?.text
  await ui.unmount()
  return line
}

test('a refused call counts as refused, not as an error, and adds no time', async ($, on) => {
  world(on, { Bash: { deny: 'Permission denied' } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'u2' })

  expect(await hintLine($)).toContain('2 tools (1 refused)')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2 calls · 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / · 1 refused/ })).toBeDefined()
  await ui.unmount()
})

test('a call that a permission rule refuses counts as refused, though the engine answers it with an error', async ($, on) => {
  world(on, {}, [], ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'rm -rf /', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'u2' })

  expect(await hintLine($)).toContain('2 tools (1 refused)')
})

test('a tool error is still an error', async ($, on) => {
  world(on, { Bash: { result: 'exit 1', text: 'exit 1', isError: true } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'false', tool_use_id: 'u1' })
  expect(await hintLine($)).toContain('1 tools (1 err)')
})

test('a call put to a decider counts with no time, so the wait for approval is no tool time', async ($, on) => {
  // The kit has no person to answer an ask, so the asked call ends in an error; its time stays out all the same.
  world(on, {}, ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'u2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2 calls · 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: / · 1 with approval 5s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Bash +1× approval$/ })).toBeDefined()
  await ui.unmount()
})

test('a background task is timed to its notification, which is no prompt of the person', async ($, on) => {
  const { clock } = world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'build it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', run_in_background: true, tool_use_id: 'u1' })

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

test('a background task that was killed counts as stopped, not as failed or done well', async ($, on) => {
  const { clock } = world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'u1' })
  clock.now += 60_000
  const notice = '<task-notification>\n<task-id>bg1</task-id>\n<status>killed</status>\n</task-notification>'
  await $.prompt.submit({ text: notice, wait: false, origin: { kind: 'task-notification' } })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: / · 1 background done in 1m 3s, 1 stopped/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeUndefined()
  await ui.unmount()
})

test('a background task that a subagent starts is not timed, because its end goes to that subagent', async ($, on) => {
  world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'u1', agentId: 'a1' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^1 calls/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /in background/ })).toBeUndefined()
  await ui.unmount()
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
