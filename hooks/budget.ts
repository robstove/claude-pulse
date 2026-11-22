import { atom, read } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import { fmtUsd } from './charts'
import { dayKey } from './ledger'
import { ALERT } from './loop'
import { prefs } from './state'

// The state scan reads an atom only where its file declares it, so each file that reads or writes the costs declares the same one.
const costs = atom({ plugin: 'pulse', key: 'costs' } as const, {} as Record<string, number>)

// The store key that records the last budget toast, so each level toasts once a day across sessions and reloads.
const KEY = 'budget'
// The share of the daily budget at which the first toast shows.
export const BUDGET_WARN = 0.8

/** The budget level that today's spend reached: 0 below the warning share, then the warning share, then 1 at the budget. */
export const budgetLevel = (spent: number, budget: number): number =>
  budget <= 0 ? 0 : spent >= budget ? 1 : spent >= budget * BUDGET_WARN ? BUDGET_WARN : 0

// Rounded down, so a spend just under the budget never reads as 100%.
export const budgetPercent = (spent: number, budget: number): number => Math.floor((spent / budget) * 100)

export const budgetText = (spent: number, budget: number, level: number): string =>
  level >= 1
    ? `${ALERT} today's spend of ${fmtUsd(spent)} has passed the ${fmtUsd(budget)} daily budget.`
    : `${ALERT} today's spend of ${fmtUsd(spent)} is ${budgetPercent(spent, budget)}% of the ${fmtUsd(budget)} daily budget.`

type Mark = { day: string; level: number; budget: number }

const isMark = (v: unknown): v is Mark => {
  const m = v as Partial<Record<keyof Mark, unknown>> | null
  return typeof v === 'object' && m !== null && typeof m.day === 'string' && typeof m.level === 'number' && typeof m.budget === 'number'
}

/** After the day's totals are read again, toasts once when today's spend across sessions reaches a new budget level. */
export async function checkBudget($: EngineInterface, now: number): Promise<void> {
  const budget = prefs.dailyBudgetUsd
  if (budget <= 0) return
  const day = dayKey(now)
  const spent = (await read($, costs))[day] ?? 0
  const level = budgetLevel(spent, budget)
  if (level === 0) return
  const mark = await $.store.get(KEY)
  // A mark for another budget counts as none, so a budget the person changed warns again.
  if (isMark(mark) && mark.day === day && mark.budget === budget && mark.level >= level) return
  // The mark goes in before the toast, so a failed toast never repeats at each turn.
  await $.store.set(KEY, { day, level, budget } satisfies Mark)
  $.ui.toast(budgetText(spent, budget, level), { timeoutMs: 15_000 })
}
