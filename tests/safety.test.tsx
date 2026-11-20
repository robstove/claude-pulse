import { expect, test } from 'claude-code/testing'

import { HINT, PANE, memoryStore } from './kit'
import type { On } from './kit'

const SECRET = 'sk-SECRET-42'

// The engine answers that work; `store` is what Pulse keeps between sessions.
const world = (on: On, entries: Record<string, unknown> = {}) => {
  const store = memoryStore(on, entries)
  let now = 1_000
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: (now += 100) }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  return { store }
}

test('a slow-call label holds a name, and no content reaches the store or the pane', async ($, on) => {
  const { store } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: `cd /repo && API_KEY=${SECRET} "/usr/bin/curl" -H "Authorization: ${SECRET}" https://x.test` })
  await $.tool.call({ tool: 'WebFetch', url: `https://user:${SECRET}@api.example.com/v1?key=${SECRET}`, prompt: SECRET })
  await $.tool.call({ tool: 'Grep', pattern: SECRET })
  await $.tool.call({ tool: 'Read', file_path: `/home/me/${SECRET}/src/a.ts` })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(JSON.stringify([...store.values()])).not.toContain(SECRET)
  const saved = store.get('session:abc') as { metrics: { slowest: { tool: string; label: string }[] } }
  expect(Object.fromEntries(saved.metrics.slowest.map(c => [c.tool, c.label]))).toEqual({
    Bash: 'curl',
    WebFetch: 'api.example.com',
    Grep: '',
    Read: 'src/a.ts',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: new RegExp(SECRET) })).toBeUndefined()
  await ui.unmount()
})

test('a token in a quoted assignment before a command never becomes its label', async ($, on) => {
  const { store } = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.tool.call({ tool: 'Bash', command: `AUTH="Bearer ${SECRET}" TOKEN='a ${SECRET}' curl https://x.test` })
  await $.tool.call({ tool: 'Bash', command: `KEY="${SECRET} with no closing quote` })
  await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })

  expect(JSON.stringify([...store.values()])).not.toContain('SECRET')
  const saved = store.get('session:abc') as { metrics: { slowest: { label: string }[] } }
  expect(saved.metrics.slowest.map(c => c.label).sort()).toEqual(['', 'curl'])
})

test('a save of an older layout keeps its counts and loses its raw labels; a layout with no step is deleted', async ($, on) => {
  const old = {
    shape: 'metrics-3',
    savedAt: 1,
    metrics: { mainTurns: 3, cacheReadTokens: 5_000, byTool: { Bash: { count: 2, errors: 0, ms: 40 } }, slowest: [{ tool: 'Bash', ms: 1, label: SECRET }] },
  }
  const ancient = { shape: 'metrics-2', savedAt: 2, metrics: { mainTurns: 9 } }
  const { store } = world(on, { sessions: [{ id: 'old', savedAt: 1 }], 'session:old': old, 'session:ancient': ancient })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(JSON.stringify([...store.values()])).not.toContain(SECRET)
  expect(store.has('session:ancient')).toBe(false)
  const saved = store.get('session:old') as { shape: string; metrics: { mainTurns: number; cacheReadTokens: number; toolRefusals: number; byTool: Record<string, unknown> } }
  expect(saved.shape).toBe('metrics-5')
  expect(saved.metrics.mainTurns).toBe(3)
  expect(saved.metrics.cacheReadTokens).toBe(5_000)
  expect(saved.metrics.toolRefusals).toBe(0)
  expect(saved.metrics.byTool.Bash).toEqual({ count: 2, errors: 0, refused: 0, waited: 0, waitMs: 0, ms: 40, samples: [] })
  expect(store.get('sessions')).toEqual([{ id: 'old', savedAt: 1 }])
  expect(store.get('shape')).toBe('metrics-5')
})

test('a resumed session whose save has an older layout shows its counts', async ($, on) => {
  // Pulse 0.1 saved turns with no request count; the average leaves them out instead of counting 0.
  const turn = (steps?: number) => ({ ms: 1_000, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null, toolCalls: 0, isAborted: false, steps })
  const steps = { count: 8, firstTokenMs: 0, firstTokenN: 0, streamMs: 0, streamOutput: 0, serverTools: {}, stopReasons: {} }
  const old = { shape: 'metrics-4', savedAt: 1, metrics: { mainTurns: 4, toolCalls: 7, byTool: {}, turns: [turn(), turn(), turn(3), turn(5)], steps } }
  world(on, { sessions: [{ id: 'abc', savedAt: 1 }], 'session:abc': old })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^7 calls · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^4 turns/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^4\.0 requests a turn/ })).toBeDefined()
  await ui.unmount()
})

test('a save whose layout tag names an Object key is deleted, and the other saves still convert', async ($, on) => {
  const odd = { shape: 'constructor', savedAt: 1, metrics: { mainTurns: 1 } }
  const old = { shape: 'metrics-4', savedAt: 2, metrics: { mainTurns: 2 } }
  const { store } = world(on, { 'session:odd': odd, 'session:old': old })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(store.has('session:odd')).toBe(false)
  expect((store.get('session:old') as { shape: string }).shape).toBe('metrics-5')
  expect(store.get('shape')).toBe('metrics-5')
})

test('with every engine call Pulse makes failing, each event still passes and the pane still draws', async ($, on) => {
  const down = () => {
    throw new Error('down')
  }
  for (const call of ['command.register', 'ui.open', 'clock.every', 'clock.now', 'session.id', 'session.usage', 'store.get', 'store.set', 'store.delete', 'store.keys']) {
    on(call as 'clock.now', down)
  }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('tool.call', () => ({ result: { marked: true } }))
  on('ui.render', { component: 'PromptHint' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.hint}</Text>
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(await $.tool.call({ tool: 'Bash', command: 'ls' })).toEqual({ result: { marked: true } })
  expect(await $.turn.complete({ answer: '', durationMs: 2_000, isAborted: false, turnId: 't1', reason: 'answer' })).toEqual({ text: 'done' })

  const hint = await $.ui.mount({ ...HINT, surface: 'desktop' })
  expect(await hint.find({ type: 'Text', text: '? for shortcuts' })).toBeDefined()
  await hint.unmount()
  const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await pane.find({ type: 'Text', text: 'Pulse metrics are not available now.' })).toBeDefined()
  await pane.unmount()
})
