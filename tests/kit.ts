import type { test } from 'claude-code/testing'

import { costEntries, spendByDay } from '../hooks/ledger'

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

/** The spend per day that the store's cost keys hold, read with the ledger's own parser. */
export const costsIn = (store: Map<string, unknown>): Record<string, number> => spendByDay(costEntries([...store.keys()]))
