import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { refreshCosts } from './ledger'
import { observe } from './observe'
import { drawPane } from './pane'
import { quietly } from './quietly'
import { adopt, clear, convertSaves, persist } from './save'
import { EMPTY, SHAPE, setLevels } from './state'
import { statusText } from './status'
import { costSince, record } from './tally'
import { observeTools } from './tools'
import { VERSION } from './version'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })
const costs = atom({ plugin: 'pulse', key: 'costs' } as const, {} as Record<string, number>)
const tick = atom({ plugin: 'pulse', key: 'tick' } as const, 0)

const PANE = 'pulse'
// The version in the title tells the person which Pulse runs, so an update shows.
const TITLE = `Pulse ${VERSION}`
// The running bar ticks each second for the first two minutes of a turn, then every fifth second.
const FAST_TICKS = 120
const SLOW_TICK_MS = 5_000

// The timer that redraws the pane while a main turn runs; a reload starts without one, and the next turn starts it.
let ticker: { cancel: () => void } | undefined

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
}

// A tick redraws only what reads it: the pane. The prompt hint shows nothing that moves with the clock.
const bump = ($: EngineInterface): void => void quietly(() => update($, tick, n => n + 1))

// The ticks keep the elapsed time, cost, and running bar current while the model streams; a state write redraws on its own.
// After the fast window one slower timer takes over, so no period passes without a redraw.
const startTicker = ($: EngineInterface): void => {
  let ticks = 0
  ticker = $.clock.every(1000, () => {
    ticks += 1
    bump($)
    if (ticks < FAST_TICKS) return
    stopTicker()
    ticker = $.clock.every(SLOW_TICK_MS, () => bump($))
  })
}

// Every engine call goes through quietly: a hook passes its event on and returns what came back, whatever Pulse fails at.
export const register: Register = (on, options) => {
  setLevels(options)
  observe(on)
  observeTools(on)

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'pulse', description: 'Show token, timing, and tool metrics for this session' }))
    void quietly(() => $.ui.open({ id: PANE, title: TITLE }))
    // The pane starts from what $.state holds when a load fails; the next main turn tries the load again.
    await quietly(() => convertSaves($))
    await quietly(() => adopt($))
    await quietly(async () => refreshCosts($, await $.clock.now()))

    return next(e)
  })

  // What changed after the last turn (a /compact, a prompt count, spend by a background agent) reaches the store here.
  on('session.end', async ($, e, next) => {
    await quietly(async () => {
      const now = await $.clock.now()
      const costNow = (await quietly(() => $.session.usage()))?.cost?.usd ?? null
      const spent = costSince((await read($, metrics)).lastCostUsd, costNow)
      const m = await record($, { kind: 'session-end', costUsd: costNow })
      if (m !== undefined) await persist($, m, now, spent)
      // After /clear or an in-process resume the process goes on under another id: the pane empties now,
      // and the next main turn binds the new id and loads its save.
      if (e.reason === 'clear' || e.reason === 'resume') await clear($)
    })

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await quietly(() => $.ui.open({ id: PANE, title: TITLE }))

    return { text: 'Pulse pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(() => adopt($))
      stopTicker()
      const now = await quietly(() => $.clock.now())
      // A notification that wakes an idle session starts a turn; the task it reports on ends here.
      if (now !== undefined) await record($, { kind: 'notice', text: e.text, now })
      await record($, { kind: 'turn-start', now })
      if (now !== undefined) await quietly(() => startTicker($))
      bump($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain) stopTicker()
    const now = await quietly(() => $.clock.now())
    const s = isMain ? await quietly(() => $.session.usage()) : undefined
    const session = s === undefined ? undefined : { costUsd: s.cost?.usd ?? null, contextPct: s.context.percent ?? null, rateLimits: s.rateLimits }
    const m = await record($, {
      kind: 'turn-end',
      agentId: e.agentId,
      durationMs: e.durationMs,
      isAborted: e.isAborted,
      reason: e.reason,
      usage: e.usage,
      now,
      session,
    })
    // A subagent turn runs inside a main turn, whose end saves its figures too.
    if (isMain && m !== undefined && now !== undefined) await persist($, m, now, m.turns.at(-1)?.costUsd ?? null)

    return next(e)
  })

  // The summary rides on the hint line under the prompt, because $.ui.status labels it with the plugin name.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await quietly(async () => statusText(await read($, metrics), await $.session.usage()))
    if (line === undefined) return next(e)
    // A tail that reaches Pulse came from a plugin above it, so Pulse adds to it.
    if (e.surface === 'terminal') return next({ ...e, props: { ...e.props, tail: `${e.props.tail ?? ''}  ${line}` } })
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" columnGap="md">
        {await next(e)}
        <Text dimColor size="caption" tabular>
          {line}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined
    const pane = await quietly(async () => {
      const usage = await $.session.usage()
      const now = await $.clock.now()
      // Reading the tick subscribes the pane to it, so the running turn's clock moves.
      await read($, tick)
      const m = await read($, metrics)
      const { startedAt, toolCalls } = m.running

      return drawPane(
        { Box: table.Box, Text: table.Text, Svg },
        {
          m,
          usage,
          now,
          daily: await read($, costs),
          elapsedMs: now - usage.startedAt,
          live: startedAt !== null ? { ms: now - startedAt, toolCalls } : null,
          columns: e.props.bodyColumns ?? 40,
          rows: e.viewport?.rows ?? 40,
        },
      )
    })
    if (pane !== undefined) return pane
    const { Box, Text } = table

    return (
      <Box>
        <Text dimColor>Pulse metrics are not available now.</Text>
      </Box>
    )
  })
}
