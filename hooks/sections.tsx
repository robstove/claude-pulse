import type { BoxProps, ElementConstructor, RenderElement, SvgProps, TextProps } from 'claude-code'

import type { Metrics } from '../types'
import { HEX, THEME, fmtMs, fmtNum, fmtUsd, level, modelLabel, plural, sparkline, stackSvg, toolLabel } from './charts'
import { WINDOW_MS, lastDays, shortPath } from './derive'
import type { Pace } from './derive'
import { historySvg, limitsSvg } from './meters'

/** What drawPane hands each section: the element table, the chart width, and its shared helpers. */
export type Ui = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Svg?: ElementConstructor<SvgProps>
  px: number
  cells: number
  section: (title: string, meta: RenderElement | string, body: RenderElement | (RenderElement | null | false)[]) => RenderElement
  chart: (source: string, alt: string, isInteractive?: boolean) => RenderElement | null
  /** A bar of block characters, `cells` wide unless a row puts a label before it. */
  termBar: (frac: number, color: string, width?: number) => RenderElement
}

// The cells of a terminal Limits row before its bar.
const LABEL = 8

const caption = ({ Text }: Ui, text: string, color?: TextProps['color']) => (
  <Text size="caption" dimColor={color === undefined} color={color} tabular>
    {text}
  </Text>
)

export const limitsSection = (ui: Ui, paces: readonly Pace[]): RenderElement | null => {
  if (paces.length === 0) return null
  const { Text } = ui
  // The window that fills before it resets is the one to warn about; with no reset time, a known window's length bounds it.
  const risk = paces.find(p => {
    const left = p.resetsInMs ?? WINDOW_MS[p.kind]
    return p.fullInMs !== null && left !== undefined && p.fullInMs < left
  })
  const top = Math.max(...paces.map(p => p.pct))
  const meta = risk ? (
    <Text size="caption" color="error" weight="semibold" tabular>
      {risk.fullInMs !== null && risk.fullInMs > 0 ? `${risk.label} full in ~${fmtMs(risk.fullInMs)}` : `${risk.label} full`}
    </Text>
  ) : (
    <Text size="caption" tabular color={level(top) === 'ok' ? undefined : THEME[level(top)]} dimColor={level(top) === 'ok'}>
      {top}% at most
    </Text>
  )
  return ui.section('Limits', meta, [
    ui.Svg ? (
      ui.chart(limitsSvg(ui.px, paces), `Rate limits: ${paces.map(p => `${p.label} ${p.pct}%`).join(', ')}`)
    ) : (
      <ui.Box flexDirection="column">
        {paces.map(p => (
          // The label and the bar together fill `cells`, so the row does not wrap.
          <Text>
            <Text dimColor>{p.label.slice(0, LABEL - 1).padEnd(LABEL)}</Text>
            {ui.termBar(p.pct / 100, THEME[level(p.pct)], Math.max(LABEL, ui.cells - LABEL))}
          </Text>
        ))}
      </ui.Box>
    ),
    ...paces.map(p =>
      caption(
        ui,
        `${p.label}: ${p.resetsInMs !== null ? `resets in ${fmtMs(p.resetsInMs)}` : 'no reset time'}` +
          (p.perHour !== null ? ` · +${p.perHour.toFixed(1)} pts/h` : ' · pace after 10 min'),
      ),
    ),
  ])
}

export const activitySection = (ui: Ui, m: Metrics): RenderElement | null => {
  // Both counts start when Pulse first loads in the session, so the split compares like with like.
  const claude = m.turnMsTotal
  const you = m.idleMs ?? 0
  const prompts = m.prompts ?? 0
  if (claude + you === 0 && prompts === 0) return null
  // Until a main turn ends there is no time to split, and a 0% share would be false.
  const timed = claude + you > 0
  const share = timed ? Math.round((claude / (claude + you)) * 100) : 0
  const commands = Object.entries(m.commands ?? {}).sort((a, b) => b[1] - a[1])
  const cmdCount = commands.reduce((s, [, n]) => s + n, 0)
  const parts = [
    { value: claude, color: HEX.accent, label: 'Claude working' },
    { value: you, color: HEX.muted, label: 'Between turns' },
  ]
  return ui.section('Activity', timed ? `Claude ${share}% · you ${100 - share}%` : 'no turn ended yet', [
    timed && (ui.Svg ? ui.chart(stackSvg(ui.px, parts), `Claude worked ${share}% of active time`) : ui.termBar(share / 100, 'suggestion')),
    caption(
      ui,
      `${plural(prompts, 'prompt')}` +
        (cmdCount > 0
          ? ` · ${plural(cmdCount, 'command')}: ${commands
              .slice(0, 4)
              .map(([c, n]) => `/${c}${n > 1 ? ` ${n}×` : ''}`)
              .join(', ')}`
          : ''),
    ),
    caption(ui, 'A gap over 30 min between turns counts as away.'),
  ])
}

