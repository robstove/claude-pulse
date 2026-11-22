import { expect, test } from 'claude-code/testing'

import { budgetText } from '../hooks/budget'
import { dayKey } from '../hooks/ledger'
import { HINT, PANE } from './kit'
import type { Dollar, On } from './kit'
import { engine } from './live'

// The daily budget: its band above the prompt, the band's Hide, and its share in the History section and the prompt hint.

const BAND = {
  plugin: 'pulse',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 60, scroll: { offset: 0, bodyRows: 9 }, view: {} },
} as const

// The engine beneath Pulse draws nothing in the band, so a band that passes shows this word.
const engineBand = (on: On) =>
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>none</Text>
  })

const spend = async ($: Dollar, state: { cost: number }, id: string, cost: number) => {
  await $.turn.start({ text: 'hi', turnId: id })
  state.cost = cost
  await $.turn.complete({ answer: '', durationMs: 1_000, isAborted: false, turnId: id, reason: 'answer' })
}

/** The band's text and color, or undefined when Pulse leaves the band to the engine. */
const band = async ($: Dollar) => {
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = await ui.find({ type: 'Text', text: /daily budget/ })
  await ui.unmount()
  return text === undefined ? undefined : { text: text.text, color: text.props.color }
}

test('the band shows from 80% of the daily budget, turns red at 100%, and the hint and History show the share', { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, toasts, afters } = engine(on)
  engineBand(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  // A redraw waits for one second past the next local midnight, so an idle session drops the day's band.
  const d = new Date(state.now)
  expect(afters).toContain(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 0, 0, 1).getTime() - state.now)
  const hint = async () => {
    const h = await $.ui.mount({ ...HINT, surface: 'desktop' })
    const line = (await h.find({ type: 'Text', text: / · \d+ tools/ }))?.text
    await h.unmount()
    return String(line)
  }
  await spend($, state, 't1', 1.0)
  expect(await band($)).toBeUndefined()
  // Below the warning share the hint leaves the day's spend out.
  const low = await hint()
  expect(low).toContain(' tools')
  expect(low).not.toContain('today')
  await spend($, state, 't2', 1.4)
  expect(await band($)).toEqual({ text: '▲ $0.9000 spent today, 90% of the $1.00 daily budget', color: 'warning' })
  expect(await hint()).toContain(' · ▲ today $0.9000 of $1.00 · ')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /^today \$0\.9000 of \$1\.00 · 7 days/ })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: 'Today is at 90% of the daily budget.' }))?.props.color).toBe('warning')
  await pane.unmount()
  await spend($, state, 't3', 1.7)
  expect(await band($)).toEqual({ text: '■ $1.20 spent today, over the $1.00 daily budget', color: 'error' })
  expect(await hint()).toContain(' · ■ today $1.20 of $1.00 · ')
  // The band replaced the budget toast.
  expect(toasts).toEqual([])
})

test('a budget under $1 keeps 2 decimals, where the spend keeps 4', () => {
  expect(budgetText(0.5, 0.4, 1)).toBe('$0.5000 spent today, over the $0.40 daily budget')
})

test('Hide keeps the band away for the level it showed, and the next level shows it again on the same mount', { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, store } = engine(on)
  engineBand(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await spend($, state, 't1', 1.4)
  // One mount for the whole test, so each change must reach it through its subscriptions.
  const ui = await $.ui.mount({ ...BAND, surface: 'desktop' })
  const text = async () => (await ui.find({ type: 'Text', text: /daily budget/ }))?.props.color
  expect(await text()).toBe('warning')
  await ui.press({ key: 'pulse-budget-hide' })
  expect(await text()).toBeUndefined()
  expect(store.get('budgetHidden')).toEqual({ day: dayKey(state.now), level: 0.8, budget: 1 })
  await spend($, state, 't2', 1.45)
  expect(await text()).toBeUndefined()
  await spend($, state, 't3', 1.6)
  expect(await text()).toBe('error')
  await ui.unmount()
})

test("another session's Hide reaches this one at its next turn end, only for the same day and the same budget", { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, store } = engine(on)
  engineBand(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await spend($, state, 't1', 2)
  expect((await band($))?.color).toBe('error')
  // The ledger keys the local day, so the test reads it the same way; an earlier day's mark is a day that has passed.
  store.set('budgetHidden', { day: dayKey(state.now), level: 1, budget: 1 })
  await spend($, state, 't2', 2.1)
  expect(await band($)).toBeUndefined()
  store.set('budgetHidden', { day: dayKey(state.now), level: 1, budget: 2 })
  await spend($, state, 't3', 2.2)
  expect((await band($))?.color).toBe('error')
  store.set('budgetHidden', { day: '2000-01-01', level: 1, budget: 1 })
  await spend($, state, 't4', 2.3)
  expect((await band($))?.color).toBe('error')
})

test('the 0.7.2 toast mark is deleted at session start and hides nothing, and a survey keeps the band', { options: { dailyBudgetUsd: 1 } }, async ($, on) => {
  const { state, store } = engine(on)
  engineBand(on)
  store.set('budget', { day: dayKey(state.now), level: 1, budget: 1 })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(store.has('budget')).toBe(false)
  await spend($, state, 't1', 2)
  expect((await band($))?.color).toBe('error')
  const ui = await $.ui.mount({ ...BAND, props: { ...BAND.props, hasSurvey: true }, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /daily budget/ })).toBeUndefined()
  await ui.unmount()
})
