import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentStat, Metrics, ModelStat, TurnRecord } from '../types'
import { IDLE_CAP_MS, dayKey, nextRateStart } from './derive'
import { observe } from './observe'
import { drawPane } from './pane'
import { addDailyCost, dropOtherShapes, loadDaily, loadSession, saveSession } from './persist'
import { quietly } from './quietly'
import { EMPTY, MAX_TURNS, SHAPE, hasData, live, setLevels } from './state'
import { statusText } from './status'
import { noteTaskNotice, observeTools } from './tools'
import { VERSION } from './version'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

const PANE = 'pulse'
// The version in the title tells the person which Pulse runs, so an update shows.
const TITLE = `Pulse ${VERSION}`
// The running bar redraws each second for the first two minutes of a turn, then every fifth second.
const FAST_TICKS_MS = 120_000
const SLOW_TICK = 5

// The turn counts toward the model that sent its last counted response; a mid-turn /model switch credits the new one.
const addModelTurn = (
  models: Record<string, ModelStat>,
  u: TurnUsage,
  mainMs: number | null,
): Record<string, ModelStat> => {
  const prev = models[u.model] ?? { turns: 0, mainTurns: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  return {
    ...models,
    [u.model]: {
      turns: prev.turns + 1,
      mainTurns: prev.mainTurns + (mainMs !== null ? 1 : 0),
      ms: prev.ms + (mainMs ?? 0),
      inputTokens: prev.inputTokens + u.input_tokens,
      outputTokens: prev.outputTokens + u.output_tokens,
      cacheReadTokens: prev.cacheReadTokens + u.cache_read_input_tokens,
      cacheWriteTokens: prev.cacheWriteTokens + u.cache_creation_input_tokens,
    },
  }
}

// A subagent turn counts toward its spawn's type; a turn of an agent spawned before a reload counts as "subagent".
const addAgentTurn = (agents: Record<string, AgentStat>, type: string, ms: number, u: TurnUsage | undefined): Record<string, AgentStat> => {
  const prev = agents[type] ?? { spawns: 0, turns: 0, ms: 0, inputTokens: 0, outputTokens: 0 }
  const input = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
  return {
    ...agents,
    [type]: { ...prev, turns: prev.turns + 1, ms: prev.ms + ms, inputTokens: prev.inputTokens + input, outputTokens: prev.outputTokens + (u?.output_tokens ?? 0) },
  }
}

// Binds $.state to this session id: keeps a match, keeps figures that built up while a failed load left no id, else loads
// what the store saved. It runs at session.start and at each main turn.start, because /clear and an in-process resume
// change the id with no session.start.
async function adoptSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const m = await read($, metrics)
  if (m.sessionId === id) return
  if (m.sessionId === undefined && hasData(m)) {
    await update($, metrics, held => ({ ...held, sessionId: id }))
    return
  }
  const saved = await loadSession($, id)
  // The baseline is the ledger of this process, which need not hold what an earlier process saved, so a first turn costs what it spent.
  const cost = (await quietly(() => $.session.usage()))?.cost?.usd ?? null
  // A saved task's process ended with the process that saved it, and no notification for it will come.
  await update($, metrics, () => ({ ...(saved ?? EMPTY), tasks: {}, lastCostUsd: cost, sessionId: id }))
}

// The save and the day's cost go apart, so a failed save does not lose the cost: the next save repeats the figures, not the cost.
async function persist($: EngineInterface, m: Metrics, now: number, cost: number | null): Promise<void> {
  const id = m.sessionId
  if (id !== undefined) await quietly(() => saveSession($, id, m))
  if (cost !== null && cost > 0) await quietly(() => addDailyCost($, dayKey(now), cost))
}

const redraw = ($: EngineInterface): void => void quietly(() => $.ui.invalidate('ui.render'))

