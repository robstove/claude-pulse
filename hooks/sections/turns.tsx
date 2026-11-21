import type { Metrics, TurnRecord } from '../../types'
import { FONT, HEX, esc, fmtMs, fmtNum, fmtUsd, plural, sparkline, svg } from '../charts'
import type { LiveTurn, Section, Ui } from './ui'

/** Turn time over cost per turn on one x-axis, newest at the right; a turn of unknown cost draws a stub to keep the column. */
const turnsSvg = (w: number, done: readonly TurnRecord[], firstTurn: number, live: LiveTurn | null): string => {
  // The running turn draws as one more column, faded, with no cost yet.
  const turns: readonly TurnRecord[] = live
    ? [...done, { ms: live.ms, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null, toolCalls: live.toolCalls, isAborted: false, reason: '' }]
    : done
  const gutter = 34
  const timeH = 40
  const costH = 16
  const gap = 8
  const h = timeH + gap + costH
  const label = (y: number, text: string) => `<text x="0" y="${y}" fill="${HEX.muted}" font-size="10" ${FONT}>${text}</text>`
  // Each lane has its own baseline and its bars grow up from it, so no bar reads as a negative value.
  const rule = (y: number) => `<line x1="${gutter}" x2="${w}" y1="${y - 0.5}" y2="${y - 0.5}" stroke="${HEX.rule}"/>`
  const frame = label(timeH - 2, 'Time') + label(h - 2, 'Cost') + rule(timeH) + rule(h)
  if (turns.length === 0) {
    return svg(w, h, frame + `<text x="${gutter}" y="${timeH - 8}" fill="${HEX.muted}" font-size="11" ${FONT}>No turns yet</text>`)
  }
  const plotW = w - gutter
  const slot = plotW / Math.max(turns.length, 16)
  const bw = Math.max(3, Math.min(14, slot - 3))
  const maxMs = Math.max(1, ...turns.map(t => t.ms))
  const maxCost = Math.max(0, ...turns.map(t => t.costUsd ?? 0))
  const cols = turns.map((t, i) => {
    const x = w - (turns.length - i) * slot + (slot - bw) / 2
    const th = Math.max(2, (t.ms / maxMs) * (timeH - 4))
    const timeFill = t.isAborted ? HEX.bad : t.ms >= 180_000 ? HEX.warn : HEX.accent
    const ch = t.costUsd === null || maxCost === 0 ? 2 : Math.max(2, (t.costUsd / maxCost) * costH)
    const costFill = t.costUsd === null ? HEX.track : HEX.cost
    const isLive = live !== null && i === turns.length - 1
    const title = isLive
      ? `Turn ${firstTurn + i}: running for ${fmtMs(t.ms)}, ${t.toolCalls} tool calls so far`
      : `Turn ${firstTurn + i}: ${fmtMs(t.ms)}` +
        (t.costUsd !== null ? `, ${fmtUsd(t.costUsd)}` : ', cost unknown') +
        `, ${t.toolCalls} tool calls, ${fmtNum(t.inputTokens)} in / ${fmtNum(t.outputTokens)} out` +
        (t.contextPct !== null ? `, context ${t.contextPct}%` : '') +
        (t.isAborted ? ', interrupted' : '')
    return (
      `<g${isLive ? ' opacity="0.55"' : ''}><title>${esc(title)}</title>` +
      `<rect x="${(x - 1.5).toFixed(1)}" width="${(bw + 3).toFixed(1)}" height="${h}" fill="transparent"/>` +
      `<rect x="${x.toFixed(1)}" y="${(timeH - 1 - th).toFixed(1)}" width="${bw.toFixed(1)}" height="${th.toFixed(1)}" rx="1.5" fill="${timeFill}"/>` +
      `<rect x="${x.toFixed(1)}" y="${(h - 1 - ch).toFixed(1)}" width="${bw.toFixed(1)}" height="${ch.toFixed(1)}" rx="1.5" fill="${costFill}"/></g>`
    )
  })
  return svg(w, h, frame + cols.join(''))
}

