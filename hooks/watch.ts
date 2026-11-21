// What the running main turn does now, for the stall alert. Module state: a reload starts it over, and the next event fills it.

/** `waits` marks a call put to a decider: its time can be the person's, so it is no stall. */
type OpenCall = { tool: string; startedAt: number; waits: boolean }

const open = new Map<string, OpenCall>()
let lastProgressAt: number | null = null
let alerted = false
// A chunk arrived since the last check; the next check counts it as progress at its own clock reading.
let moved = false

/** A turn starts: nothing is open, and the quiet time counts from now. */
export const watchStart = (now: number): void => {
  open.clear()
  moved = false
  lastProgressAt = now
  alerted = false
}

/** A step's end or a call's start or end: the turn moves. */
export const progress = (now: number): void => {
  lastProgressAt = now
  alerted = false
}

/** A model chunk arrived. */
export const touch = (): void => {
  moved = true
}

/** A tool call starts. */
export const callStarted = (id: string, tool: string, now: number): void => {
  open.set(id, { tool, startedAt: now, waits: false })
  progress(now)
}

/** tool.check put an open call to a decider: while it is open the turn waits, maybe on the person, and is never quiet. */
export const callWaits = (id: string): void => {
  const call = open.get(id)
  if (call !== undefined) call.waits = true
}

export const callEnded = (id: string, now: number): void => {
  open.delete(id)
  progress(now)
}

export const watchStop = (): void => {
  open.clear()
  lastProgressAt = null
  moved = false
}

/** The quiet span of the running turn and its oldest open call, or null between turns. */
export const quiet = (now: number): { ms: number; call?: { tool: string; ms: number } } | null => {
  if (lastProgressAt === null) return null
  const calls = [...open.values()]
  if (moved || calls.some(c => c.waits)) {
    moved = false
    progress(now)
  }
  const oldest = calls.sort((a, b) => a.startedAt - b.startedAt)[0]
  return { ms: Math.max(0, now - lastProgressAt), call: oldest && { tool: oldest.tool, ms: Math.max(0, now - oldest.startedAt) } }
}

/** True once per quiet stretch past `limitMs`, so the alert shows once until the turn moves again. */
export const shouldAlert = (now: number, limitMs: number): boolean => {
  const q = quiet(now)
  if (limitMs <= 0 || q === null || alerted || q.ms < limitMs) return false
  alerted = true
  return true
}
