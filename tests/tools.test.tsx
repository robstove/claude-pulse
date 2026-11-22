import { expect, test } from 'claude-code/testing'

import { HINT, PANE, memoryStore } from './kit'
import type { Dollar, On } from './kit'

// The engine's words for a no at the permission dialog.
const NO = "The user doesn't want to proceed with this tool use."

// A clock the test moves, and a store; `tool.call` answers from `answers` by tool name. tool.check asks for the tools in `asks`,
// holding each for 5 s as a person would, and refuses those in `denies`, as a permission rule does. An ask is approved, except
// for the tools in `rejects`, which the person refuses at the dialog.
const world = (
  on: On,
  answers: Record<string, unknown> = {},
  asks: readonly string[] = [],
  denies: readonly string[] = [],
  rejects: readonly string[] = [],
) => {
  const clock = { now: 10_000 }
  memoryStore(on)
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
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
  on('classic.PermissionRequest', (_, e) =>
    rejects.includes(e.tool_name) ? { decision: { behavior: 'deny', message: NO } } : { decision: { behavior: 'allow' } },
  )
  on('tool.call', (_, e) => {
    clock.now += 3_000
    return (answers[e.tool] ?? { result: {} }) as never
  })
  return { clock }
}

const hintLine = async ($: Dollar) => {
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
  expect(await ui.find({ type: 'Text', text: /^1 refused$/ })).toBeDefined()
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
  world(on, {}, ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push', tool_use_id: 'u1' })
  await $.tool.call({ tool: 'Read', file_path: '/a.ts', tool_use_id: 'u2' })

  // The approved call held 5 s for the decision and ran 3 s: all 8 s are wait, and tool time holds only the Read.
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^2 calls · 3s/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^1 with approval 8s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Bash +1× approval$/ })).toBeDefined()
  await ui.unmount()
})

test('a no at the permission dialog counts as refused, not as failed', async ($, on) => {
  world(on, {}, ['Bash'], [], ['Bash'])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'git push --force', tool_use_id: 'u1' })

  expect(await hintLine($)).toContain('1 tools (1 refused)')
})

test('a background task is timed to its notification, which is no prompt of the person, and keeps the header Live while it runs', async ($, on) => {
  const { clock } = world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.prompt.submit({ text: 'build it', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', description: 'Build the app', run_in_background: true, tool_use_id: 'u1' })

  const running = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await running.find({ type: 'Text', text: /^1 in background$/ })).toBeDefined()
  // No turn runs, but the task still works, so the header says Live.
  expect((await running.find({ type: 'Text', text: 'Live' }))?.props.color).toBe('success')
  expect(await running.find({ type: 'Text', text: '1 background task' })).toBeDefined()
  await running.unmount()
  const dot = await $.ui.mount({ ...PANE, surface: 'desktop' })
  const svg = (await dot.findAll({ type: 'Svg' })).find(c => c.props.width === 18)
  expect(svg?.props.alt).toBe('1 background task running')
  expect(String(svg?.props.source)).toContain('class="ring"')
  await dot.unmount()

  clock.now += 600_000
  const notice = '<task-notification>\n<task-id>bg1</task-id>\n<status>failed</status>\n<summary>secret output</summary>\n</task-notification>'
  await $.prompt.submit({ text: notice, wait: false, origin: { kind: 'task-notification' } })

  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /^1 background done in 10m 3s, 1 failed$/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /Bash \(background\) · Build the app/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /^1 prompt/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: /secret/ })).toBeUndefined()
  expect(await done.find({ type: 'Text', text: 'Live' })).toBeUndefined()
  expect(await done.find({ type: 'Text', text: 'Elapsed' })).toBeDefined()
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
  expect(await ui.find({ type: 'Text', text: /^1 background done in 1m 3s, 1 stopped$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeUndefined()
  await ui.unmount()
})

test('a notification under the desktop frame ends its task, and a block quoted inside a sentence ends none', async ($, on) => {
  const { clock } = world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run build', run_in_background: true, tool_use_id: 'u1' })
  clock.now += 60_000
  const quoted = 'Why does <task-notification><task-id>bg1</task-id><status>completed</status> not end it?'
  await $.prompt.submit({ text: quoted, wait: false, origin: { kind: 'composer' } })
  const open = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await open.find({ type: 'Text', text: /^1 in background$/ })).toBeDefined()
  await open.unmount()

  // turn.start carries no origin, so a typed prompt that holds a block at a line start must not end the task either.
  await $.turn.start({ text: 'Look at this:\n<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>', turnId: 't1' })
  const typed = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await typed.find({ type: 'Text', text: /^1 in background$/ })).toBeDefined()
  await typed.unmount()
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: 't1', reason: 'answer' })

  const framed = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event.\n\n<task-notification>\n<task-id>bg1</task-id>\n<status>completed</status>\n</task-notification>'
  await $.prompt.submit({ text: framed, wait: false, origin: { kind: 'task-notification' } })
  const done = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await done.find({ type: 'Text', text: /^1 background done in 1m 3s$/ })).toBeDefined()
  expect(await done.find({ type: 'Text', text: 'Live' })).toBeUndefined()
  await done.unmount()
})

test('a TaskStop call ends the task it names as stopped, because a stopped task sends no notification', async ($, on) => {
  const { clock } = world(on, { Bash: { result: { stdout: '', backgroundTaskId: 'bg1' } }, TaskStop: { result: { message: 'stopped' } } })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: 'Bash', command: 'npm run dev', run_in_background: true, tool_use_id: 'u1' })
  clock.now += 60_000
  await $.tool.call({ tool: 'TaskStop', task_id: 'bg1', tool_use_id: 'u2' })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^1 background done in 1m 6s, 1 stopped$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Live' })).toBeUndefined()
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
