import type { BackgroundStat, Metrics, Running, StepStats, ToolStat } from '../types'

export const MAX_TURNS = 48

export const EMPTY_TOOL: ToolStat = { count: 0, errors: 0, refused: 0, waited: 0, waitMs: 0, ms: 0, samples: [] }

export const EMPTY_STEPS: StepStats = { count: 0, firstTokenMs: 0, firstTokenN: 0, streamMs: 0, streamOutput: 0, serverTools: {}, stopReasons: {} }

export const EMPTY_BACKGROUND: BackgroundStat = { count: 0, failed: 0, stopped: 0, ms: 0 }

export const IDLE: Running = { startedAt: null, toolCalls: 0, steps: 0 }

export const EMPTY: Metrics = {
  mainTurns: 0,
  agentTurns: 0,
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
  toolRefusals: 0,
  toolWaited: 0,
  toolWaitMs: 0,
  byTool: {},
  models: {},
  pluginCalls: {},
  turns: [],
  lastCostUsd: null,
  endReasons: {},
  agents: {},
  agentTypes: {},
  compactions: [],
  steps: EMPTY_STEPS,
  prompts: 0,
  commands: {},
  idleMs: 0,
  slowest: [],
  files: {},
  rateStart: {},
  tasks: {},
  background: EMPTY_BACKGROUND,
  running: IDLE,
}

// Change this tag when a Metrics field changes meaning: stored values outlive a reload. hooks/save.ts converts the saves of
// the earlier tags it lists, so a change here needs a step there.
// metrics-5: every count is required, and the running turn lives in Metrics.
export const SHAPE = 'metrics-5'

/** The fill at which a context or rate-limit meter turns amber, and red; the user's options set them at load. */
export const levels = { warnAt: 60, alertAt: 80 }

const percentOption = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 100 ? v : fallback)

export const setLevels = (options: Readonly<Record<string, unknown>> | undefined): void => {
  const warnAt = percentOption(options?.warnAt, 60)
  const alertAt = percentOption(options?.alertAt, 80)
  // A pair out of order counts as not set, so the meter never turns red before it turns amber.
  Object.assign(levels, warnAt < alertAt ? { warnAt, alertAt } : { warnAt: 60, alertAt: 80 })
}

/** The options past the meter levels: the cache TTL (0 = guess), when a quiet turn alerts (0 = never), and the sections to draw. */
export const prefs = { cacheMinutes: 0, stallMinutes: 3, sections: [] as string[] }

const minutesOption = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1_440 ? v : fallback)

export const setPrefs = (options: Readonly<Record<string, unknown>> | undefined): void => {
  const sections = typeof options?.sections === 'string' ? options.sections : ''
  Object.assign(prefs, {
    cacheMinutes: minutesOption(options?.cacheMinutes, 0),
    stallMinutes: minutesOption(options?.stallMinutes, 3),
    sections: sections.split(/[\s,]+/).map(n => n.trim().toLowerCase()).filter(n => n !== ''),
  })
}

export const hasData = (m: Metrics): boolean => m.mainTurns > 0 || m.agentTurns > 0 || m.toolCalls > 0 || m.toolRefusals > 0
