import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Metrics } from '../types'
import { addCost, dayKey, refreshCosts } from './ledger'
import { quietly } from './quietly'
import { EMPTY, EMPTY_BACKGROUND, EMPTY_STEPS, EMPTY_TOOL, IDLE, SHAPE, hasData } from './state'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

// $.state lives only as long as the process; the store keeps a session's metrics for a restart or a --resume.
const PREFIX = 'session:'
const INDEX = 'sessions'
// The store key that records which layout the saves hold, so the conversion below runs once per layout change.
const SHAPE_KEY = 'shape'
// About 30 KB a session at most (tool samples, 100 file paths) keeps 50 under the store's 4 MiB limit.
export const KEEP_SESSIONS = 50

type Loose = Record<string, unknown>
type IndexEntry = { id: string; savedAt: number }

// Each step takes a save of the layout it is listed under to the next layout. A save of a layout with no step is deleted.
const STEPS: Readonly<Record<string, { to: string; run: (m: Loose) => Loose }>> = {
  // metrics-3 slow-call and task labels held raw command lines and URLs, and a label cannot be cut back to a name.
  'metrics-3': { to: 'metrics-4', run: m => ({ ...m, slowest: [], tasks: {} }) },
  // metrics-5 made every count required; `complete` fills what a metrics-4 save lacks. Before 0.4.2 a quoted assignment could
  // leave part of its value in a label, so the slow calls go here too.
  'metrics-4': { to: 'metrics-5', run: m => ({ ...m, slowest: [] }) },
}

const isObject = (v: unknown): v is Loose => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Fills each count an older save lacks with its empty value, down to the per-tool and per-turn records. */
const complete = (m: Loose): Metrics => {
  const held = m as Partial<Metrics>
  return {
    ...EMPTY,
    ...held,
    byTool: Object.fromEntries(Object.entries(held.byTool ?? {}).map(([name, s]) => [name, { ...EMPTY_TOOL, ...s }])),
    // A turn's unknown request count stays absent, so the requests-a-turn average leaves it out instead of counting 0.
    turns: (held.turns ?? []).map(t => ({ ...t, reason: t.reason ?? (t.isAborted ? 'aborted' : 'answer') })),
    steps: { ...EMPTY_STEPS, ...held.steps },
    background: { ...EMPTY_BACKGROUND, ...held.background },
    // A saved task's process ended with the process that saved it, and no notification for it will come.
    tasks: {},
    running: IDLE,
  }
}

/** A save in the current layout, or undefined when it is no save or no step leads from its layout. */
const migrate = (v: unknown): Metrics | undefined => {
  if (!isObject(v) || typeof v.shape !== 'string' || !isObject(v.metrics)) return undefined
  let shape = v.shape
  let m = v.metrics
  while (shape !== SHAPE) {
    // Own keys only, so a stored tag such as "constructor" finds no step instead of an inherited value.
    const step = Object.hasOwn(STEPS, shape) ? STEPS[shape] : undefined
    if (step === undefined) return undefined
    m = step.run(m)
    shape = step.to
  }
  return typeof m.mainTurns === 'number' ? complete(m) : undefined
}

const isIndex = (v: unknown): v is IndexEntry[] => Array.isArray(v) && v.every(x => isObject(x) && typeof x.id === 'string')

/** Brings each save of an earlier layout to this one and deletes those no step leads from, because an old layout can hold data this one does not keep. */
export async function convertSaves($: EngineInterface): Promise<void> {
  if ((await $.store.get(SHAPE_KEY)) === SHAPE) return
  const kept: IndexEntry[] = []
  // Every save key, not only the indexed ones, so no older save keeps what this layout does not.
  for (const key of (await $.store.keys()).filter(k => k.startsWith(PREFIX))) {
    const v = await $.store.get(key)
    const m = migrate(v)
    if (m === undefined) {
      await $.store.delete(key)
      continue
    }
    const savedAt = isObject(v) && typeof v.savedAt === 'number' ? v.savedAt : 0
    await $.store.set(key, { shape: SHAPE, savedAt, metrics: m })
    kept.push({ id: key.slice(PREFIX.length), savedAt })
  }
  await $.store.set(INDEX, kept.sort((a, b) => a.savedAt - b.savedAt))
  await $.store.set(SHAPE_KEY, SHAPE)
}

/** Saves the session's metrics and drops the oldest sessions past KEEP_SESSIONS. */
async function saveSession($: EngineInterface, id: string, m: Metrics): Promise<void> {
  const savedAt = await $.clock.now()
  await $.store.set(PREFIX + id, { shape: SHAPE, savedAt, metrics: m })
  const held = await $.store.get(INDEX)
  const index = [...(isIndex(held) ? held : []).filter(x => x.id !== id), { id, savedAt }]
  const dropped = index.slice(0, Math.max(0, index.length - KEEP_SESSIONS))
  for (const x of dropped) await $.store.delete(PREFIX + x.id)
  await $.store.set(INDEX, index.slice(dropped.length))
}

// Binds $.state to this session id: keeps a match, keeps figures that built up while a failed load left no id, else loads
// what the store saved. It runs at session.start and at each main turn.start, because /clear and an in-process resume
// change the id with no session.start.
export async function adopt($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const m = await read($, metrics)
  if (m.sessionId === id) return
  if (m.sessionId === undefined && hasData(m)) {
    await update($, metrics, held => ({ ...held, sessionId: id }))
    return
  }
  const saved = migrate(await $.store.get(PREFIX + id))
  // The baseline is the ledger of this process, which need not hold what an earlier process saved, so a first turn costs what it spent.
  const cost = (await quietly(() => $.session.usage()))?.cost?.usd ?? null
  await update($, metrics, () => ({ ...(saved ?? EMPTY), lastCostUsd: cost, sessionId: id }))
}

// The save and the day's spend go apart, so a failed save does not lose the spend: the next save repeats the figures, not the spend.
// Then the pane's day totals are read again, with what other sessions spent since the last read.
export async function persist($: EngineInterface, m: Metrics, now: number, spent: number | null): Promise<void> {
  const id = m.sessionId
  if (id !== undefined) await quietly(() => saveSession($, id, m))
  if (spent !== null && spent > 0) await quietly(() => addCost($, id ?? 'unbound', dayKey(now), spent))
  await quietly(() => refreshCosts($, now))
}

/** Empties the figures, for a session that goes on under another id. */
export async function clear($: EngineInterface): Promise<void> {
  await quietly(() => update($, metrics, () => EMPTY))
}
