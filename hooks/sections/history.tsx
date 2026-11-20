import { HEX, esc, fmtUsd, sparkline, svg } from '../charts'
import { lastDays } from '../ledger'
import type { Section } from './ui'

/** Cost per day, oldest first; today's bar in the accent color. */
const historySvg = (w: number, days: readonly [string, number][], today: string): string => {
  const h = 36
  const slot = w / Math.max(1, days.length)
  const bw = Math.max(4, Math.min(18, slot - 4))
  const max = Math.max(0.01, ...days.map(([, usd]) => usd))
  const bars = days.map(([day, usd], i) => {
    const x = i * slot + (slot - bw) / 2
    const bh = usd > 0 ? Math.max(2, (usd / max) * (h - 2)) : 1
    const fill = usd === 0 ? HEX.track : day === today ? HEX.accent : HEX.cost
    return (
      `<g><title>${esc(`${day}${day === today ? ' (today)' : ''}: ${fmtUsd(usd)}`)}</title>` +
      `<rect x="${(x - 1.5).toFixed(1)}" width="${(bw + 3).toFixed(1)}" height="${h}" fill="transparent"/>` +
      `<rect x="${x.toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5" fill="${fill}"/></g>`
    )
  })
  return svg(w, h, bars.join(''))
}

/** Cost per day for the last 14 days across all sessions, with today and 7-day totals. */
export const history: Section = (ui, { daily, now }) => {
  const days = lastDays(now, 14).map(d => [d, daily[d] ?? 0] as [string, number])
  const total = (n: number) => days.slice(-n).reduce((s, [, usd]) => s + usd, 0)
  if (total(14) === 0) return null
  const today = days[days.length - 1]?.[0] ?? ''
  return ui.section('History', `today ${fmtUsd(total(1))} · 7 days ${fmtUsd(total(7))}`, [
    ui.Svg ? ui.chart(historySvg(ui.px, days, today), 'Cost per day, last 14 days') : <ui.Text color="suggestion">{sparkline(days.map(([, usd]) => usd))}</ui.Text>,
    ui.caption('All sessions, by the day each turn ended. Last 14 days.'),
  ])
}
