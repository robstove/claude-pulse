import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import { budgetBand } from './band'
import { forgetToastMark, syncBudget, todaySpend } from './budget'
import { cacheLeftMs, cacheTtlMs, resetRequest, warnLeadMs } from './cache'
import { fmtMs, fmtNum } from './charts'
import { refreshCosts } from './ledger'
import { opensAsNotice } from './tasks'
import { ALERT, resetLoops } from './loop'
import { observe } from './observe'
import { drawPane } from './pane'
import { quietly } from './quietly'
import { adopt, clear, convertSaves, persist } from './save'
import { EMPTY, SHAPE, prefs, setLevels, setPrefs } from './state'
import { statusText } from './status'
import { costSince, record } from './tally'
import { observeTools } from './tools'
import { VERSION } from './version'
import { quiet, shouldAlert, stepLog, watchStart, watchStop } from './watch'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })
const costs = atom({ plugin: 'pulse', key: 'costs' } as const, {} as Record<string, number>)
const tick = atom({ plugin: 'pulse', key: 'tick' } as const, 0)
const idleTick = atom({ plugin: 'pulse', key: 'idleTick' } as const, 0)
const compacting = atom({ plugin: 'pulse', key: 'compactingSince' } as const, null as number | null)

const PANE = 'pulse'
// The version in the title tells the person which Pulse runs, so an update shows.
const TITLE = `Pulse ${VERSION}`
// The running bar ticks each second for the first two minutes of a turn, then every fifth second.
const FAST_TICKS = 120
const SLOW_TICK_MS = 5_000
// Between turns the cache countdown redraws the pane and the prompt hint this often, until the cache expires.
const IDLE_TICK_MS = 15_000
// A cache this small costs little to write again, so its expiry gets no toast.
const WARN_TOKENS = 10_000

// The timers that redraw the pane: while a main turn runs, and between turns until the cache expires. A reload starts
// without them, and the next turn starts them.
let ticker: Timer | undefined
let idle: Timer[] = []
// The token count at which auto-compaction runs, read at each main turn's end; null when it is off or unknown.
let compactAt: number | null = null

const stopTicker = (): void => {
  ticker?.cancel()
  ticker = undefined
  for (const t of idle) t.cancel()
  idle = []
}

// A tick redraws only what reads it: the pane. The idle tick also redraws the prompt hint, whose cache countdown moves between turns.
const bump = ($: EngineInterface): void => void quietly(() => update($, tick, n => n + 1))
const bumpIdle = ($: EngineInterface): void => {
  bump($)
  void quietly(() => update($, idleTick, n => n + 1))
}

const stallText = (now: number): string => {
  const q = quiet(now)
  const call = q?.call
  return call !== undefined && q !== null && call.ms >= q.ms
    ? `${ALERT} ${call.tool} has run for ${fmtMs(call.ms)}.`
    : `${ALERT} no model output or tool call for ${fmtMs(q?.ms ?? 0)}.`
}

// Each tick of a running turn checks whether it went quiet past the stallMinutes option, and says so once.
const checkStall = ($: EngineInterface): void =>
  void quietly(async () => {
    const now = await $.clock.now()
    if (shouldAlert(now, prefs.stallMinutes * 60_000)) $.ui.toast(stallText(now), { timeoutMs: 10_000 })
  })

// The ticks keep the working time, cost, and running bar current while the model streams; a state write redraws on its own.
// After the fast window one slower timer takes over, so no period passes without a redraw.
const startTicker = ($: EngineInterface): void => {
  let ticks = 0
  ticker = $.clock.every(1000, () => {
    ticks += 1
    bump($)
    checkStall($)
    if (ticks < FAST_TICKS) return
    stopTicker()
    ticker = $.clock.every(SLOW_TICK_MS, () => {
      bump($)
      checkStall($)
    })
  })
}

// After a main turn the cache counts down: a redraw every IDLE_TICK_MS, a toast before it expires, and one last redraw at expiry.
// Each timer joins `idle` as it starts, so a failed start leaves none that stopTicker cannot cancel.
const startIdle = ($: EngineInterface, leftMs: number, ttlMs: number, tokens: number | undefined): void => {
  if (leftMs <= 0) return
  idle.push($.clock.every(IDLE_TICK_MS, () => bumpIdle($)))
  idle.push(
    $.clock.after(leftMs, () => {
      stopTicker()
      bumpIdle($)
    }),
  )
  const lead = warnLeadMs(ttlMs)
  if (tokens !== undefined && tokens >= WARN_TOKENS && leftMs > lead) {
    const text = `Pulse: the prompt cache expires in ${fmtMs(lead)}. After that, the next turn writes ${fmtNum(tokens)} tokens to the cache again.`
    idle.push($.clock.after(leftMs - lead, () => void quietly(async () => $.ui.toast(text, { timeoutMs: 15_000 }))))
  }
}

