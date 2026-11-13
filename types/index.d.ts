export type ToolStat = {
  count: number
  errors: number
  ms: number
  /** The last durations of this tool, newest last, for the p50 and p95; optional so 0.1.2 saves load. */
  samples?: number[]
}

/** One main-loop turn, kept for the per-turn charts. */
export type TurnRecord = {
  ms: number
  inputTokens: number
  outputTokens: number
  /** Null when the cost before the turn is unknown. */
  costUsd: number | null
  contextPct: number | null
  toolCalls: number
  isAborted: boolean
  /** Model requests the turn made. */
  steps?: number
  /** answer, aborted, refusal, or error. */
  reason?: string
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

/** One subagent type: how often it started, and the turns its loops ran. */
export type AgentStat = {
  spawns: number
  turns: number
  ms: number
  inputTokens: number
  outputTokens: number
  /** The model the last spawn of this type ran on. */
  model?: string
}

export type Compaction = {
  at: number
  trigger: string
  /** The main turn count when it ran, so the context chart can mark it. */
  turn: number
  tokensBefore?: number
  tokensAfter?: number
}

export type SlowCall = { tool: string; ms: number; label: string }

/** Model requests across all loops. */
export type StepStats = {
  count: number
  /** Time from the request to its first streamed text, thinking, or tool chunk, summed over firstTokenN requests. */
  firstTokenMs: number
  firstTokenN: number
  /** Time from the first chunk to the end, and the output tokens in it, for tokens per second. */
  streamMs: number
  streamOutput: number
  serverTools: Record<string, number>
  stopReasons: Record<string, number>
  effort?: string
}

/** The first reading of a rate-limit window in this session, or after the window reset. */
export type RateStart = { at: number; pct: number }

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
  // The fields below came in 0.2.0. They are optional, so a 0.1.2 save loads under the same shape tag.
  /** Main turns by how they ended. */
  endReasons?: Record<string, number>
  agents?: Record<string, AgentStat>
  /** Subagent id to its type, so a subagent's turn counts toward its type. */
  agentTypes?: Record<string, string>
  compactions?: Compaction[]
  steps?: StepStats
  prompts?: number
  commands?: Record<string, number>
  /** Time between main turns, each gap capped at 30 minutes. */
  idleMs?: number
  /** Main turn time counted from the same load as idleMs, so the Activity split compares like with like. */
  workMs?: number
  lastEndedAt?: number
  slowest?: SlowCall[]
  /** Edits per file path by Edit, Write, MultiEdit, and NotebookEdit. */
  files?: Record<string, number>
  rateStart?: Record<string, RateStart>
}

declare module 'claude-code' {
  interface PluginState {
    'pulse': { metrics: Shaped<Metrics> }
  }
}
