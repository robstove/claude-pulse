import type { Metrics } from '../types'

export const MAX_TURNS = 48

export const EMPTY: Metrics = {
  mainTurns: 0,
  agentTurns: 0,
  abortedTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turnMsTotal: 0,
  lastTurnMs: 0,
  longestTurnMs: 0,
  toolCalls: 0,
  toolErrors: 0,
  toolMsTotal: 0,
  byTool: {},
  models: {},
  pluginCalls: {},
  turns: [],
  lastCostUsd: null,
}

// Change this tag when a Metrics field changes meaning: stored values outlive a reload. New optional fields keep it.
// metrics-4: a slow call's label holds a name only; metrics-3 saves held raw command lines and URLs.
export const SHAPE = 'metrics-4'

export const hasData = (m: Metrics): boolean => m.mainTurns > 0 || m.agentTurns > 0 || m.toolCalls > 0

/** The running main turn's counters; a reload starts them over, so that one turn undercounts. */
export const live = {
  toolCalls: 0,
  steps: 0,
  startedAt: null as number | null,
  ticker: undefined as { cancel: () => void } | undefined,
}
