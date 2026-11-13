import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, TurnUsage } from 'claude-code'

import type { AgentStat, ModelStat, TurnRecord } from '../types'
import { FILE_TOOLS, IDLE_CAP_MS, SAMPLES, callLabel, dayKey, nextRateStart, pushSlow } from './derive'
import { observe } from './observe'
import { drawPane } from './pane'
import { addDailyCost, loadDaily, loadSession, saveSession } from './persist'
import { EMPTY, MAX_TURNS, SHAPE, hasData, live } from './state'
import { statusText } from './status'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

const PANE = 'pulse'
const TITLE = 'Pulse'
// Paths stop at 100, so one session save stays near 30 KB.
const MAX_FILES = 100

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

// Binds $.state to this session id: keeps a match, adopts a pre-0.1.2 value that has no id, else loads what the store saved.
async function adoptSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const m = await read($, metrics)
  if (m.sessionId === id) return
  if (m.sessionId === undefined && hasData(m)) {
    await update($, metrics, held => ({ ...held, sessionId: id }))
    return
  }
  const saved = await loadSession($, id)
  // A session with no save starts from the cost the ledger holds now, so its first turn has a cost too.
  const cost = saved ? saved.lastCostUsd : ((await $.session.usage()).cost?.usd ?? null)
  await update($, metrics, () => ({ ...(saved ?? EMPTY), lastCostUsd: cost, sessionId: id }))
}

export const register: Register = on => {
  observe(on)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pulse',
      description: 'Show token, timing, and tool metrics for this session',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    try {
      await adoptSession($)
    } catch {
      // The pane starts from what $.state holds; the next turn's save tries the store again.
    }

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Pulse pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const now = await $.clock.now()
      live.toolCalls = 0
      live.steps = 0
      live.startedAt = now
      live.ticker?.cancel()
      // One redraw a second keeps the elapsed time, cost, and running bar current while the model streams.
      live.ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
      try {
        await update($, metrics, m =>
          m.lastEndedAt === undefined ? m : { ...m, idleMs: (m.idleMs ?? 0) + Math.min(IDLE_CAP_MS, Math.max(0, now - m.lastEndedAt)) },
        )
      } catch {
        // Metrics are best effort.
      }
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const steps = live.steps
    if (isMain) {
      live.ticker?.cancel()
      live.ticker = undefined
      live.startedAt = null
    }
    const u = e.usage
    let costNow: number | null = null
    let contextPct: number | null = null
    let limits: Awaited<ReturnType<EngineInterface['session']['usage']>>['rateLimits'] = []
    const now = await $.clock.now()
    if (isMain) {
      try {
        const s = await $.session.usage()
        costNow = s.cost?.usd ?? null
        contextPct = s.context.percent ?? null
        limits = s.rateLimits
      } catch {
        // The per-turn cost and context points stay empty for this turn.
      }
    }
    const tools = live.toolCalls
    const before = (await read($, metrics)).lastCostUsd
    const turnCost = isMain && costNow !== null && before !== null ? Math.max(0, costNow - before) : null
    await update($, metrics, m => {
      const record: TurnRecord = {
        ms: e.durationMs,
        inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        outputTokens: u?.output_tokens ?? 0,
        costUsd: turnCost,
        contextPct,
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
        rateStart: isMain ? nextRateStart(m.rateStart, limits, now) : m.rateStart,
      }
    })
    try {
      const m = await read($, metrics)
      if (m.sessionId !== undefined) await saveSession($, m.sessionId, m)
      if (turnCost !== null && turnCost > 0) await addDailyCost($, dayKey(now), turnCost)
    } catch {
      // A failed save leaves the previous one in the store; the next turn saves again.
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // Only the engine's dispatch is the model's call; another plugin's $.tool.call is counted apart.
    const caller = next.origin.plugin
    if (caller !== 'engine') {
      const ran = await next(e)
      try {
        await update($, metrics, m => ({ ...m, pluginCalls: { ...m.pluginCalls, [caller]: (m.pluginCalls[caller] ?? 0) + 1 } }))
      } catch {
        // Metrics are best effort.
      }
      return ran
    }
    const started = await $.clock.now()
    const ran = await next(e)
    const ms = (await $.clock.now()) - started
    const failed = ran.deny !== undefined || ran.isError === true
    live.toolCalls += 1
    // A failed metrics write must not lose the tool's result.
    try {
      const input = e as unknown as Readonly<Record<string, unknown>>
      const label = callLabel(input)
      const path = input.file_path ?? input.notebook_path
      const file = !failed && FILE_TOOLS.has(e.tool) && typeof path === 'string' ? path : null
      await update($, metrics, m => {
        const prev = m.byTool[e.tool] ?? { count: 0, errors: 0, ms: 0 }
        const files = file === null ? m.files : { ...m.files, [file]: (m.files?.[file] ?? 0) + 1 }
        return {
          ...m,
          toolCalls: m.toolCalls + 1,
          toolErrors: m.toolErrors + (failed ? 1 : 0),
          toolMsTotal: m.toolMsTotal + ms,
          byTool: {
            ...m.byTool,
            [e.tool]: {
              count: prev.count + 1,
              errors: prev.errors + (failed ? 1 : 0),
              ms: prev.ms + ms,
              samples: [...(prev.samples ?? []), ms].slice(-SAMPLES),
            },
          },
          slowest: pushSlow(m.slowest, { tool: e.tool, ms, label }),
          files: files && Object.keys(files).length > MAX_FILES ? m.files : files,
        }
      })
    } catch {
      // Metrics are best effort.
    }

    return ran
  })

  // The summary rides on the hint line under the prompt, because $.ui.status labels it with the plugin name.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = statusText(await read($, metrics), await $.session.usage())
    if (e.surface === 'terminal') return next({ ...e, props: { ...e.props, tail: `  ${line}` } })
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
    const usage = await $.session.usage()
    const now = await $.clock.now()
    let daily: Record<string, number> = {}
    try {
      daily = await loadDaily($)
    } catch {
      // The History section draws empty.
    }

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
}
