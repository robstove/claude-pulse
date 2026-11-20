import type { SessionRateLimit } from 'claude-code'

import type { RateStart } from '../../types'
import { FONT, HEX, THEME, esc, fmtMs, level, svg } from '../charts'
import type { Section } from './ui'

/** A pace needs this much history, so one early turn does not project a false limit. */
const PACE_MIN_MS = 10 * 60_000
const HOUR = 3_600_000
/** How long each known window runs, so a window with no reset time still has a bound for its warning. */
const WINDOW_MS: Readonly<Record<string, number>> = { five_hour: 5 * HOUR, seven_day: 7 * 24 * HOUR }
// The cells of a terminal Limits row before its bar.
const LABEL = 8

type Pace = {
  kind: string
  label: string
  pct: number
  resetsInMs: number | null
  /** Points of the window used per hour since the first reading; null until PACE_MIN_MS of history. */
  perHour: number | null
  /** Time to 100% at that pace, 0 once the window is full; null when the pace is flat or unknown. */
  fullInMs: number | null
  /** The fill at reset if the pace holds. */
  atResetPct: number | null
}

const windowLabel = (kind: string): string =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')

const paceOf = (l: SessionRateLimit, start: RateStart | undefined, now: number): Pace => {
  const resetsAt = l.resetsAt ? Date.parse(l.resetsAt) : Number.NaN
  const resetsInMs = Number.isFinite(resetsAt) ? Math.max(0, resetsAt - now) : null
  const span = start ? now - start.at : 0
  const perHour = start && span >= PACE_MIN_MS ? Math.max(0, ((l.percentUsed - start.pct) / span) * HOUR) : null
  return {
    kind: l.kind,
    label: windowLabel(l.kind),
    pct: l.percentUsed,
    resetsInMs,
    perHour,
    // A spend limit can pass 100%; a full window has no time left, not a negative one.
    fullInMs: perHour !== null && perHour > 0 ? (Math.max(0, 100 - l.percentUsed) / perHour) * HOUR : null,
    atResetPct: perHour !== null && resetsInMs !== null ? l.percentUsed + (perHour * resetsInMs) / HOUR : null,
  }
}

const paceTitle = (p: Pace): string =>
  `${p.label} window: ${p.pct}% used` +
  (p.resetsInMs !== null ? `, resets in ${fmtMs(p.resetsInMs)}` : '') +
  (p.perHour !== null ? `, +${p.perHour.toFixed(1)} points an hour this session` : ', pace shows after 10 minutes') +
  (p.atResetPct !== null ? `, about ${Math.round(Math.min(p.atResetPct, 999))}% at reset if it holds` : '')

/** One row per window: the fill in its level color, and a faint extension to where the pace reaches by the reset. */
const limitsSvg = (w: number, paces: readonly Pace[]): string => {
  const rowH = 20
  const labelW = 56
  const statW = 40
  const barW = w - labelW - statW - 8
  const rows = paces.map((p, i) => {
    const y = i * rowH
    const fill = HEX[level(p.pct)]
    const fw = (Math.min(100, p.pct) / 100) * barW
    const ahead = p.atResetPct !== null ? (Math.min(100, p.atResetPct) / 100) * barW : fw
    const reach = p.atResetPct !== null && p.atResetPct >= 100 ? HEX.bad : fill
    return (
      `<g><title>${esc(paceTitle(p))}</title><rect y="${y}" width="${w}" height="${rowH}" fill="transparent"/>` +
      `<text x="0" y="${y + 14}" fill="${HEX.muted}" font-size="11" ${FONT}>${esc(p.label)}</text>` +
      `<rect x="${labelW}" y="${y + 6}" width="${barW}" height="8" rx="4" fill="${HEX.track}"/>` +
      (ahead > fw ? `<rect x="${labelW}" y="${y + 6}" width="${ahead.toFixed(1)}" height="8" rx="4" fill="${reach}" opacity="0.3"/>` : '') +
      `<rect x="${labelW}" y="${y + 6}" width="${Math.max(fw, p.pct > 0 ? 8 : 0).toFixed(1)}" height="8" rx="4" fill="${fill}"/>` +
      `<text x="${w}" y="${y + 14}" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>${p.pct}%</text></g>`
    )
  })
  return svg(w, Math.max(rowH, paces.length * rowH), rows.join(''))
}

/** The rate-limit windows: each fill, when it resets, and a warning when this session's pace fills one before its reset. */
export const limits: Section = (ui, { m, usage, now }) => {
  const paces = usage.rateLimits.map(l => paceOf(l, m.rateStart[l.kind], now))
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
      ui.caption(
        `${p.label}: ${p.resetsInMs !== null ? `resets in ${fmtMs(p.resetsInMs)}` : 'no reset time'}` +
          (p.perHour !== null ? ` · +${p.perHour.toFixed(1)} pts/h` : ' · pace after 10 min'),
      ),
    ),
  ])
}
