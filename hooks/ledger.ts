import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { lastDays } from './derive'

// The state scan reads an atom only where its file declares it, so each file that reads or writes the costs declares the same one.
const costs = atom({ plugin: 'pulse', key: 'costs' } as const, {} as Record<string, number>)

// Each session keeps its spend per day under keys of its own, because a store write is atomic per key and no session then
// overwrites another's. The amount rides in the key name, `cost:<day>:<session>:<micro-dollars>`, so one keys() call reads
// every session's spend with no get per key.
const COST = /^cost:(\d{4}-\d{2}-\d{2}):([^:]+):(\d+)$/
// Versions before 0.4.4 kept one shared total per day under this key; it still counts, and this version never writes it.
const LEGACY = 'daily'
const KEEP_DAYS = 60

export type CostEntry = { key: string; day: string; session: string; micro: number }

/** The cost keys among a store's keys, parsed. */
export const costEntries = (keys: readonly string[]): CostEntry[] =>
  keys.flatMap(key => {
    const m = COST.exec(key)
    return m?.[1] !== undefined && m[2] !== undefined ? [{ key, day: m[1], session: m[2], micro: Number(m[3]) }] : []
  })

/** Spend per day: a failed delete can leave an older key beside the newest, so each session's day counts its largest amount. */
export function spendByDay(entries: readonly CostEntry[]): Record<string, number> {
  const newest = new Map<string, CostEntry>()
  for (const x of entries) if ((newest.get(`${x.day}:${x.session}`)?.micro ?? -1) < x.micro) newest.set(`${x.day}:${x.session}`, x)
  const byDay: Record<string, number> = {}
  for (const x of newest.values()) byDay[x.day] = (byDay[x.day] ?? 0) + x.micro / 1e6
  return byDay
}

const isLegacy = (v: unknown): v is Record<string, number> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.values(v).every(x => typeof x === 'number')

/** Adds a turn's spend to this session's total for its day. */
export async function addCost($: EngineInterface, session: string, day: string, usd: number): Promise<void> {
  const micro = Math.round(usd * 1e6)
  if (micro <= 0) return
  const id = session.replace(/:/g, '_')
  const mine = costEntries(await $.store.keys()).filter(x => x.day === day && x.session === id)
  // A failed delete can leave an older key beside the newest one; a total only grows, so the largest is the total.
  const held = Math.max(0, ...mine.map(x => x.micro))
  // The new key goes in before the old ones go out, so a failure between the two keeps the spend.
  await $.store.set(`cost:${day}:${id}:${held + micro}`, true)
  for (const x of mine) await $.store.delete(x.key)
}

/** Reads every session's spend per local day into $.state for the pane, and deletes the keys of days past KEEP_DAYS. */
export async function refreshCosts($: EngineInterface, now: number): Promise<void> {
  const keys = await $.store.keys()
  const oldest = lastDays(now, KEEP_DAYS)[0] ?? ''
  const all = costEntries(keys)
  for (const x of all) if (x.day < oldest) await $.store.delete(x.key)
  const byDay = spendByDay(all.filter(x => x.day >= oldest))
  if (keys.includes(LEGACY)) {
    const legacy = await $.store.get(LEGACY)
    if (isLegacy(legacy)) for (const [day, usd] of Object.entries(legacy)) if (day >= oldest) byDay[day] = (byDay[day] ?? 0) + usd
  }
  await update($, costs, () => byDay)
}
