import { expect, test } from 'claude-code/testing'

type On = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: { title: 'Pulse', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const HINT = { plugin: 'pulse', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

const SECRET = 'sk-SECRET-42'

// The engine answers that work; `store` is what Pulse keeps between sessions.
const world = (on: On, entries: Record<string, unknown> = {}) => {
  const store = new Map<string, unknown>(Object.entries(entries))
  let now = 1_000
  on('command.register', () => ({ value: { command: 'pulse' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: (now += 100) }))
  on('session.id', () => ({ value: 'abc' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1_000, window: 200_000, percent: 1 }, rateLimits: [], cost: { usd: 0.5 } } }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('tool.call', () => ({ result: {} }))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
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

test('a save of an older layout is deleted when a session starts', async ($, on) => {
  const old = { shape: 'metrics-3', savedAt: 1, metrics: { mainTurns: 1, slowest: [{ tool: 'Bash', ms: 1, label: SECRET }] } }
  const { store } = world(on, { sessions: [{ id: 'old', savedAt: 1 }], 'session:old': old })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  expect(store.has('session:old')).toBe(false)
  expect(store.get('sessions')).toEqual([])
  expect(store.get('shape')).toBe('metrics-4')
})

test('with every engine call Pulse makes failing, each event still passes and the pane still draws', async ($, on) => {
  const down = () => {
    throw new Error('down')
  }
  for (const call of ['command.register', 'ui.open', 'ui.invalidate', 'clock.every', 'clock.now', 'session.id', 'session.usage', 'store.get', 'store.set', 'store.delete']) {
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
