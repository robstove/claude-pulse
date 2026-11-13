import type { BoxProps, ElementConstructor, RenderElement, SessionUsage, SvgProps, TextProps } from 'claude-code'

import type { Metrics } from '../types'
import {
  HEX,
  blockBar,
  fmtMs,
  fmtNum,
  fmtUsd,
  gaugeSvg,
  heightOf,
  level,
  sparkline,
  stackSvg,
  toolLabel,
  toolsSvg,
  turnsSvg,
} from './charts'
import type { LiveTurn } from './charts'

export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Svg?: ElementConstructor<SvgProps>
}

export type PaneData = {
  m: Metrics
  usage: SessionUsage
  elapsedMs: number
  /** The pane body's width in cells of the surface's code font. */
  columns: number
  rows: number
  /** The running main turn, or null between turns. */
  live: LiveTurn | null
}

const THEME = { ok: 'success', warn: 'warning', bad: 'error' } as const
// A remote surface counts cells in its code font; about 7px each keeps a chart inside the body.
const PX_PER_CELL = 7

export const drawPane = ({ Box, Text, Svg }: Kit, { m, usage, elapsedMs, columns, rows, live }: PaneData): RenderElement => {
  const px = Math.max(220, Math.min(720, Math.floor(columns * PX_PER_CELL) - 4))
  const cells = Math.max(16, columns - 2)
  const ctxPct = usage.context.percent ?? 0
  const ctxLevel = level(ctxPct, 60, 80)
  const avgMs = m.mainTurns > 0 ? m.turnMsTotal / m.mainTurns : 0
  const tools = Object.entries(m.byTool).sort((a, b) => b[1].ms - a[1].ms)
  const tokenParts = [
    { value: m.cacheReadTokens, color: HEX.cacheRead, label: 'Cache read' },
    { value: m.cacheWriteTokens, color: HEX.cacheWrite, label: 'Cache write' },
    { value: m.inputTokens, color: HEX.input, label: 'Input' },
    { value: m.outputTokens, color: HEX.output, label: 'Output' },
  ]
  const tokenTotal = tokenParts.reduce((s, p) => s + p.value, 0)
  const inTotal = m.cacheReadTokens + m.cacheWriteTokens + m.inputTokens
  const cachedPct = inTotal > 0 ? Math.round((m.cacheReadTokens / inTotal) * 100) : 0
  const costPending = m.turns.length > 0 && m.turns.every(t => t.costUsd === null)
  const pluginCalls = Object.entries(m.pluginCalls)

  const chart = (source: string, alt: string, isInteractive = true) =>
    Svg ? <Svg source={source} alt={alt} width={px} height={heightOf(source)} isInteractive={isInteractive || undefined} /> : null

  const termBar = (frac: number, color: string) => {
    const [filled, empty] = blockBar(frac, cells)
    return (
      <Text>
        <Text color={color}>{filled}</Text>
        <Text dimColor>{empty}</Text>
      </Text>
    )
  }

  const section = (title: string, meta: RenderElement | string, body: RenderElement | (RenderElement | null | false)[]) => (
    <Box flexDirection="column" gap="xs">
      <Box flexDirection="row" justifyContent="space-between" columnGap="sm" flexWrap="wrap">
        <Text weight="semibold" size="footnote">
          {title}
        </Text>
        {typeof meta === 'string' ? (
          <Text size="caption" dimColor tabular>
            {meta}
          </Text>
        ) : (
          meta
        )}
      </Box>
      {body}
    </Box>
  )

  return (
    <Box flexDirection="column" gap="lg">
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
        <Box flexDirection="column">
          <Text size="title" weight="semibold" tabular>
            {usage.cost ? fmtUsd(usage.cost.usd) : 'n/a'}
          </Text>
          <Text size="caption" dimColor>
            Session cost
          </Text>
        </Box>
        <Box flexDirection="column" alignItems="flex-end">
          <Text size="heading" tabular>
            {fmtMs(elapsedMs)}
          </Text>
          <Text size="caption" dimColor>
            Elapsed
          </Text>
        </Box>
      </Box>

      {section(
        'Context',
        <Text size="caption" tabular>
          <Text dimColor>
            {usage.context.tokens !== undefined ? fmtNum(usage.context.tokens) : '-'} / {fmtNum(usage.context.window)}
            {'  '}
          </Text>
          <Text weight="semibold" color={ctxLevel === 'ok' ? undefined : THEME[ctxLevel]}>
            {ctxPct}%
          </Text>
        </Text>,
        Svg ? chart(gaugeSvg(px, ctxPct), `Context ${ctxPct}% full`, false)! : termBar(ctxPct / 100, THEME[ctxLevel]),
      )}

      {section(
        'Turns',
        live ? (
          <Text size="caption" tabular>
            <Text color="claude" weight="semibold">
              Running {fmtMs(Math.max(1000, Math.floor(live.ms / 1000) * 1000))}
            </Text>
            <Text dimColor>
              {' '}
              · {live.toolCalls} tool {live.toolCalls === 1 ? 'call' : 'calls'}
            </Text>
          </Text>
        ) : m.mainTurns === 0 ? (
          'none yet'
        ) : (
          `${m.mainTurns}${m.agentTurns > 0 ? ` + ${m.agentTurns} subagent` : ''} · avg ${fmtMs(avgMs)} · max ${fmtMs(m.longestTurnMs)}`
        ),
        [
          Svg
            ? chart(turnsSvg(px, m.turns, m.mainTurns - m.turns.length + 1, live), `Turn time and cost, last ${fmtMs(m.lastTurnMs)}`)
            : (
              <Text color="suggestion">
                {sparkline([...m.turns.map(t => t.ms), ...(live ? [live.ms] : [])].slice(-cells)) || 'No turns yet'}
              </Text>
            ),
          costPending && (
            <Text size="caption" dimColor>
              Cost per turn shows from the next turn.
            </Text>
          ),
        ],
      )}

      {section(
        'Tokens',
        tokenTotal === 0 ? 'none yet' : `${fmtNum(tokenTotal)} · ${cachedPct}% of input cached`,
        [
          Svg ? chart(stackSvg(px, tokenParts), 'Token mix') : termBar(inTotal > 0 ? m.cacheReadTokens / inTotal : 0, 'suggestion'),
          <Box flexDirection="row" flexWrap="wrap" columnGap="md" rowGap="xs">
            {tokenParts.map(p => (
              <Text size="caption">
                <Text backgroundColor={p.color}>{'  '}</Text>
                <Text dimColor> {p.label} </Text>
                <Text tabular>{fmtNum(p.value)}</Text>
              </Text>
            ))}
          </Box>,
        ],
      )}

      {section(
        'Tools',
        <Text size="caption" tabular>
          <Text dimColor>
            {m.toolCalls} calls · {fmtMs(m.toolMsTotal)}
          </Text>
          {m.toolErrors > 0 && <Text color="error"> · {m.toolErrors} failed</Text>}
        </Text>,
        tools.length === 0 ? (
          <Text size="caption" dimColor>
            No tool calls yet.
          </Text>
        ) : Svg ? (
          chart(toolsSvg(px, tools.slice(0, 12)), `Time per tool, ${tools.length} tools`)!
        ) : (
          tools.slice(0, Math.max(3, rows - 24)).map(([name, s]) => (
            <Text>
              <Text dimColor>{toolLabel(name).slice(0, 13).padEnd(14)}</Text>
              <Text color={s.errors > 0 ? 'error' : 'suggestion'}>{blockBar(s.ms / (tools[0]?.[1].ms || 1), 12)[0].padEnd(13)}</Text>
              <Text>
                {s.count}× {fmtMs(s.ms)}
              </Text>
            </Text>
          ))
        ),
      )}

      {(Object.keys(m.byModel).length > 0 || pluginCalls.length > 0) && (
        <Box flexDirection="column">
          {Object.keys(m.byModel).length > 0 && (
            <Text size="caption" dimColor>
              {Object.entries(m.byModel)
                .map(([id, n]) => `${id} · ${n} ${n === 1 ? 'turn' : 'turns'}`)
                .join('   ')}
            </Text>
          )}
          {pluginCalls.length > 0 && (
            <Text size="caption" dimColor>
              Not counted above: {pluginCalls.map(([p, n]) => `${n} calls by ${p}`).join(', ')}
            </Text>
          )}
        </Box>
      )}
    </Box>
  )
}
