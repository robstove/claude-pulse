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
  byModel: Record<string, number>
  /** Calls another plugin made through the tool chain, by plugin name; not the model's. */
  pluginCalls: Record<string, number>
  turns: TurnRecord[]
  lastCostUsd: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'pulse': { metrics: Shaped<Metrics> }
  }
}