/** One line on model requests: per turn, first-token time, stream speed, effort, server tools, and cut-off replies. */
const requestsLine = (ui: Ui, m: Metrics) => {
  const s = m.steps
  if (s.count === 0) return null
  const counted = m.turns.filter(t => t.steps !== undefined)
  const perTurn = counted.length > 0 ? counted.reduce((a, t) => a + (t.steps ?? 0), 0) / counted.length : null
  const bits = [
    perTurn !== null ? `${perTurn.toFixed(1)} requests a turn` : plural(s.count, 'request'),
    s.firstTokenN > 0 ? `first token ${fmtMs(s.firstTokenMs / s.firstTokenN)}` : null,
    s.streamMs > 0 ? `${Math.round(s.streamOutput / (s.streamMs / 1000))} tok/s` : null,
    s.effort ? `effort ${s.effort}` : null,
    ...Object.entries(s.serverTools).map(([n, c]) => `${n} ${c}×`),
  ].filter(b => b !== null)
  const cut = s.stopReasons.max_tokens ?? 0
  return (
    <ui.Box flexDirection="column">
      {ui.caption(bits.join(' · '))}
      {cut > 0 && ui.caption(`${plural(cut, 'reply', 'replies')} hit the output token limit`, 'warning')}
    </ui.Box>
  )
}

// A turn quiet this long shows its quiet time; it turns amber past the stallMinutes option.
const QUIET_SHOW_MS = 30_000

/** Main turns that did not end with an answer, in red; nothing when every turn answered. */
const endsLine = (ui: Ui, m: Metrics) => {
  const r = m.endReasons
  const bits = [r.aborted ? `${r.aborted} interrupted` : null, r.error ? plural(r.error, 'API error') : null, r.refusal ? `${r.refusal} refused` : null].filter(
    b => b !== null,
  )
  return bits.length > 0 ? ui.caption(bits.join(' · '), 'error') : null
}

/** Time and cost per turn, the running turn, model requests, and the turns that did not answer. */
export const turns: Section = (ui, { m, live }) => {
  const { Text } = ui
  const avgMs = m.mainTurns > 0 ? m.turnMsTotal / m.mainTurns : 0
  const costPending = m.turns.length > 0 && m.turns.every(t => t.costUsd === null)
  const firstTurn = m.mainTurns - m.turns.length + 1
  return ui.section(
    'Turns',
    live ? (
      <Text size="caption" tabular>
        <Text color="claude" weight="semibold">
          Running {fmtMs(Math.max(1000, Math.floor(live.ms / 1000) * 1000))}
        </Text>
        <Text dimColor>
          {' '}
          · {plural(live.toolCalls, 'tool call')}
        </Text>
        {live.quietMs >= QUIET_SHOW_MS && (
          <Text color={live.stallMs > 0 && live.quietMs >= live.stallMs ? 'warning' : undefined} dimColor={live.stallMs === 0 || live.quietMs < live.stallMs}>
            {' '}
            · quiet {fmtMs(Math.floor(live.quietMs / 1000) * 1000)}
          </Text>
        )}
      </Text>
    ) : m.mainTurns === 0 ? (
      'none yet'
    ) : (
      `${plural(m.mainTurns, 'turn')}${m.agentTurns > 0 ? ` + ${m.agentTurns} subagent` : ''} · avg ${fmtMs(avgMs)} · max ${fmtMs(m.longestTurnMs)}`
    ),
    [
      ui.Svg ? (
        ui.chart(turnsSvg(ui.px, m.turns, firstTurn, live), `Turn time and cost, last ${fmtMs(m.lastTurnMs)}`)
      ) : (
        <Text color="suggestion">{sparkline([...m.turns.map(t => t.ms), ...(live ? [live.ms] : [])].slice(-ui.cells)) || 'No turns yet'}</Text>
      ),
      costPending && ui.caption('Cost per turn shows from the next turn.'),
      requestsLine(ui, m),
      endsLine(ui, m),
    ],
  )
}
