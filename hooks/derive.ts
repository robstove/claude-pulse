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

// A later reset time names a new window; a minute of slack keeps a recomputed time from looking like a reset.
const isNewWindow = (held: string | undefined, read: string | undefined): boolean =>
  held !== undefined && read !== undefined && Date.parse(read) - Date.parse(held) > 60_000

/** Keeps the first reading of each window, and starts it again when the window resets. */
export const nextRateStart = (
  held: Record<string, RateStart> | undefined,
  limits: readonly SessionRateLimit[],
  now: number,
): Record<string, RateStart> => {
  const out = { ...(held ?? {}) }
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

/** How long each known window runs, so a window with no reset time still has a bound for its warning. */
export const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }

export type Pace = {
  kind: string
  label: string
  pct: number
  resetsInMs: number | null
  /** Points of the window used per hour since the first reading; null until PACE_MIN_MS of history. */
  perHour: number | null
  /** Time to 100% at that pace, 0 once the window is full; null when the pace is flat or unknown. */
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
    // A spend limit can pass 100%; a full window has no time left, not a negative one.
    fullInMs: perHour !== null && perHour > 0 ? (Math.max(0, 100 - l.percentUsed) / perHour) * HOUR : null,
    atResetPct: perHour !== null && resetsInMs !== null ? l.percentUsed + (perHour * resetsInMs) / HOUR : null,
  }
}

const cut = (s: string): string => (s.length > 80 ? `${s.slice(0, 79)}…` : s)

/** The program a command line runs: no `cd` prefix, no `NAME=value` assignment, no arguments, no folder. */
const commandName =(command: string): string => {
  // A leading `cd <dir> &&` names only where the command ran.
  const line = (command.trim().split('\n')[0] ?? '').replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, '')
  // A shell word joins its quoted parts, so `A="x y"` stays one word; an unclosed quote runs to the end of the line.
  const words = line.match(/(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^\s"'])+/g) ?? []
  // An assignment before the program can carry a token, so it never reaches the label.
  const program = words.find(w => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? ''
  return program.replace(/["']/g, '').split(/[\\/]/).pop() ?? ''
}

/** The host of an address, without login, path, or query; empty when the text is not an address. */
const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

// The slowest-call label holds a name, never content: the model's description, a command's program, a path's last two parts, or a host.
// A pattern, query, or prompt gives no label, because each one is content.
export const callLabel = (input: Readonly<Record<string, unknown>>): string => {
  const text = (key: string): string => {
    const v = input[key]
    return typeof v === 'string' ? v.trim() : ''
  }
  const description = text('description')
  if (description !== '') return cut(description.split('\n')[0] ?? '')
  const command = text('command')
  if (command !== '') return cut(commandName(command))
  const path = text('file_path') || text('notebook_path')
  if (path !== '') return cut(path.split(/[\\/]/).filter(Boolean).slice(-2).join('/'))
  const url = text('url')
  return url !== '' ? hostOf(url) : ''
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
