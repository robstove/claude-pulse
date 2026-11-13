export type ToolStat = { count: number; errors: number; ms: number }

/** One main-loop turn, kept for the per-turn charts. */
export type TurnRecord = {
  ms: number
  inputTokens: number
  outputTokens: number
  /** Null when the cost before the turn is unknown (the first turn after load). */
  costUsd: number | null
  contextPct: number | null
  toolCalls: number
  isAborted: boolean
}

/** One model's share: every turn it answered last, main or subagent; time counts main turns only. */
export type ModelStat = {
  turns: number
  mainTurns: number
  ms: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export type Metrics = {
  mainTurns: number
  agentTurns: number
  abortedTurns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turnMsTotal: number
  lastTurnMs: number
  longestTurnMs: number
  toolCalls: number
  toolErrors: number
  toolMsTotal: number
  byTool: Record<string, ToolStat>
  /** Optional, so values stored before 0.1.1 still load under the same shape tag. */
  models?: Record<string, ModelStat>
  /** Calls another plugin made through the tool chain, by plugin name; not the model's. */
  pluginCalls: Record<string, number>
  turns: TurnRecord[]
  lastCostUsd: number | null
  /** The session these figures belong to; absent on values saved before 0.1.2. */
  sessionId?: string
}

declare module 'claude-code' {
  interface PluginState {
    'pulse': { metrics: Shaped<Metrics> }
  }
}
