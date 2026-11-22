import { memoryStore } from './kit'
import type { Dollar, On } from './kit'

// The engine and the step mock that the pane tests share. This file holds no test, so `claude plugin test` only imports it.

export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

// The engine answers these tests share; `state` moves the clock, the context, and the limits, and `afters` holds each one-shot timer.
export const engine = (on: On) => {
  const state = { now: Date.UTC(2026, 10, 13, 12), tokens: 50_000 as number | undefined, percent: 25 as number | undefined, estimate: 50_000, limits: [] as Limit[], compactAt: 160_000 as number | undefined, cost: 0.5 }
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
        // Pulse reads only these three fields of the breakdown.
        breakdown: { isAutoCompactEnabled: state.compactAt !== undefined, autoCompactThreshold: state.compactAt, totalTokens: state.estimate } as never,
      },
      rateLimits: state.limits,
      cost: { usd: state.cost },
    },
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return { state, afters, toasts, store }
}

// A step mock: one chunk, then an answer.
export const step = (on: On) =>
  on('turn.step', async function* (_, e) {
    yield { kind: 'text', index: 0, text: 'hi', ref: 1 }
    return { turnId: e.turnId, index: e.index, answer: 'hi', toolUses: [], stopReason: 'end_turn', usage: { model: 'claude-opus-5-5', input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }
  })

export const runStep = async ($: Dollar, turnId: string) => {
  for await (const _ of $.turn.step({ turnId, index: 0, model: 'claude-opus-5-5', messageCount: 1 })) {
    // Read the stream to its end.
  }
}
