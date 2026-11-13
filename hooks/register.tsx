import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Metrics, TurnRecord } from '../types'
import { drawPane } from './pane'
import { statusText } from './status'

const PANE = 'pulse'
const TITLE = 'Pulse'
const MAX_TURNS = 48

const EMPTY: Metrics = {
  mainTurns: 0,
  agentTurns: 0,
  abortedTurns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  turnMsTotal: 0,
  lastTurnMs: 0,
  longestTurnMs: 0,
  toolCalls: 0,
  toolErrors: 0,
  toolMsTotal: 0,
  byTool: {},
  byModel: {},
  pluginCalls: {},
  turns: [],
  lastCostUsd: null,
}

// Change the shape tag when a Metrics field changes: stored values outlive a reload.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, {
  shape: 'metrics-3',
})

export const register: Register = on => {
  // Tool calls of the running main turn; a reload mid-turn undercounts that one turn.
  let turnToolCalls = 0
  // The running main turn; a reload cancels the ticker, so the pane shows no live turn until the next one starts.
  let liveStartedAt: number | null = null
  let ticker: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'pulse',
      description: 'Show token, timing, and tool metrics for this session',
    })
    void $.ui.open({ id: PANE, title: TITLE })
    // Clears the labeled status line an earlier version pinned; the summary now sits in the prompt hint.
    $.ui.status(undefined)

    return next(e)
  })

  on('command.run', { command: 'pulse' }, async $ => {
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Pulse pane opened.' }
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      turnToolCalls = 0
      liveStartedAt = await $.clock.now()
      ticker?.cancel()
      // One redraw a second keeps the elapsed time, cost, and running bar current while the model streams.
      ticker = $.clock.every(1000, () => $.ui.invalidate('ui.render'))
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const isMain = e.agentId === undefined
    if (isMain) {
      ticker?.cancel()
      ticker = undefined
      liveStartedAt = null
    }
    const u = e.usage
    let costNow: number | null = null
    let contextPct: number | null = null
    if (isMain) {
      try {
        const s = await $.session.usage()
        costNow = s.cost?.usd ?? null
        contextPct = s.context.percent ?? null
      } catch {
        // The per-turn cost and context points stay empty for this turn.
      }
    }
    const tools = turnToolCalls
    await update($, metrics, m => {
      const record: TurnRecord = {
        ms: e.durationMs,
        inputTokens: (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0),
        outputTokens: u?.output_tokens ?? 0,
        costUsd: costNow !== null && m.lastCostUsd !== null ? Math.max(0, costNow - m.lastCostUsd) : null,
        contextPct,
        toolCalls: tools,
        isAborted: e.isAborted,
      }
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
        byModel: u ? { ...m.byModel, [u.model]: (m.byModel[u.model] ?? 0) + 1 } : m.byModel,
        turns: isMain ? [...m.turns, record].slice(-MAX_TURNS) : m.turns,
        lastCostUsd: isMain && costNow !== null ? costNow : m.lastCostUsd,
      }
    })

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
    turnToolCalls += 1
    // A failed metrics write must not lose the tool's result.
    try {
      await update($, metrics, m => {
        const prev = m.byTool[e.tool] ?? { count: 0, errors: 0, ms: 0 }
        return {
          ...m,
          toolCalls: m.toolCalls + 1,
          toolErrors: m.toolErrors + (failed ? 1 : 0),
          toolMsTotal: m.toolMsTotal + ms,
          byTool: {
            ...m.byTool,
            [e.tool]: { count: prev.count + 1, errors: prev.errors + (failed ? 1 : 0), ms: prev.ms + ms },
          },
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

    return drawPane(
      { Box: table.Box, Text: table.Text, Svg },
      {
        m: await read($, metrics),
        usage,
        elapsedMs: now - usage.startedAt,
        live: liveStartedAt !== null ? { ms: now - liveStartedAt, toolCalls: turnToolCalls } : null,
        columns: e.props.bodyColumns ?? 40,
        rows: e.viewport?.rows ?? 40,
      },
    )
  })
}
