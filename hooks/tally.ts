import { atom, update } from 'claude-code'
import type { EngineInterface, SessionRateLimit, TurnUsage } from 'claude-code'

import type { AgentStat, Metrics, ModelStat, RateStart, SlowCall, StepStats, TurnRecord } from '../types'
import { callLabel } from './label'
import { quietly } from './quietly'
import { EMPTY, EMPTY_TOOL, IDLE, MAX_TURNS, SHAPE } from './state'
import { taskNotice, taskOf } from './tasks'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

/** Durations kept per tool for its percentiles. */
const SAMPLES = 40
/** A longer gap between turns counts as away, not as the person's time at the prompt. */
export const IDLE_CAP_MS = 30 * 60_000
// Paths stop at 100, so one session save stays near 30 KB.
const MAX_FILES = 100
const MAX_TASKS = 50
const MAX_COMPACTIONS = 20
const MAX_AGENT_IDS = 200
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const PERSON = new Set(['composer', 'bridge', 'sdk'])
// The engine's words when the person says no at the permission dialog, or when an ask has nobody to answer it. No field marks
// these refusals, so the text is the sign; if the engine changes the words, such a call counts as failed again.
const REJECTED = /^(The user doesn't want to proceed with this tool use|Permission to use \S+ has been denied)/

/** What a hook saw, in plain values; `apply` holds every rule that turns it into counts. */
export type Observation =
  | { kind: 'turn-start'; now?: number }
  | {
      kind: 'turn-end'
      agentId?: string
      durationMs: number
      isAborted: boolean
      reason: string
      usage?: TurnUsage
      now?: number
      /** The session's figures after a main turn; absent for a subagent's turn, or when the engine did not answer. */
      session?: { costUsd: number | null; contextPct: number | null; rateLimits: readonly SessionRateLimit[] }
    }
  | {
      kind: 'tool'
      tool: string
      input: Readonly<Record<string, unknown>>
      agentId?: string
      /** tool.check put the call to a decider (a person, auto mode's classifier, a host). */
      asked: boolean
      /** tool.check refused the call, as a permission rule or a hook does. */
      denied: boolean
      /** A plugin beneath answered the call with a deny. */
      deny: boolean
      isError: boolean
      text?: string
      result: unknown
      /** The person interrupted the call. */
      aborted: boolean
      startedAt?: number
      endedAt?: number
    }
  | { kind: 'plugin-call'; plugin: string }
  | {
      kind: 'step'
      agentId?: string
      startedAt?: number
      /** When the first text, thinking, or tool chunk came; null when none came or the clock failed. */
      firstAt: number | null
      endedAt?: number
      output: number
      serverTools: readonly string[]
      stopReason: string | null
      effort?: string
    }
  | { kind: 'notice'; text: string; now: number }
  | { kind: 'spawn'; type: string; agentId?: string; model?: string; isResume: boolean }
  | { kind: 'compaction'; at: number; trigger: string; agentId?: string; isSkipped: boolean; tokensBefore?: number; tokensAfter?: number }
  | { kind: 'prompt'; origin?: string; isMeta: boolean; isDropped: boolean; command?: string }
  | { kind: 'session-end'; costUsd: number | null }

/** The spend since the cost Pulse last read; null when either end is unknown. */
export const costSince = (before: number | null, now: number | null): number | null =>
  before !== null && now !== null ? Math.max(0, now - before) : null

/** Every input token a request sent: uncached, read from the cache, and written to it. */
const sentTokens = (u: TurnUsage | undefined): number =>
  (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)

// The turn counts toward the model that sent its last counted response; a mid-turn /model switch credits the new one.
const addModelTurn = (models: Record<string, ModelStat>, u: TurnUsage, mainMs: number | null): Record<string, ModelStat> => {
  const prev = models[u.model] ?? { turns: 0, mainTurns: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  return {
    ...models,
    [u.model]: {
      turns: prev.turns + 1,
      mainTurns: prev.mainTurns + (mainMs !== null ? 1 : 0),
      ms: prev.ms + (mainMs ?? 0),
      inputTokens: prev.inputTokens + u.input_tokens,
      outputTokens: prev.outputTokens + u.output_tokens,
      cacheReadTokens: prev.cacheReadTokens + u.cache_read_input_tokens,
      cacheWriteTokens: prev.cacheWriteTokens + u.cache_creation_input_tokens,
    },
  }
}

const NEW_AGENT: AgentStat = { spawns: 0, turns: 0, ms: 0, inputTokens: 0, outputTokens: 0 }

// A subagent turn counts toward its spawn's type; a turn of an agent spawned before a reload counts as "subagent".
const addAgentTurn = (agents: Record<string, AgentStat>, type: string, ms: number, u: TurnUsage | undefined): Record<string, AgentStat> => {
  const prev = agents[type] ?? NEW_AGENT
  return {
    ...agents,
    [type]: { ...prev, turns: prev.turns + 1, ms: prev.ms + ms, inputTokens: prev.inputTokens + sentTokens(u), outputTokens: prev.outputTokens + (u?.output_tokens ?? 0) },
  }
}

// A later reset time names a new window; a minute of slack keeps a recomputed time from looking like a reset.
const isNewWindow = (held: string | undefined, read: string | undefined): boolean =>
  held !== undefined && read !== undefined && Date.parse(read) - Date.parse(held) > 60_000

/** Keeps the first reading of each window, and starts it again when the window resets. */
const nextRateStart = (held: Record<string, RateStart>, limits: readonly SessionRateLimit[], now: number): Record<string, RateStart> => {
  const out = { ...held }
  for (const l of limits) {
    const s = out[l.kind]
    // Other sessions fill the same account window, so a reset can pass with no drop in the fill this session reads.
    if (s === undefined || isNewWindow(s.resetsAt, l.resetsAt) || l.percentUsed < s.pct - 0.5) {
      out[l.kind] = { at: now, pct: l.percentUsed, resetsAt: l.resetsAt }
    } else if (s.resetsAt === undefined && l.resetsAt !== undefined) {
      out[l.kind] = { ...s, resetsAt: l.resetsAt }
    }
  }
  return out
}

/** The five slowest calls, slowest first. */
const pushSlow = (list: readonly SlowCall[], call: SlowCall): SlowCall[] => [...list, call].sort((a, b) => b.ms - a.ms).slice(0, 5)

const count = (counts: Readonly<Record<string, number>>, key: string): Record<string, number> => ({ ...counts, [key]: (counts[key] ?? 0) + 1 })

/** Keeps the newest `n` entries of a record, in insertion order. */
const newest = <T>(entries: Record<string, T>, n: number): Record<string, T> => Object.fromEntries(Object.entries(entries).slice(-n))

function turnStarted(m: Metrics, o: Extract<Observation, { kind: 'turn-start' }>): Metrics {
  const gap = o.now === undefined || m.lastEndedAt === undefined ? 0 : Math.min(IDLE_CAP_MS, Math.max(0, o.now - m.lastEndedAt))
  return { ...m, idleMs: m.idleMs + gap, running: { startedAt: o.now ?? null, toolCalls: 0, steps: 0 } }
}

function turnEnded(m: Metrics, o: Extract<Observation, { kind: 'turn-end' }>): Metrics {
  const u = o.usage
  const isMain = o.agentId === undefined
  const costNow = o.session?.costUsd ?? null
  // With no clock the turn's spend cannot reach a day of the ledger, so the baseline stays and the next turn carries the spend.
  const priced = isMain && o.now !== undefined && costNow !== null
  const record: TurnRecord = {
    ms: o.durationMs,
    inputTokens: sentTokens(u),
    outputTokens: u?.output_tokens ?? 0,
    costUsd: priced ? costSince(m.lastCostUsd, costNow) : null,
    contextPct: o.session?.contextPct ?? null,
    toolCalls: m.running.toolCalls,
    isAborted: o.isAborted,
    steps: m.running.steps,
    reason: o.reason,
  }
  const totals = {
    ...m,
    agentTurns: m.agentTurns + (isMain ? 0 : 1),
    inputTokens: m.inputTokens + (u?.input_tokens ?? 0),
    outputTokens: m.outputTokens + (u?.output_tokens ?? 0),
    cacheReadTokens: m.cacheReadTokens + (u?.cache_read_input_tokens ?? 0),
    cacheWriteTokens: m.cacheWriteTokens + (u?.cache_creation_input_tokens ?? 0),
    models: u ? addModelTurn(m.models, u, isMain ? o.durationMs : null) : m.models,
  }
  if (!isMain) return { ...totals, agents: addAgentTurn(m.agents, m.agentTypes[o.agentId ?? ''] ?? 'subagent', o.durationMs, u) }
  // Timing covers main-loop turns only, because a subagent turn runs inside one.
  return {
    ...totals,
    mainTurns: m.mainTurns + 1,
    turnMsTotal: m.turnMsTotal + o.durationMs,
    lastTurnMs: o.durationMs,
    longestTurnMs: Math.max(m.longestTurnMs, o.durationMs),
    turns: [...m.turns, record].slice(-MAX_TURNS),
    lastCostUsd: priced ? costNow : m.lastCostUsd,
    endReasons: count(m.endReasons, o.reason),
    lastEndedAt: o.now ?? m.lastEndedAt,
    rateStart: o.now === undefined ? m.rateStart : nextRateStart(m.rateStart, o.session?.rateLimits ?? [], o.now),
    running: IDLE,
  }
}

export type ToolObservation = Extract<Observation, { kind: 'tool' }>

/** A call that a rule, a hook, or the person refused. A refusal at the permission dialog comes back as an asked call's error
 * that the engine words in its fixed refusal text. */
const callRefused = (o: ToolObservation): boolean => o.deny || (o.denied && o.isError) || (o.asked && o.isError && REJECTED.test(o.text ?? ''))

/** A call whose tool failed: an error that is no refusal, and no interrupt, which ends with an error too though the tool did not fail. */
export const callFailed = (o: ToolObservation): boolean => o.isError && !o.aborted && !callRefused(o)

// A call put to a decider counts its whole span as wait time apart from tool time, because the engine reports no point where
// the decision ends. A call refused before it ran adds no time.
function toolCalled(m: Metrics, o: ToolObservation): Metrics {
  const refused = callRefused(o)
  const prev = m.byTool[o.tool] ?? EMPTY_TOOL
  if (refused) return { ...m, toolRefusals: m.toolRefusals + 1, byTool: { ...m.byTool, [o.tool]: { ...prev, refused: prev.refused + 1 } } }
  const isMain = o.agentId === undefined
  const span = o.startedAt === undefined || o.endedAt === undefined ? 0 : Math.max(0, o.endedAt - o.startedAt)
  // The tool's own time; null when the span also holds a decider's wait.
  const ms = o.asked ? null : span
  const waitMs = ms === null ? span : 0
  const failed = callFailed(o)
  const label = callLabel(o.input)
  // A subagent's task reports its end to that subagent, which Pulse does not hear, so only the main loop's tasks are timed.
  const task = failed || !isMain ? undefined : taskOf(o.result)
  // The task starts when its call does, or, after a decider's wait, when the call answers, so the wait stays out.
  const taskStart = o.asked ? o.endedAt : (o.startedAt ?? o.endedAt)
  const path = o.input.file_path ?? o.input.notebook_path
  const file = !failed && FILE_TOOLS.has(o.tool) && typeof path === 'string' ? path : null
  const files = file === null ? m.files : count(m.files, file)
  return {
    ...m,
    toolCalls: m.toolCalls + 1,
    toolErrors: m.toolErrors + (failed ? 1 : 0),
    toolMsTotal: m.toolMsTotal + (ms ?? 0),
    toolWaited: m.toolWaited + (ms === null ? 1 : 0),
    toolWaitMs: m.toolWaitMs + waitMs,
    byTool: {
      ...m.byTool,
      [o.tool]: {
        ...prev,
        count: prev.count + 1,
        errors: prev.errors + (failed ? 1 : 0),
        ms: prev.ms + (ms ?? 0),
        waited: prev.waited + (ms === null ? 1 : 0),
        waitMs: prev.waitMs + waitMs,
        samples: ms === null ? prev.samples : [...prev.samples, ms].slice(-SAMPLES),
      },
    },
    slowest: ms === null ? m.slowest : pushSlow(m.slowest, { tool: o.tool, ms, label }),
    files: Object.keys(files).length > MAX_FILES ? m.files : files,
    tasks: task === undefined || taskStart === undefined ? m.tasks : newest({ ...m.tasks, [task]: { tool: o.tool, label, startedAt: taskStart } }, MAX_TASKS),
    // The running turn counts the main loop's calls, as its steps do; a subagent's calls are its own.
    running: isMain ? { ...m.running, toolCalls: m.running.toolCalls + 1 } : m.running,
  }
}

function stepEnded(m: Metrics, o: Extract<Observation, { kind: 'step' }>): Metrics {
  const running = o.agentId === undefined ? { ...m.running, steps: m.running.steps + 1 } : m.running
  if (o.endedAt === undefined) return { ...m, running }
  const s: StepStats = m.steps
  const firstMs = o.firstAt === null || o.startedAt === undefined ? null : o.firstAt - o.startedAt
  const streamMs = o.firstAt === null ? 0 : o.endedAt - o.firstAt
  const serverTools = o.serverTools.reduce(count, s.serverTools)
  // A stream under 200ms is a cached or empty reply, and its rate says nothing about the model's speed.
  const timed = firstMs !== null && streamMs >= 200 && o.output > 0
  return {
    ...m,
    running,
    steps: {
      count: s.count + 1,
      firstTokenMs: s.firstTokenMs + (firstMs ?? 0),
      firstTokenN: s.firstTokenN + (firstMs !== null ? 1 : 0),
      streamMs: s.streamMs + (timed ? streamMs : 0),
      streamOutput: s.streamOutput + (timed ? o.output : 0),
      serverTools,
      stopReasons: o.stopReason === null ? s.stopReasons : count(s.stopReasons, o.stopReason),
      effort: o.effort ?? s.effort,
    },
  }
}

// A notification reports on a background task; `killed` is a stop by the person or by Claude, not a failure.
function taskSettled(m: Metrics, o: Extract<Observation, { kind: 'notice' }>): Metrics {
  const notice = taskNotice(o.text)
  const task = notice === undefined ? undefined : m.tasks[notice.id]
  if (notice?.ended === undefined || task === undefined) return m
  const { [notice.id]: _, ...tasks } = m.tasks
  const ms = Math.max(0, o.now - task.startedAt)
  const held = m.background
  return {
    ...m,
    tasks,
    background: {
      count: held.count + 1,
      failed: held.failed + (notice.ended === 'failed' ? 1 : 0),
      stopped: held.stopped + (notice.ended === 'stopped' ? 1 : 0),
      ms: held.ms + ms,
    },
    slowest: pushSlow(m.slowest, { tool: task.tool, ms, label: task.label, background: true }),
  }
}

function spawned(m: Metrics, o: Extract<Observation, { kind: 'spawn' }>): Metrics {
  const prev = m.agents[o.type] ?? NEW_AGENT
  return {
    ...m,
    // A resumed subagent or a teammate brought back from disk runs again; it is no new start.
    agents: { ...m.agents, [o.type]: { ...prev, spawns: prev.spawns + (o.isResume ? 0 : 1), model: o.model } },
    agentTypes: o.agentId ? newest({ ...m.agentTypes, [o.agentId]: o.type }, MAX_AGENT_IDS) : m.agentTypes,
  }
}

function compacted(m: Metrics, o: Extract<Observation, { kind: 'compaction' }>): Metrics {
  // A precompute only prepares a summary; the conversation changes on the compaction that uses it.
  // A subagent's or a fork's own compaction leaves the main conversation as it was.
  if (o.trigger === 'precompute' || o.agentId !== undefined || o.isSkipped) return m
  const c = { at: o.at, trigger: o.trigger, turn: m.mainTurns, tokensBefore: o.tokensBefore, tokensAfter: o.tokensAfter }
  return { ...m, compactions: [...m.compactions, c].slice(-MAX_COMPACTIONS) }
}

function prompted(m: Metrics, o: Extract<Observation, { kind: 'prompt' }>): Metrics {
  // Only the person's own prompts that entered count: not a dropped one, a notification, a schedule, or another session's message.
  if (o.isDropped || o.isMeta || !PERSON.has(o.origin ?? 'composer')) return m
  return { ...m, prompts: m.prompts + 1, commands: o.command ? count(m.commands, o.command) : m.commands }
}

/** The figures after one observation. */
export function apply(m: Metrics, o: Observation): Metrics {
  switch (o.kind) {
    case 'turn-start':
      return turnStarted(m, o)
    case 'turn-end':
      return turnEnded(m, o)
    case 'tool':
      return toolCalled(m, o)
    case 'plugin-call':
      return { ...m, pluginCalls: count(m.pluginCalls, o.plugin) }
    case 'step':
      return stepEnded(m, o)
    case 'notice':
      return taskSettled(m, o)
    case 'spawn':
      return spawned(m, o)
    case 'compaction':
      return compacted(m, o)
    case 'prompt':
      return prompted(m, o)
    case 'session-end':
      return { ...m, lastCostUsd: o.costUsd ?? m.lastCostUsd }
  }
}

/** Applies an observation to the session's figures; undefined when the write failed, which never reaches the hook. */
export function record($: EngineInterface, o: Observation): Promise<Metrics | undefined> {
  return quietly(() => update($, metrics, m => apply(m, o)))
}
