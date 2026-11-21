import type { SessionUsage } from 'claude-code'

import type { Metrics } from '../types'
import { cacheLeftMs } from './cache'
import { fmtMs, fmtUsd, level } from './charts'

/** Whole minutes left, rounded up, so the hint changes at most once a minute. */
const fmtMin = (ms: number): string => `${Math.ceil(ms / 60_000)}m`

// The status line has no color, so a glyph carries the level.
const GLYPH = { ok: '●', warn: '▲', bad: '■' } as const

/** One line for the prompt hint: context, the 5-hour limit, cost, tool calls, the last turn's time, and the cache countdown. */
export const statusText = (m: Metrics, usage: SessionUsage, now: number): string => {
  const ctx = usage.context.percent
  // The fill is unknown until the first response of a fresh or just-compacted window, and 0% would read as safe.
  const parts = [ctx === undefined ? 'ctx -' : `${GLYPH[level(ctx)]} ctx ${ctx}%`]
  const fiveHour = usage.rateLimits.find(l => l.kind === 'five_hour')
  if (fiveHour) parts.push(`${GLYPH[level(fiveHour.percentUsed)]} 5h ${fiveHour.percentUsed}%`)
  if (usage.cost) parts.push(fmtUsd(usage.cost.usd))
  const flags = [m.toolErrors > 0 ? `${m.toolErrors} err` : '', m.toolRefusals > 0 ? `${m.toolRefusals} refused` : ''].filter(Boolean)
  // Refused calls ran no tool, but the count holds them, so "(1 refused)" reads as one of the calls.
  parts.push(`${m.toolCalls + m.toolRefusals} tools${flags.length > 0 ? ` (${flags.join(', ')})` : ''}`)
  if (m.mainTurns > 0) parts.push(`last ${fmtMs(m.lastTurnMs)}`)
  const left = cacheLeftMs(m, usage, now)
  if (left !== null) parts.push(left > 0 ? `cache ${fmtMin(left)}` : 'cache cold')
  return parts.join(' · ')
}
