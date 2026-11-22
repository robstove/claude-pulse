import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'

import type { BudgetMark } from '../types'
import { fmtUsd } from './charts'
import { dayKey, refreshCosts } from './ledger'
import { quietly } from './quietly'
import { prefs } from './state'

// The state scan reads an atom only where its file declares it, so each file that reads or writes the costs declares the same one.
const costs = atom({ plugin: 'pulse', key: 'costs' } as const, {} as Record<string, number>)
// The band's Hide, held in the store so it stays hidden across sessions and reloads; the atom redraws the band.
const hidden = atom({ plugin: 'pulse', key: 'budgetHidden' } as const, null as BudgetMark | null)

const KEY = 'budgetHidden'
// Pulse 0.7.2 kept its toast mark under this key, in the same shape; read as a Hide, it would hide the band on update day.
const TOAST_KEY = 'budget'
// The redraw at the next local midnight, so an idle session drops yesterday's band.
let midnight: Timer | undefined
// The share of the daily budget at which the band shows.
export const BUDGET_WARN = 0.8

/** The budget level that today's spend reached: 0 below the warning share, then the warning share, then 1 at the budget. */
export const budgetLevel = (spent: number, budget: number): number =>
  budget <= 0 ? 0 : spent >= budget ? 1 : spent >= budget * BUDGET_WARN ? BUDGET_WARN : 0

/** Today's spend across sessions, from the per-day totals that the costs atom holds. */
export const todaySpend = (daily: Readonly<Record<string, number>>, now: number): number => daily[dayKey(now)] ?? 0

// A budget is a round amount the person typed, so it keeps 2 decimals where a small spend gets 4.
export const fmtBudget = (usd: number): string => `$${usd.toFixed(2)}`

// Rounded down, so a spend just under the budget never reads as 100%.
export const budgetPercent = (spent: number, budget: number): number => Math.floor((spent / budget) * 100)

export const budgetText = (spent: number, budget: number, level: number): string =>
  level >= 1
    ? `${fmtUsd(spent)} spent today, over the ${fmtBudget(budget)} daily budget`
    : `${fmtUsd(spent)} spent today, ${budgetPercent(spent, budget)}% of the ${fmtBudget(budget)} daily budget`

const isMark = (v: unknown): v is BudgetMark => {
  const m = v as Partial<Record<keyof BudgetMark, unknown>> | null
  return typeof v === 'object' && m !== null && typeof m.day === 'string' && typeof m.level === 'number' && typeof m.budget === 'number'
}

/** What the band shows now, or null: nothing past the warning share, or a level the person hid today at this budget. */
export async function budgetState($: EngineInterface): Promise<{ spent: number; budget: number; level: number; day: string } | null> {
  const budget = prefs.dailyBudgetUsd
  if (budget <= 0) return null
  const now = await $.clock.now()
  const spent = todaySpend(await read($, costs), now)
  const level = budgetLevel(spent, budget)
  if (level === 0) return null
  const day = dayKey(now)
  const mark = await read($, hidden)
  // A mark for another day or budget counts as none, and a higher level shows the band again.
  if (mark !== null && mark.day === day && mark.budget === budget && mark.level >= level) return null
  return { spent, budget, level, day }
}

/** Deletes the 0.7.2 toast mark; a session start runs it, so a store that never had one costs one delete. */
export async function forgetToastMark($: EngineInterface): Promise<void> {
  await $.store.delete(TOAST_KEY)
}

const msToMidnight = (now: number): number => {
  const d = new Date(now)
  // One second past, so the new day's key is the one that dayKey reads.
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 1).getTime() - now
}

/** Reads the Hide that another session saved, and sets the redraw at the next local midnight. */
export async function syncBudget($: EngineInterface, now: number): Promise<void> {
  const mark = await $.store.get(KEY)
  if (isMark(mark)) await update($, hidden, () => mark)
  midnight?.cancel()
  // With no budget nothing draws from today's spend, so nothing needs the redraw.
  if (prefs.dailyBudgetUsd <= 0) return
  const day = dayKey(now)
  midnight = $.clock.after(msToMidnight(now), () =>
    void quietly(async () => {
      const t = await $.clock.now()
      // A timer that fires before the day turns sets no next one, so it can never loop; the next turn end sets it again.
      if (dayKey(t) === day) return
      await refreshCosts($, t)
      await syncBudget($, t)
    }),
  )
}

export async function hideBudget($: EngineInterface, mark: BudgetMark): Promise<void> {
  await update($, hidden, () => mark)
  await $.store.set(KEY, mark)
}
