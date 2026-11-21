import type { SessionUsage } from 'claude-code'

import type { Metrics } from '../types'
import { prefs } from './state'

const MINUTE = 60_000

// The cache's clock starts when a request reads or writes it, so the countdown runs from the start of the last turn's last
// main request. Module state: after a reload, or a turn with no timed request, it falls back to the turn's end.
let lastRequestAt: number | null = null

export const requestStarted = (at: number): void => {
  lastRequestAt = at
}

/** A new turn or the end of the conversation drops the anchor, so it never outlives the requests it came from. */
export const resetRequest = (): void => {
  lastRequestAt = null
}

// How long the prompt cache keeps the main conversation, which the engine does not report: an hour with a 5-hour or 7-day window
// (a subscription; a gateway spend limit is none), five minutes with an API key. The cacheMinutes option overrides the guess.
export const cacheTtlMs = (usage: SessionUsage): number =>
  prefs.cacheMinutes > 0
    ? prefs.cacheMinutes * MINUTE
    : usage.rateLimits.some(l => l.kind === 'five_hour' || l.kind === 'seven_day')
      ? 60 * MINUTE
      : 5 * MINUTE

/** Time left before the cache of the last main turn expires: null while a turn runs or before the first one ends. */
export const cacheLeftMs = (m: Metrics, usage: SessionUsage, now: number): number | null => {
  const from = lastRequestAt ?? m.lastEndedAt
  return m.running.startedAt !== null || from === undefined ? null : Math.max(0, from + cacheTtlMs(usage) - now)
}

/** How long before the expiry the toast warns: a minute of a short cache, five of a long one. */
export const warnLeadMs = (ttlMs: number): number => (ttlMs > 10 * MINUTE ? 5 * MINUTE : MINUTE)
