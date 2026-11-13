import type { EngineInterface } from 'claude-code'

import type { Metrics } from '../types'

// $.state lives only as long as the process; the store keeps a session's metrics for a restart or a --resume.
const PREFIX = 'session:'
const INDEX = 'sessions'
// About 10-20 KB a session keeps 50 well under the store's 4 MiB limit.
export const KEEP_SESSIONS = 50
// Matches the atom's shape tag, so a load refuses what a different Metrics layout saved.
const SHAPE = 'metrics-3'

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
