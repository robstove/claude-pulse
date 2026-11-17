import type { EngineInterface } from 'claude-code'

import type { Metrics } from '../types'
// The atom's shape tag, so a load refuses what a different Metrics layout saved.
import { SHAPE } from './state'

// $.state lives only as long as the process; the store keeps a session's metrics for a restart or a --resume.
const PREFIX = 'session:'
const INDEX = 'sessions'
// About 30 KB a session at most (tool samples, 100 file paths) keeps 50 under the store's 4 MiB limit.
export const KEEP_SESSIONS = 50

type Saved = { shape: string; savedAt: number; metrics: Metrics }
type IndexEntry = { id: string; savedAt: number }

const isIndex = (v: unknown): v is IndexEntry[] =>
  Array.isArray(v) && v.every(x => typeof x === 'object' && x !== null && typeof (x as IndexEntry).id === 'string')

const isSaved = (v: unknown): v is Saved => {
  if (typeof v !== 'object' || v === null) return false
  const s = v as Partial<Saved>
  return s.shape === SHAPE && typeof s.metrics === 'object' && s.metrics !== null && typeof s.metrics.mainTurns === 'number'
}

/** The metrics a session saved, or undefined when it saved none or saved another layout. */
export async function loadSession($: EngineInterface, id: string): Promise<Metrics | undefined> {
  const v = await $.store.get(PREFIX + id)
  return isSaved(v) ? v.metrics : undefined
}

// The store key that records which layout the saves hold, so the purge below runs once per layout change.
const SHAPE_KEY = 'shape'

/** Deletes each save of another layout, because an old layout can hold data that the current one no longer keeps. */
export async function dropOtherShapes($: EngineInterface): Promise<void> {
  if ((await $.store.get(SHAPE_KEY)) === SHAPE) return
  const held = await $.store.get(INDEX)
  const kept: IndexEntry[] = []
  for (const x of isIndex(held) ? held : []) {
    if (isSaved(await $.store.get(PREFIX + x.id))) kept.push(x)
    else await $.store.delete(PREFIX + x.id)
  }
  await $.store.set(INDEX, kept)
  await $.store.set(SHAPE_KEY, SHAPE)
}

/** Saves the session's metrics and drops the oldest sessions past KEEP_SESSIONS. */
export async function saveSession($: EngineInterface, id: string, metrics: Metrics): Promise<void> {
  const savedAt = await $.clock.now()
  await $.store.set(PREFIX + id, { shape: SHAPE, savedAt, metrics } satisfies Saved)
  const held = await $.store.get(INDEX)
  const index = [...(isIndex(held) ? held : []).filter(x => x.id !== id), { id, savedAt }]
  const dropped = index.slice(0, Math.max(0, index.length - KEEP_SESSIONS))
  for (const x of dropped) await $.store.delete(PREFIX + x.id)
  await $.store.set(INDEX, index.slice(dropped.length))
}
