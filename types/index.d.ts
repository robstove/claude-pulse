/** The level the person hid the budget band at, for one day and one budget. */
export type BudgetMark = { day: string; level: number; budget: number }

export type ToolStat = {
  count: number
  errors: number
  /** Calls a permission rule, a person, or a hook refused before they ran; they add no time. */
  refused: number
  /** Calls a decider held: their whole span, decision and run, is in waitMs; ms and samples leave them out. */
  waited: number
  waitMs: number
  ms: number
  /** The last durations of this tool, newest last, for the p50 and p95. */
  samples: number[]
}

/** One main-loop turn, kept for the per-turn charts. */
export type TurnRecord = {
  ms: number
  /** Every input token the turn sent, cached or not. */
  inputTokens: number
  outputTokens: number
  /** Null when the cost before the turn is unknown. */
  costUsd: number | null
  contextPct: number | null
  toolCalls: number
  isAborted: boolean
  /** Model requests the turn made; absent on a turn that Pulse 0.1 saved, which did not count them. */
  steps?: number
  /** answer, aborted, refusal, or error. */
  reason: string
}

/** One model's share: every turn it answered last, main or subagent; time counts main turns only. */
export type ModelStat = {
  turns: number
  mainTurns: number
  ms: number
  /** Input tokens not read from or written to the cache. */
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
  /** Every input token its turns sent, cached or not. */
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

/** A slow call; `background` marks a task that ran on after its call answered, timed to its end. */
export type SlowCall = { tool: string; ms: number; label: string; background?: true }

/** A background task still going: a command sent to the background, a background subagent, a workflow, a monitor. */
export type OpenTask = { tool: string; label: string; startedAt: number }

/** Background tasks that ended, timed from their call to their notification; `stopped` counts those the person or Claude killed. */
export type BackgroundStat = { count: number; failed: number; stopped: number; ms: number }

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

/** The first reading of a rate-limit window in this session, or after the window reset; `resetsAt` names the window. */
export type RateStart = { at: number; pct: number; resetsAt?: string }

/** The main turn that runs now; `startedAt` is null between turns, or when the clock failed at its start. */
export type Running = { startedAt: number | null; toolCalls: number; steps: number }

export type Metrics = {
  mainTurns: number
  agentTurns: number
  /** Input tokens not read from or written to the cache; the cache counts are apart. */
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  turnMsTotal: number
  lastTurnMs: number
  longestTurnMs: number
  toolCalls: number
  toolErrors: number
  /** Time of the calls that no decider held, so a permission prompt's wait is not in it. */
  toolMsTotal: number
  toolRefusals: number
  toolWaited: number
  toolWaitMs: number
  byTool: Record<string, ToolStat>
  models: Record<string, ModelStat>
  /** Calls another plugin made through the tool chain, by plugin name; not the model's. */
  pluginCalls: Record<string, number>
  turns: TurnRecord[]
  lastCostUsd: number | null
  /** The session these figures belong to; absent until a session binds them. */
  sessionId?: string
  /** Main turns by how they ended. */
  endReasons: Record<string, number>
  agents: Record<string, AgentStat>
  /** Subagent id to its type, so a subagent's turn counts toward its type. */
  agentTypes: Record<string, string>
  compactions: Compaction[]
  steps: StepStats
  prompts: number
  commands: Record<string, number>
  /** Time between main turns, each gap capped at 30 minutes. */
  idleMs: number
  /** When the last main turn ended; absent before the first. */
  lastEndedAt?: number
  slowest: SlowCall[]
  /** Edits per file path by Edit, Write, MultiEdit, and NotebookEdit. */
  files: Record<string, number>
  rateStart: Record<string, RateStart>
  /** Background tasks by task id. */
  tasks: Record<string, OpenTask>
  background: BackgroundStat
  running: Running
}

declare module 'claude-code' {
  interface PluginState {
    'pulse': {
      metrics: Shaped<Metrics>
      /** Spend per local day across every session, read from the store's cost keys. */
      costs: Record<string, number>
      /** Counts the running turn's ticks; the pane reads it, so a tick redraws the pane and nothing else. */
      tick: number
      /** Counts the ticks between turns while the prompt cache counts down; the pane and the prompt hint read it. */
      idleTick: number
      /** The day, level, and budget at which the person hid the budget band; the band shows again past them. */
      budgetHidden: BudgetMark | null
      /** When the running main compaction started; null when none runs. The pane reads it, so a start and an end redraw it. */
      compactingSince: number | null
    }
  }
}
