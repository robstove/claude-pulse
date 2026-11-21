import type { SessionRateLimit } from 'claude-code'

import type { RateStart } from '../../types'
import { FONT, HEX, THEME, esc, fmtMs, fmtUsd, level, svg } from '../charts'
import { dayKey } from '../ledger'
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
  /** The part of the window gone by now, 0 to 1; null when the window has no reset time or no known length. */
  elapsed: number | null
  /** Where each local day (7-day) or hour (5-hour) starts inside the window, as parts of it. */
  ticks: number[]
  /** When the window started; null with `elapsed`. */
  startAt: number | null
}

const windowLabel = (kind: string): string =>
  kind === 'five_hour' ? '5-hour' : kind === 'seven_day' ? '7-day' : kind === 'spend_limit' ? 'Spend' : kind.replace(/_/g, ' ')

/** The next local day or hour start after `t`, so the ticks fall on the person's own clock. */
const nextTick = (kind: string, t: number): number => {
  const d = new Date(t)
  return kind === 'seven_day'
    ? new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime()
    : new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours() + 1).getTime()
}

/** The window's tick marks as parts of it, and how much of it has gone by. */
const clockOf = (kind: string, resetsInMs: number | null, now: number): { elapsed: number | null; ticks: number[]; startAt: number | null } => {
  const span = WINDOW_MS[kind]
  if (span === undefined || resetsInMs === null) return { elapsed: null, ticks: [], startAt: null }
  const start = now + resetsInMs - span
  const ticks: number[] = []
  for (let t = nextTick(kind, start); t < start + span; t = nextTick(kind, t)) ticks.push((t - start) / span)
  return { elapsed: Math.min(1, Math.max(0, (now - start) / span)), ticks, startAt: start }
}

type DaySpend = { from: number; to: number; day: string; usd: number }

/** The spend of each local day of a 7-day window that has begun, placed between its day ticks. */
const daySpends = (p: Pace, daily: Readonly<Record<string, number>>): DaySpend[] => {
  const span = WINDOW_MS[p.kind]
  if (p.kind !== 'seven_day' || p.startAt === null || p.elapsed === null || span === undefined) return []
  const bounds = [0, ...p.ticks, 1]
  const start = p.startAt
  const elapsed = p.elapsed
  return bounds
    .slice(0, -1)
    .map((from, i) => ({ from, to: bounds[i + 1] ?? 1 }))
    .filter(s => s.from < elapsed)
    .map(s => {
      const day = dayKey(start + ((s.from + s.to) / 2) * span)
      return { ...s, day, usd: daily[day] ?? 0 }
    })
}

/** Points used past (+) or short of (-) an even spread across the window. */
const overEven = (p: Pace): number | null => (p.elapsed !== null ? p.pct - p.elapsed * 100 : null)

const evenText = (p: Pace): string | null => {
  const d = overEven(p)
  if (d === null) return null
  const n = Math.round(Math.abs(d))
  return n === 0 ? 'on even pace' : `${n} pts ${d > 0 ? 'over' : 'under'} even pace`
}

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
    ...clockOf(l.kind, resetsInMs, now),
  }
}

const paceTitle = (p: Pace): string =>
  `${p.label} window: ${p.pct}% used` +
  (p.resetsInMs !== null ? `, resets in ${fmtMs(p.resetsInMs)}` : '') +
  (p.perHour !== null ? `, +${p.perHour.toFixed(1)} points an hour this session` : ', pace shows after 10 minutes') +
  (p.atResetPct !== null ? `, about ${Math.round(Math.min(p.atResetPct, 999))}% at reset if it holds` : '') +
  (p.elapsed !== null ? `, ${Math.round(p.elapsed * 100)}% of the window gone, ${evenText(p)}` : '')

