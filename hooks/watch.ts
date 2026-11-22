// What the running main turn does now, for the stall alert and the step strip. Module state, copied to $.state at each step
// change, because a plugin reload in the middle of a turn starts the module over. A finished turn's steps go to the metrics.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { PastTurn, Step, WatchSave } from '../types'
import { quietly } from './quietly'

export type { Step }

/** `waits` marks a call put to a decider: its time can be the person's, so it is no stall. */
type OpenCall = { tool: string; startedAt: number; waits: boolean }

const saved = atom({ plugin: 'pulse', key: 'watch' } as const, null as WatchSave | null)
// A step changed since the last copy; a model chunk or a progress mark alone does not make a copy.
let dirty = false

// A long turn keeps its newest steps; older ones are too thin to draw.
const MAX_STEPS = 300

const open = new Map<string, OpenCall>()
let steps: Step[] = []
let turnStartedAt: number | null = null
const openSteps = new Map<string, Step>()
let lastProgressAt: number | null = null
let alerted = false
// A chunk arrived since the last check; the next check counts it as progress at its own clock reading.
let moved = false

/** A turn starts: nothing is open, and the quiet time counts from now. */
export const watchStart = (now: number): void => {
  turnStartedAt = now
  open.clear()
  steps = []
  openSteps.clear()
  moved = false
  lastProgressAt = now
  alerted = false
  dirty = true
}

/** Copies a changed watch to $.state; between turns the copy is null. */
export async function keepWatch($: EngineInterface): Promise<void> {
  if (!dirty) return
  dirty = false
  const copy: WatchSave | null =
    turnStartedAt === null
      ? null
      : {
          turnStartedAt,
          steps: steps.map(s => ({ ...s })),
          openKeys: Object.fromEntries([...openSteps].map(([key, s]) => [key, steps.indexOf(s)]).filter(([, i]) => (i as number) >= 0)),
          open: Object.fromEntries([...open].map(([id, c]) => [id, { ...c }])),
          lastProgressAt,
        }
  await quietly(() => update($, saved, () => copy))
}

/** After a reload, takes the running turn back from $.state, and says whether one came back; a module that watches a turn keeps its own. */
export async function loadWatch($: EngineInterface): Promise<boolean> {
  if (turnStartedAt !== null) return false
  const copy = await quietly(() => read($, saved))
  if (copy === undefined || copy === null) return false
  turnStartedAt = copy.turnStartedAt
  steps = copy.steps.map(s => ({ ...s }))
  openSteps.clear()
  for (const [key, i] of Object.entries(copy.openKeys)) {
    const step = steps[i]
    if (step !== undefined) openSteps.set(key, step)
  }
  open.clear()
  for (const [id, c] of Object.entries(copy.open)) open.set(id, { ...c })
  lastProgressAt = copy.lastProgressAt
  alerted = false
  moved = false
  return true
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

const stepEnds = (key: string, now: number): void => {
  const step = openSteps.get(key)
  if (step === undefined) return
  step.endedAt = Math.max(step.startedAt, now)
  openSteps.delete(key)
  dirty = true
}

const stepBegins = (key: string, step: Step): void => {
  // A request sent again under its index (a fallback model) ends the one it replaces.
  stepEnds(key, step.startedAt)
  steps.push(step)
  if (steps.length > MAX_STEPS) steps = steps.slice(-MAX_STEPS)
  openSteps.set(key, step)
  dirty = true
}

/** A model request of the main loop starts and ends; `key` names it between the two. */
export const requestBegan = (key: string, now: number): void =>
  stepBegins(key, { kind: 'request', name: 'Model request', detail: '', startedAt: now, endedAt: null, waits: false })

export const requestEnded = (key: string, now: number): void => stepEnds(key, now)

/** A tool call starts; `detail` is its name-only label, and a compaction passes `compact`. */
export const callStarted = (id: string, tool: string, now: number, detail = '', kind: 'tool' | 'compact' = 'tool'): void => {
  open.set(id, { tool, startedAt: now, waits: false })
  stepBegins(id, { kind, name: tool, detail, startedAt: now, endedAt: null, waits: false })
  progress(now)
}

/** tool.check put an open call to a decider: while it is open the turn waits, maybe on the person, and is never quiet. */
export const callWaits = (id: string): void => {
  const call = open.get(id)
  if (call !== undefined) call.waits = true
  const step = openSteps.get(id)
  if (step !== undefined) step.waits = true
  dirty = true
}

export const callEnded = (id: string, now: number): void => {
  open.delete(id)
  stepEnds(id, now)
  progress(now)
}

/** The running turn's steps, oldest first, as copies the pane can keep. */
export const stepLog = (): Step[] => steps.map(s => ({ ...s }))

/** A turn ends at `endedAt` and gives its steps for the idle strip; with no time, or no watched start, null. */
export const watchStop = (endedAt?: number): PastTurn | null => {
  const t0 = turnStartedAt
  const past =
    endedAt === undefined || t0 === null
      ? null
      : {
          ms: Math.max(0, endedAt - t0),
          steps: steps.map(s => ({
            kind: s.kind,
            name: s.name,
            detail: s.detail,
            fromMs: Math.max(0, s.startedAt - t0),
            toMs: Math.max(0, (s.endedAt ?? endedAt) - t0),
            waits: s.waits,
          })),
        }
  turnStartedAt = null
  open.clear()
  steps = []
  openSteps.clear()
  lastProgressAt = null
  moved = false
  dirty = true
  return past
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