// Every engine call goes through quietly: a hook passes its event on and returns what came back, whatever Pulse fails at.
export const register: Register = (on, options) => {
  setLevels(options)
  setPrefs(options)
  observe(on)
  observeTools(on)
  budgetBand(on)

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'pulse', description: 'Show token, timing, and tool metrics for this session' }))
    void quietly(() => $.ui.open({ id: PANE, title: TITLE }))
    // The pane starts from what $.state holds when a load fails; the next main turn tries the load again.
    await quietly(() => convertSaves($))
    await quietly(() => adopt($))
    await quietly(async () => refreshCosts($, await $.clock.now()))
    await quietly(() => forgetToastMark($))
    await quietly(async () => syncBudget($, await $.clock.now()))

    return next(e)
  })

  // What changed after the last turn (a /compact, a prompt count, spend by a background agent) reaches the store here.
  on('session.end', async ($, e, next) => {
    // The timers belong to the conversation that ends; after /clear or a resume they would warn about a cache that is gone.
    stopTicker()
    watchStop()
    resetRequest()
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
      resetRequest()
      resetLoops()
      const now = await quietly(() => $.clock.now())
      if (now !== undefined) watchStart(now)
      // A notification that wakes an idle session starts a turn; the task it reports on ends here.
      if (now !== undefined && opensAsNotice(e.text)) await record($, { kind: 'notice', text: e.text, now })
      await record($, { kind: 'turn-start', now })
      if (now !== undefined) await quietly(() => startTicker($))
      bump($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain) stopTicker()
    // A subagent that ends takes its failure counts with it.
    else resetLoops(e.agentId)
    const now = await quietly(() => $.clock.now())
    // The turn's steps stay on the strip, still, until the next turn starts.
    const past = isMain ? watchStop(now) : null
    const s = isMain ? await quietly(() => $.session.usage()) : undefined
    // The summary breakdown is counted locally and sends no request; it is the one place the auto-compact point shows. It is a
    // call of its own, so a failed estimate costs the runway only, not the turn's figures.
    if (isMain) {
      const b = (await quietly(() => $.session.usage({ breakdown: 'summary' })))?.context.breakdown
      if (b !== undefined) compactAt = b.isAutoCompactEnabled ? (b.autoCompactThreshold ?? null) : null
    }
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
      lastTurn: past ?? undefined,
    })
    // A subagent turn runs inside a main turn, whose end saves its figures too.
    if (isMain && m !== undefined && now !== undefined) {
      await persist($, m, now, m.turns.at(-1)?.costUsd ?? null)
      // A Hide in another open session reaches this one here, with that session's spend.
      await quietly(() => syncBudget($, now))
    }
    if (isMain && s !== undefined && now !== undefined && m !== undefined) {
      const left = cacheLeftMs(m, s, now)
      if (left !== null) await quietly(async () => startIdle($, left, cacheTtlMs(s), s.context.tokens))
    }

    return next(e)
  })

  // The summary rides on the hint line under the prompt, because $.ui.status labels it with the plugin name.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = await quietly(async () => {
      // Reading the idle tick subscribes the hint to the cache countdown, which moves between turns only.
      await read($, idleTick)
      const now = await $.clock.now()
      // Reading the day's totals subscribes the hint to them too, so a turn's spend shows when it ends.
      return statusText(await read($, metrics), await $.session.usage(), now, todaySpend(await read($, costs), now))
    })
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
      const compactingSince = await read($, compacting)
      const { startedAt, toolCalls } = m.running
      const q = quiet(now)

      return drawPane(
        { Box: table.Box, Text: table.Text, Svg },
        {
          m,
          usage,
          now,
          daily: await read($, costs),
          live:
            startedAt !== null
              ? {
                  ms: now - startedAt,
                  toolCalls,
                  steps: stepLog().map(s => ({
                    kind: s.kind,
                    name: s.name,
                    detail: s.detail,
                    fromMs: Math.max(0, s.startedAt - startedAt),
                    toMs: s.endedAt === null ? null : Math.max(0, s.endedAt - startedAt),
                    waits: s.waits,
                  })),
                  quietMs: q?.ms ?? 0,
                  stallMs: prefs.stallMinutes * 60_000,
                }
              : null,
          lastTurn: m.lastTurn ?? null,
          cacheLeftMs: cacheLeftMs(m, usage, now),
          cacheTtlMs: cacheTtlMs(usage),
          compactAt,
          compactingMs: compactingSince === null ? null : Math.max(0, now - compactingSince),
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