/** Whole dollars from $10, so the window's total fits the percent column beside the bars. */
const fmtTotal = (usd: number): string => (usd >= 10 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`)

/** Each day's spend on this machine as a column under its stretch of the 7-day bar, scaled to the largest day, with the total. */
const spendRow = (days: readonly DaySpend[], y: number, w: number, labelW: number, barW: number, h: number): string => {
  const max = Math.max(...days.map(d => d.usd))
  const total = days.reduce((s, d) => s + d.usd, 0)
  const text = (x: number, anchor: string, body: string) =>
    `<text x="${x}" y="${y + h - 3}" text-anchor="${anchor}" fill="${HEX.muted}" font-size="10" font-variant-numeric="tabular-nums" ${FONT}>${body}</text>`
  const label =
    `<g><title>${esc(`${fmtUsd(total)} spent in this 7-day window by the sessions on this computer`)}</title>` +
    text(0, 'start', 'Spend') +
    text(w, 'end', esc(fmtTotal(total))) +
    '</g>'
  return label + days
    .filter(d => d.usd > 0)
    .map(d => {
      const x = labelW + d.from * barW + 1
      const cw = Math.max(1, (d.to - d.from) * barW - 2)
      const ch = Math.max(2, (d.usd / max) * (h - 4))
      return (
        `<g><title>${esc(`${d.day}: ${fmtUsd(d.usd)} spent by the sessions on this computer`)}</title>` +
        `<rect x="${x.toFixed(1)}" y="${y}" width="${cw.toFixed(1)}" height="${h}" fill="transparent"/>` +
        `<rect x="${x.toFixed(1)}" y="${(y + h - 2 - ch).toFixed(1)}" width="${cw.toFixed(1)}" height="${ch.toFixed(1)}" rx="1" fill="${HEX.cost}" opacity="0.7"/></g>`
      )
    })
    .join('')
}

const ROW_H = 20

/** One window's bar: the fill, the pace line to where the window reaches by its reset, the day or hour ticks, now, and the percent. */
const limitRow = (p: Pace, y: number, w: number, labelW: number, barW: number): string => {
  const fill = HEX[level(p.pct)]
  const fw = (Math.min(100, p.pct) / 100) * barW
  const ahead = p.atResetPct !== null ? (Math.min(100, p.atResetPct) / 100) * barW : fw
  const reach = p.atResetPct !== null && p.atResetPct >= 100 ? HEX.bad : fill
  return (
    `<g><title>${esc(paceTitle(p))}</title><rect y="${y}" width="${w}" height="${ROW_H}" fill="transparent"/>` +
    `<text x="0" y="${y + 14}" fill="${HEX.muted}" font-size="11" ${FONT}>${esc(p.label)}</text>` +
    `<rect x="${labelW}" y="${y + 6}" width="${barW}" height="8" rx="4" fill="${HEX.track}"/>` +
    // The projection is a thin line from the fill's end, so it never reads as used capacity; the fill drawn after covers its start.
    (ahead > fw
      ? `<rect x="${(labelW + fw - 4).toFixed(1)}" y="${y + 9}" width="${(ahead - fw + 4).toFixed(1)}" height="2" rx="1" fill="${reach}" opacity="0.85"/>`
      : '') +
    `<rect x="${labelW}" y="${y + 6}" width="${Math.max(fw, p.pct > 0 ? 8 : 0).toFixed(1)}" height="8" rx="4" fill="${fill}"/>` +
    p.ticks.map(t => `<rect x="${(labelW + t * barW - 0.5).toFixed(1)}" y="${y + 4}" width="1" height="12" fill="${HEX.rule}"/>`).join('') +
    (p.elapsed !== null
      ? `<rect x="${(labelW + p.elapsed * barW - 1).toFixed(1)}" y="${y + 2}" width="2" height="16" rx="1" fill="${HEX.accent}"/>`
      : '') +
    `<text x="${w}" y="${y + 14}" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>${p.pct}%</text></g>`
  )
}

/** One row per window: the fill in its level color, a thin line to where the pace reaches by the reset, a tick at each
 * day or hour start, and a marker at now: a fill past the marker uses the window faster than an even spread. */
const limitsSvg = (w: number, paces: readonly Pace[], daily: Readonly<Record<string, number>>): string => {
  const spendH = 14
  const labelW = 56
  const statW = 40
  const barW = w - labelW - statW - 8
  let y = 0
  const rows = paces.map(p => {
    const top = y
    const days = daySpends(p, daily)
    const hasSpend = days.some(d => d.usd > 0)
    y += ROW_H + (hasSpend ? spendH : 0)
    return limitRow(p, top, w, labelW, barW) + (hasSpend ? spendRow(days, top + ROW_H, w, labelW, barW, spendH) : '')
  })
  return svg(w, Math.max(ROW_H, y), rows.join(''))
}

/** A terminal row under a bar: a tick at each day or hour start and a caret at now, or null with neither. */
const termMarks = (p: Pace, width: number): string | null => {
  if (p.elapsed === null) return null
  const cells = Array.from({ length: width }, () => ' ')
  for (const t of p.ticks) cells[Math.min(width - 1, Math.floor(t * width))] = '╵'
  cells[Math.min(width - 1, Math.floor(p.elapsed * width))] = '▲'
  return ' '.repeat(LABEL) + cells.join('').trimEnd()
}

/** The rate-limit windows: each fill, when it resets, and a warning when this session's pace fills one before its reset. */
export const limits: Section = (ui, { m, usage, now, daily }) => {
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
      ui.chart(limitsSvg(ui.px, paces, daily), `Rate limits: ${paces.map(p => `${p.label} ${p.pct}%`).join(', ')}`)
    ) : (
      <ui.Box flexDirection="column">
        {paces.map(p => {
          // The label and the bar together fill `cells`, so the row does not wrap.
          const width = Math.max(LABEL, ui.cells - LABEL)
          const marks = termMarks(p, width)
          return (
            <ui.Box flexDirection="column">
              <Text>
                <Text dimColor>{p.label.slice(0, LABEL - 1).padEnd(LABEL)}</Text>
                {ui.termBar(p.pct / 100, THEME[level(p.pct)], width)}
              </Text>
              {marks !== null && <Text dimColor>{marks}</Text>}
            </ui.Box>
          )
        })}
      </ui.Box>
    ),
    <ui.Box flexDirection="column">
      {paces.map(p =>
        ui.caption(
          `${p.label}: ${p.resetsInMs !== null ? `resets in ${fmtMs(p.resetsInMs)}` : 'no reset time'}` +
            (p.perHour !== null ? ` · +${p.perHour.toFixed(1)} pts/h` : ' · pace after 10 min') +
            (p.elapsed !== null ? ` · ${evenText(p)}` : ''),
        ),
      )}
    </ui.Box>,
  ])
}
