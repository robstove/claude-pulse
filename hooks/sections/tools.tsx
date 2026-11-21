import type { Metrics, ToolStat } from '../../types'
import { FONT, HEX, blockBar, esc, fmtMs, svg } from '../charts'
import type { Section, Ui } from './ui'

/** `mcp__server__tool` reads as `tool`, so two tools of one server do not truncate to the same label. */
const toolLabel = (name: string): string => {
  const parts = name.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name
}

/** Nearest-rank percentile; 0 for no samples. */
const percentile = (xs: readonly number[], p: number): number => {
  if (xs.length === 0) return 0
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.max(0, Math.ceil(p * s.length) - 1)] ?? 0
}

/** One row per tool: total time as the bar, the error share as a red tail, count and time at the right. */
const toolsSvg = (w: number, tools: readonly [string, ToolStat][]): string => {
  const rowH = 20
  const labelW = Math.min(132, Math.round(w * 0.32))
  const statW = 64
  const barW = w - labelW - statW - 8
  const max = Math.max(1, ...tools.map(([, s]) => s.ms))
  const rows = tools.map(([name, s], i) => {
    const y = i * rowH
    const bw = Math.max(3, (s.ms / max) * barW)
    const errW = s.count > 0 ? (s.errors / s.count) * bw : 0
    const shown = toolLabel(name)
    const short = shown.length > 18 ? `${shown.slice(0, 17)}…` : shown
    const spread = s.samples.length > 0 ? `, p50 ${fmtMs(percentile(s.samples, 0.5))}, p95 ${fmtMs(percentile(s.samples, 0.95))}` : ''
    const refused = (s.refused ? `, ${s.refused} refused` : '') + (s.waited ? `, ${s.waited} with approval ${fmtMs(s.waitMs)}` : '')
    const title = `${name}: ${s.count} calls, ${s.errors} errors${refused}, ${fmtMs(s.ms)} total, ${fmtMs(s.ms / Math.max(1, s.count - s.waited))} average${spread}`
    return (
      `<g><title>${esc(title)}</title><rect y="${y}" width="${w}" height="${rowH}" fill="transparent"/>` +
      `<text x="0" y="${y + 14}" fill="${HEX.muted}" font-size="11" ${FONT}>${esc(short)}</text>` +
      `<rect x="${labelW}" y="${y + 6}" width="${barW}" height="8" rx="4" fill="${HEX.track}"/>` +
      `<rect x="${labelW}" y="${y + 6}" width="${bw.toFixed(1)}" height="8" rx="4" fill="${HEX.accent}"/>` +
      (errW > 0
        ? `<rect x="${(labelW + bw - errW).toFixed(1)}" y="${y + 6}" width="${Math.max(errW, 3).toFixed(1)}" height="8" rx="4" fill="${HEX.bad}"/>`
        : '') +
      `<text x="${w}" y="${y + 14}" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>` +
      `${s.count}× ${s.waited === s.count ? 'approval' : esc(fmtMs(s.ms))}</text></g>`
    )
  })
  return svg(w, Math.max(rowH, tools.length * rowH), rows.join(''))
}

/** Background tasks: how many still run, and those that ended with their time and failures. Empty when there are none. */
const backgroundText = (m: Metrics): string => {
  const running = Object.keys(m.tasks).length
  const done = m.background
  return [
    running > 0 ? `${running} in background` : '',
    done.count > 0 ? `${done.count} background done in ${fmtMs(done.ms)}` : '',
    done.failed > 0 ? `${done.failed} failed` : '',
    done.stopped > 0 ? `${done.stopped} stopped` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

/** The calls that did not simply run: failed in red, refused in amber, then approval waits and background tasks; null when none. */
const statusLine = (ui: Ui, m: Metrics) => {
  const { Text } = ui
  const parts = [
    m.toolErrors > 0 ? { text: `${m.toolErrors} failed`, color: 'error' as const } : null,
    m.toolRefusals > 0 ? { text: `${m.toolRefusals} refused`, color: 'warning' as const } : null,
    m.toolWaited > 0 ? { text: `${m.toolWaited} with approval ${fmtMs(m.toolWaitMs)}` } : null,
    // One phrase, so a background task's "failed" never reads as a tool call's red one.
    backgroundText(m) !== '' ? { text: backgroundText(m) } : null,
  ].filter(p => p !== null)
  if (parts.length === 0) return null
  return (
    <Text size="caption" tabular>
      {parts.map((p, i) => (
        <Text color={'color' in p ? p.color : undefined} dimColor={!('color' in p)}>
          {i > 0 ? ' · ' : ''}
          {p.text}
        </Text>
      ))}
    </Text>
  )
}

const slowestLines = (ui: Ui, m: Metrics) => {
  const slow = m.slowest.slice(0, 3)
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

/** Time per tool with failed, refused, and approval-held calls, the background tasks, and the slowest calls. */
export const tools: Section = (ui, { m, rows }) => {
  const { Text } = ui
  // A tool whose every call was refused ran no call, so it gets no row; the Tools line counts its refusals.
  const list = Object.entries(m.byTool)
    .filter(([, s]) => s.count > 0)
    .sort((a, b) => b[1].ms - a[1].ms)
  const meta = `${m.toolCalls + m.toolRefusals} calls · ${fmtMs(m.toolMsTotal)}`
  const status = statusLine(ui, m)
  if (list.length === 0) {
    return ui.section('Tools', meta, [
      <Text size="caption" dimColor>
        No tool calls yet.
      </Text>,
      status,
    ])
  }
  if (ui.Svg) return ui.section('Tools', meta, [ui.chart(toolsSvg(ui.px, list.slice(0, 12)), `Time per tool, ${list.length} tools`), status, slowestLines(ui, m)])
  const top = list[0]?.[1].ms || 1
  return ui.section('Tools', meta, [
    ...list.slice(0, Math.max(3, rows - 24)).map(([name, s]) => (
      <Text>
        <Text dimColor>{toolLabel(name).slice(0, 13).padEnd(14)}</Text>
        <Text color={s.errors > 0 ? 'error' : 'suggestion'}>{blockBar(s.ms / top, 12)[0].padEnd(13)}</Text>
        <Text>
          {s.count}× {s.waited === s.count ? 'approval' : fmtMs(s.ms)}
        </Text>
      </Text>
    )),
    status,
    slowestLines(ui, m),
  ])
}
