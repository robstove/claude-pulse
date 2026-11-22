import { expect, test } from 'claude-code/testing'

import { engine } from './live'

// The toast for a tool that fails again and again.

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
