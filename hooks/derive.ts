import type { SessionRateLimit } from 'claude-code'

import type { RateStart, SlowCall, StepStats } from '../types'

/** Durations kept per tool for its percentiles. */
export const SAMPLES = 40
/** A longer gap between turns counts as away, not as the person's time at the prompt. */
export const IDLE_CAP_MS = 30 * 60_000
/** A pace needs this much history, so one early turn does not project a false limit. */
const PACE_MIN_MS = 10 * 60_000
const HOUR = 3_600_000

export const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Nearest-rank percentile; 0 for no samples. */
export const percentile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0
}

/** Keeps the first reading of each window, and starts it again when the window resets. */
export const nextRateStart = (
  held: Record<string, RateStart> | undefined,
  limits: readonly SessionRateLimit[],
  now: number,
): Record<string, RateStart> => {
  const out = { ...(held ?? {}) }
  for (const l of limits) {
    const s = out[l.kind]
    if (s === undefined || l.percentUsed < s.pct - 0.5) out[l.kind] = { at: now, pct: l.percentUsed }
  }
  return out
}

export type Pace = {
  kind: string
  label: string
  pct: number
  resetsInMs: number | null
  /** Points of the window used per hour since the first reading; null until PACE_MIN_MS of history. */
  perHour: number | null
  /** Time to 100% at that pace; null when the pace is flat or unknown. */
  fullInMs: number | null
  /** The fill at reset if the pace holds. */
  atResetPct: number | null
}

export const windowLabel = (kind: string): string =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')

export const paceOf = (l: SessionRateLimit, start: RateStart | undefined, now: number): Pace => {
  const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
  const resetsInMs = Number.isFinite(resetsAt) ? Math.max(0, resetsAt - now) : null
  const span = start ? now - start.at : 0
  const perHour = start && span >= PACE_MIN_MS ? Math.max(0, ((l.percentUsed - start.pct) / span) * HOUR) : null
  return {
    kind: l.kind,
    label: windowLabel(l.kind),
    pct: l.percentUsed,
    resetsInMs,
    perHour,
    fullInMs: perHour !== null && perHour > 0 ? ((100 - l.percentUsed) / perHour) * HOUR : null,
    atResetPct: perHour !== null && resetsInMs !== null ? l.percentUsed + (perHour * resetsInMs) / HOUR : null,
  }
}

/** What a call worked on, for the slowest-call list: a command, a path, or a pattern. */
export const callLabel = (input: Readonly<Record<string, unknown>>): string => {
  for (const key of ['command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'description', 'prompt']) {
    const v = input[key]
    if (typeof v === 'string' && v.trim() !== '') {
      const one = v.trim().split('\n')[0] ?? ''
      return one.length > 80 ? `${one.slice(0, 79)}…` : one
    }
  }
  return ''
}

/** The five slowest calls, slowest first. */
export const pushSlow = (list: readonly SlowCall[] | undefined, call: SlowCall): SlowCall[] =>
  [...(list ?? []), call].sort((a, b) => b.ms - a.ms).slice(0, 5)

export const EMPTY_STEPS: StepStats = {
  count: 0,
  firstTokenMs: 0,
  firstTokenN: 0,
  streamMs: 0,
  streamOutput: 0,
  serverTools: {},
  stopReasons: {},
}

export type StepSample = {
  firstMs: number | null
  streamMs: number
  output: number
  serverTools: readonly string[]
  stopReason: string | null
  effort?: string
}

export const addStep = (s: StepStats | undefined, x: StepSample): StepStats => {
  const held = s ?? EMPTY_STEPS
  const serverTools = { ...held.serverTools }
  for (const name of x.serverTools) serverTools[name] = (serverTools[name] ?? 0) + 1
  const stopReasons = { ...held.stopReasons }
  if (x.stopReason !== null) stopReasons[x.stopReason] = (stopReasons[x.stopReason] ?? 0) + 1
  // A stream under 200ms is a cached or empty reply, and its rate says nothing about the model's speed.
  const timed = x.firstMs !== null && x.streamMs >= 200 && x.output > 0
  return {
    count: held.count + 1,
    firstTokenMs: held.firstTokenMs + (x.firstMs ?? 0),
    firstTokenN: held.firstTokenN + (x.firstMs !== null ? 1 : 0),
    streamMs: held.streamMs + (timed ? x.streamMs : 0),
    streamOutput: held.streamOutput + (timed ? x.output : 0),
    serverTools,
    stopReasons,
    effort: x.effort ?? held.effort,
  }
}

/** The local calendar day of a time, as YYYY-MM-DD. */
export const dayKey = (ms: number): string => {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`
}

/** The last `n` local days, oldest first. */
export const lastDays = (now: number, n: number): string[] => {
  const d = new Date(now)
  // Noon on each date, so a daylight-saving change cannot skip or repeat a day.
  return Array.from({ length: n }, (_, i) => dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - (n - 1 - i), 12).getTime()))
}
