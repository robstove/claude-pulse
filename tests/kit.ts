import type { test } from 'claude-code/testing'

// The pieces every test file shares. This file holds no test, so `claude plugin test` only imports it.

type Body = Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>
export type Dollar = Parameters<Body>[0]
export type On = Parameters<Body>[1]

export const PANE = {
  plugin: 'pulse',
  component: 'Pane',
  requestId: 'pulse',
  props: { title: 'Pulse', isFocused: false, bodyColumns: 40, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

export const HINT = { plugin: 'pulse', component: 'PromptHint', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } } as const

/** Answers `$.store` from a Map the test can read back; a set keeps a JSON copy, as the store file does. */
export const memoryStore = (on: On, entries: Record<string, unknown> = {}): Map<string, unknown> => {
  const store = new Map<string, unknown>(Object.entries(entries))
  on('store.get', (_, e) => ({ value: store.get(e.key) }))
  on('store.set', (_, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...store.keys()] }))
  return store
}

/** The spend per day that the store's cost keys hold, as Pulse reads it: the largest amount of each session's day. */
export const costsIn = (store: Map<string, unknown>): Record<string, number> => {
  const newest = new Map<string, number>()
  for (const key of store.keys()) {
    const m = /^cost:(\d{4}-\d{2}-\d{2}):([^:]+):(\d+)$/.exec(key)
    if (m) newest.set(`${m[1]}:${m[2]}`, Math.max(newest.get(`${m[1]}:${m[2]}`) ?? 0, Number(m[3])))
  }
  const days: Record<string, number> = {}
  for (const [id, micro] of newest) days[id.slice(0, 10)] = (days[id.slice(0, 10)] ?? 0) + micro / 1e6
  return days
}