/** One line on model requests: per turn, first-token time, stream speed, effort, server tools, and cut-off replies. */
export const requestsLine = (ui: Ui, m: Metrics): RenderElement | null => {
  const s = m.steps
  if (!s || s.count === 0) return null
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
      {caption(ui, bits.join(' · '))}
      {cut > 0 && caption(ui, `${plural(cut, 'reply', 'replies')} hit the output token limit`, 'warning')}
    </ui.Box>
  )
}

/** Main turns that did not end with an answer, in red; nothing when every turn answered. */
export const endsLine = (ui: Ui, m: Metrics): RenderElement | null => {
  const r = m.endReasons ?? {}
  const bits = [r.aborted ? `${r.aborted} interrupted` : null, r.error ? plural(r.error, 'API error') : null, r.refusal ? `${r.refusal} refused` : null].filter(
    b => b !== null,
  )
  return bits.length > 0 ? caption(ui, bits.join(' · '), 'error') : null
}

/** Background tasks: how many still run, and those that ended with their time and failures. Empty when there are none. */
export const backgroundText = (m: Metrics): string => {
  const running = Object.keys(m.tasks ?? {}).length
  const done = m.background
  const bits = [running > 0 ? `${running} in background` : '', done && done.count > 0 ? `${done.count} background done in ${fmtMs(done.ms)}` : '']
  if (done && done.failed > 0) bits.push(`${done.failed} failed`)
  if (done && (done.stopped ?? 0) > 0) bits.push(`${done.stopped} stopped`)
  return bits.filter(Boolean).join(', ')
}

export const slowestLines = (ui: Ui, m: Metrics): RenderElement | null => {
  const slow = (m.slowest ?? []).slice(0, 3)
  if (slow.length === 0) return null
  const { Text, Box } = ui
  return (
    <Box flexDirection="column">
      <Text size="caption" dimColor>
        Slowest calls
      </Text>
      {slow.map(c => (
        <Box flexDirection="row" columnGap="sm">
          <Box width="12%">
            <Text size="caption" tabular>
              {fmtMs(c.ms)}
            </Text>
          </Box>
          <Text size="caption" dimColor>
            {toolLabel(c.tool)}
            {c.background ? ' (background)' : ''}
            {c.label ? ` · ${c.label.length > 48 ? `${c.label.slice(0, 47)}…` : c.label}` : ''}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

export const filesSection = (ui: Ui, m: Metrics): RenderElement | null => {
  const files = Object.entries(m.files ?? {}).sort((a, b) => b[1] - a[1])
  if (files.length === 0) return null
  const edits = files.reduce((s, [, n]) => s + n, 0)
  const { Box, Text } = ui
  return ui.section(
    'Files',
    `${plural(files.length, 'file')} · ${plural(edits, 'edit')}`,
    files.slice(0, 5).map(([path, n]) => (
      <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
        <Text size="caption">{shortPath(path)}</Text>
        <Text size="caption" dimColor tabular>
          {n}×
        </Text>
      </Box>
    )),
  )
}

export const agentsSection = (ui: Ui, m: Metrics): RenderElement | null => {
  const agents = Object.entries(m.agents ?? {}).sort((a, b) => b[1].ms - a[1].ms)
  if (agents.length === 0) return null
  const spawns = agents.reduce((s, [, a]) => s + a.spawns, 0)
  const { Box, Text } = ui
  return ui.section(
    'Subagents',
    `${plural(spawns, 'start')} · ${plural(agents.length, 'type')}`,
    agents.slice(0, 6).map(([type, a]) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
          <Text size="caption" weight="semibold">
            {type}
          </Text>
          <Text size="caption" dimColor tabular>
            {a.spawns}× · {fmtMs(a.ms)}
          </Text>
        </Box>
        {caption(ui, `${fmtNum(a.inputTokens)} in · ${fmtNum(a.outputTokens)} out${a.model ? ` · ${modelLabel(a.model)}` : ''}`)}
      </Box>
    )),
  )
}

export const historySection = (ui: Ui, daily: Readonly<Record<string, number>>, now: number): RenderElement | null => {
  const days = lastDays(now, 14).map(d => [d, daily[d] ?? 0] as [string, number])
  const total = (n: number) => days.slice(-n).reduce((s, [, usd]) => s + usd, 0)
  if (total(14) === 0) return null
  const today = days[days.length - 1]?.[0] ?? ''
  return ui.section('History', `today ${fmtUsd(total(1))} · 7 days ${fmtUsd(total(7))}`, [
    ui.Svg ? (
      ui.chart(historySvg(ui.px, days, today), 'Cost per day, last 14 days')
    ) : (
      <ui.Text color="suggestion">{sparkline(days.map(([, usd]) => usd))}</ui.Text>
    ),
    caption(ui, 'All sessions, by the day each turn ended. Last 14 days.'),
  ])
}
