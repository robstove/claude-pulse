import type { Compaction, TurnRecord } from '../types'
import { HEX, fmtMs, fmtUsd, level } from './charts'
import type { Pace } from './derive'

const FONT = 'font-family="system-ui,-apple-system,Segoe UI,sans-serif"'

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

export const paceTitle = (p: Pace): string =>
  `${p.label} window: ${p.pct}% used` +
  (p.resetsInMs !== null ? `, resets in ${fmtMs(p.resetsInMs)}` : '') +
  (p.perHour !== null ? `, +${p.perHour.toFixed(1)} points an hour this session` : ', pace shows after 10 minutes') +
  (p.atResetPct !== null ? `, about ${Math.round(Math.min(p.atResetPct, 999))}% at reset if it holds` : '')

/** One row per window: the fill in its level color, and a faint extension to where the pace reaches by the reset. */
export const limitsSvg = (w: number, paces: readonly Pace[]): string => {
  const rowH = 20
  const labelW = 56
  const statW = 40
  const barW = w - labelW - statW - 8
  const rows = paces.map((p, i) => {
    const y = i * rowH
    const fill = HEX[level(p.pct, 60, 80)]
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

/** Context fill after each turn on the turns chart's columns, with guides at 60% and 80% and a purple rule where a compaction ran. */
export const contextSvg = (w: number, turns: readonly TurnRecord[], firstTurn: number, compactions: readonly Compaction[], hasLive: boolean): string => {
  const gutter = 34
  const h = 30
  const slots = turns.length + (hasLive ? 1 : 0)
  const slot = (w - gutter) / Math.max(slots, 16)
  const cx = (i: number) => w - (slots - i) * slot + slot / 2
  const y = (pct: number) => h - 2 - (Math.min(100, pct) / 100) * (h - 4)
  const guide = (pct: number) =>
    `<line x1="${gutter}" x2="${w}" y1="${y(pct).toFixed(1)}" y2="${y(pct).toFixed(1)}" stroke="${HEX.rule}" stroke-dasharray="2 3"/>`
  const pts = turns.map((t, i) => (t.contextPct === null ? null : `${cx(i).toFixed(1)},${y(t.contextPct).toFixed(1)}`)).filter(p => p !== null)
  const dots = turns.map((t, i) =>
    t.contextPct === null
      ? ''
      : `<g><title>${esc(`Turn ${firstTurn + i}: context ${t.contextPct}%`)}</title>` +
        `<circle cx="${cx(i).toFixed(1)}" cy="${y(t.contextPct).toFixed(1)}" r="5" fill="transparent"/>` +
        `<circle cx="${cx(i).toFixed(1)}" cy="${y(t.contextPct).toFixed(1)}" r="1.8" fill="${HEX[level(t.contextPct, 60, 80)]}"/></g>`,
  )
  // A compaction after turn N draws between turn N and turn N + 1.
  const marks = compactions
    .filter(c => c.turn + 1 >= firstTurn && c.turn + 1 - firstTurn <= slots)
    .map(c => {
      const x = cx(c.turn + 1 - firstTurn) - slot / 2
      const tokens = c.tokensBefore !== undefined && c.tokensAfter !== undefined ? `, ${Math.round(c.tokensBefore / 1000)}k to ${Math.round(c.tokensAfter / 1000)}k tokens` : ''
      return (
        `<g><title>${esc(`Compaction (${c.trigger}) after turn ${c.turn}${tokens}`)}</title>` +
        `<rect x="${(x - 3).toFixed(1)}" width="6" height="${h}" fill="transparent"/>` +
        `<line x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="0" y2="${h}" stroke="${HEX.cost}" stroke-width="1.5" stroke-dasharray="3 2"/></g>`
      )
    })
  return svg(
    w,
    h,
    `<text x="0" y="${h - 2}" fill="${HEX.muted}" font-size="10" ${FONT}>Fill</text>` +
      guide(60) +
      guide(80) +
      marks.join('') +
      (pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${HEX.accent}" stroke-width="1.5" stroke-linejoin="round"/>` : '') +
      dots.join(''),
  )
}

/** Cost per day, oldest first; today's bar in the accent color. */
export const historySvg = (w: number, days: readonly [string, number][], today: string): string => {
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
