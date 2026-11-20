import type { Compaction, TurnRecord } from '../../types'
import { FONT, HEX, THEME, esc, fmtNum, level, svg } from '../charts'
import { levels } from '../state'
import type { Section } from './ui'

/** A thin gauge filled to `pct` in its status color, with ticks at the warn and bad thresholds. */
const gaugeSvg = (w: number, pct: number): string => {
  const h = 8
  const fill = HEX[level(pct)]
  const fw = (Math.max(0, Math.min(100, pct)) * w) / 100
  const ticks = [levels.warnAt, levels.alertAt].map(t => `<rect x="${((t * w) / 100).toFixed(1)}" width="1" height="${h}" fill="${HEX.rule}"/>`)
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${HEX.track}"/>` +
      `<rect width="${Math.max(fw, pct > 0 ? h : 0).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
      ticks.join(''),
  )
}

/** Context fill after each turn on the turns chart's columns, with guides at the amber and red levels and a purple rule where a compaction ran. */
const contextSvg = (w: number, turns: readonly TurnRecord[], firstTurn: number, compactions: readonly Compaction[], hasLive: boolean): string => {
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
        `<circle cx="${cx(i).toFixed(1)}" cy="${y(t.contextPct).toFixed(1)}" r="1.8" fill="${HEX[level(t.contextPct)]}"/></g>`,
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
      guide(levels.warnAt) +
      guide(levels.alertAt) +
      marks.join('') +
      (pts.length > 1 ? `<polyline points="${pts.join(' ')}" fill="none" stroke="${HEX.accent}" stroke-width="1.5" stroke-linejoin="round"/>` : '') +
      dots.join(''),
  )
}

/** The context fill as a gauge, and its fill after each turn with the compactions marked. */
export const context: Section = (ui, { m, usage, live }) => {
  const { Text } = ui
  // Unknown until the first response of a fresh or just-compacted window: drawn as '-' with an empty meter, not as a safe 0%.
  const known = usage.context.percent
  const pct = known ?? 0
  const lvl = level(pct)
  const firstTurn = m.mainTurns - m.turns.length + 1
  return ui.section(
    'Context',
    <Text size="caption" tabular>
      <Text dimColor>
        {m.compactions.length > 0 ? `${m.compactions.length} compacted · ` : ''}
        {usage.context.tokens !== undefined ? fmtNum(usage.context.tokens) : '-'} / {fmtNum(usage.context.window)}
        {'  '}
      </Text>
      <Text weight="semibold" color={known === undefined || lvl === 'ok' ? undefined : THEME[lvl]}>
        {known === undefined ? '-' : `${pct}%`}
      </Text>
    </Text>,
    [
      ui.Svg
        ? ui.chart(gaugeSvg(ui.px, pct), known === undefined ? 'Context fill not known yet' : `Context ${pct}% full`, false)
        : ui.termBar(pct / 100, known === undefined ? 'suggestion' : THEME[lvl]),
      ui.Svg && m.turns.some(t => t.contextPct !== null)
        ? ui.chart(contextSvg(ui.px, m.turns, firstTurn, m.compactions, live !== null), 'Context fill per turn')
        : null,
    ],
  )
}