// Every engine call goes through quietly: a hook passes its event on and returns what came back, whatever Pulse fails at.
export const register: Register = (on, options) => {
  setLevels(options)
  observe(on)
  observeTools(on)

  on('session.start', async ($, e, next) => {
    await quietly(() => $.command.register({ name: 'pulse', description: 'Show token, timing, and tool metrics for this session' }))
    void quietly(() => $.ui.open({ id: PANE, title: TITLE }))
    // The pane starts from what $.state holds when a load fails; the next main turn tries the load again.
    await quietly(() => dropOtherShapes($))
    await quietly(() => adoptSession($))

    return next(e)
  })

  // What changed after the last turn (a /compact, a prompt count, spend by a background agent) reaches the store here.
  on('session.end', async ($, e, next) => {
    await quietly(async () => {
      const now = await $.clock.now()
      const costNow = (await quietly(() => $.session.usage()))?.cost?.usd ?? null
      const before = (await read($, metrics)).lastCostUsd
      const spent = costNow !== null && before !== null ? Math.max(0, costNow - before) : null
      const m = await update($, metrics, held => (costNow === null ? held : { ...held, lastCostUsd: costNow }))
      await persist($, m, now, spent)
      // After /clear or an in-process resume the process goes on under another id: the pane empties now,
      // and the next main turn binds the new id and loads its save.
      if (e.reason === 'clear' || e.reason === 'resume') await update($, metrics, () => EMPTY)
    })

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await quietly(() => $.ui.open({ id: PANE, title: TITLE }))

    return { text: 'Pulse pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await quietly(() => adoptSession($))
      // A notification that wakes an idle session starts a turn; the task it reports on ends here.
      await quietly(() => noteTaskNotice($, e.text))
      live.toolCalls = 0
      live.steps = 0
      live.startedAt = null
      live.ticker?.cancel()
      live.ticker = undefined
      await quietly(async () => {
        const now = await $.clock.now()
        live.startedAt = now
        // The ticks keep the elapsed time, cost, and running bar current while the model streams; a state write redraws on its own.
        let ticks = 0
        live.ticker = $.clock.every(1000, () => {
          ticks += 1
          if (ticks * 1000 <= FAST_TICKS_MS || ticks % SLOW_TICK === 0) redraw($)
        })
        await update($, metrics, m =>
          m.lastEndedAt === undefined ? m : { ...m, idleMs: (m.idleMs ?? 0) + Math.min(IDLE_CAP_MS, Math.max(0, now - m.lastEndedAt)) },
        )
      })
      redraw($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const steps = live.steps
    const tools = live.toolCalls
    if (isMain) {
      live.ticker?.cancel()
      live.ticker = undefined
      live.startedAt = null
    }
    await quietly(async () => {
      const u = e.usage
      const now = await $.clock.now()
      const s = isMain ? await quietly(() => $.session.usage()) : undefined
      const costNow = s?.cost?.usd ?? null
      const before = (await read($, metrics)).lastCostUsd
      const turnCost = isMain && costNow !== null && before !== null ? Math.max(0, costNow - before) : null
      const saved = await update($, metrics, m => {
        const record: TurnRecord = {
          ms: e.durationMs,
          inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
          outputTokens: u?.output_tokens ?? 0,
          costUsd: turnCost,
          contextPct: s?.context.percent ?? null,
          toolCalls: tools,
          isAborted: e.isAborted,
          steps,
          reason: e.reason,
        }
        const agentType = isMain ? null : (m.agentTypes?.[e.agentId ?? ''] ?? 'subagent')
        return {
          ...m,
          mainTurns: m.mainTurns + (isMain ? 1 : 0),
          agentTurns: m.agentTurns + (isMain ? 0 : 1),
          abortedTurns: m.abortedTurns + (e.isAborted ? 1 : 0),
          inputTokens: m.inputTokens + (u?.input_tokens ?? 0),
          outputTokens: m.outputTokens + (u?.output_tokens ?? 0),
          cacheReadTokens: m.cacheReadTokens + (u?.cache_read_input_tokens ?? 0),
          cacheWriteTokens: m.cacheWriteTokens + (u?.cache_creation_input_tokens ?? 0),
          // Timing covers main-loop turns only, because a subagent turn runs inside one.
          turnMsTotal: m.turnMsTotal + (isMain ? e.durationMs : 0),
          lastTurnMs: isMain ? e.durationMs : m.lastTurnMs,
          longestTurnMs: isMain ? Math.max(m.longestTurnMs, e.durationMs) : m.longestTurnMs,
          models: u ? addModelTurn(m.models ?? {}, u, isMain ? e.durationMs : null) : m.models,
          turns: isMain ? [...m.turns, record].slice(-MAX_TURNS) : m.turns,
          lastCostUsd: isMain && costNow !== null ? costNow : m.lastCostUsd,
          endReasons: isMain ? { ...m.endReasons, [e.reason]: (m.endReasons?.[e.reason] ?? 0) + 1 } : m.endReasons,
          agents: agentType !== null ? addAgentTurn(m.agents ?? {}, agentType, e.durationMs, u) : m.agents,
          workMs: (m.workMs ?? 0) + (isMain ? e.durationMs : 0),
          lastEndedAt: isMain ? now : m.lastEndedAt,
          rateStart: isMain ? nextRateStart(m.rateStart, s?.rateLimits ?? [], now) : m.rateStart,
        }
      })
      await persist($, saved, now, turnCost)
    })

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
      // The History section draws empty when the daily totals do not load.
      const daily = (await quietly(() => loadDaily($))) ?? {}

      return drawPane(
        { Box: table.Box, Text: table.Text, Svg },
        {
          m: await read($, metrics),
          usage,
          now,
          daily,
          elapsedMs: now - usage.startedAt,
          live: live.startedAt !== null ? { ms: now - live.startedAt, toolCalls: live.toolCalls } : null,
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
