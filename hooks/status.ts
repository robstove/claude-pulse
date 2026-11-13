import type { SessionUsage } from 'claude-code'

import type { Metrics } from '../types'
import { fmtMs, fmtUsd, level } from './charts'

// The status line has no color, so a glyph carries the level.
const GLYPH = { ok: '●', warn: '▲', bad: '■' } as const

/** One line for the prompt hint: context, cost, tool calls, and the last turn's time. */
export const statusText = (m: Metrics, usage: SessionUsage): string => {
  const ctx = usage.context.percent ?? 0
  const parts = [`${GLYPH[level(ctx, 60, 80)]} ctx ${ctx}%`]
  if (usage.cost) parts.push(fmtUsd(usage.cost.usd))
  parts.push(`${m.toolCalls} tools${m.toolErrors > 0 ? ` (${m.toolErrors} err)` : ''}`)
  if (m.mainTurns > 0) parts.push(`last ${fmtMs(m.lastTurnMs)}`)
  return parts.join(' · ')
}
