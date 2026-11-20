import type { ModelStat } from '../../types'
import { FONT, HEX, esc, fmtMs, fmtNum, plural, svg } from '../charts'
import type { Section } from './ui'

/** `claude-opus-5-5` reads as `opus-5-5`; the hover title keeps the full id. */
export const modelLabel = (id: string): string => id.replace(/^claude-/, '')

/** One row per model: its tokens as a bar split like the token mix, sized against the busiest model. */
const modelsSvg = (w: number, models: readonly [string, ModelStat][]): string => {
  const rowH = 20
  const labelW = Math.min(132, Math.round(w * 0.32))
  const statW = 92
  const barW = w - labelW - statW - 8
  const total = (s: ModelStat) => s.cacheReadTokens + s.cacheWriteTokens + s.inputTokens + s.outputTokens
  const max = Math.max(1, ...models.map(([, s]) => total(s)))
  const rows = models.map(([id, s], i) => {
    const y = i * rowH
    const bw = Math.max(3, (total(s) / max) * barW)
    let x = labelW
    const segs = (
      [
        [s.cacheReadTokens, HEX.cacheRead],
        [s.cacheWriteTokens, HEX.cacheWrite],
        [s.inputTokens, HEX.input],
        [s.outputTokens, HEX.output],
      ] as const
    )
      .filter(([v]) => v > 0)
      .map(([v, color]) => {
        const sw = (v / Math.max(1, total(s))) * bw
        const r = `<rect x="${x.toFixed(1)}" y="${y + 6}" width="${Math.max(sw, 1.5).toFixed(1)}" height="8" fill="${color}"/>`
        x += sw
        return r
      })
    const avg = s.mainTurns > 0 ? `, avg ${fmtMs(s.ms / s.mainTurns)} per main turn` : ''
    const title =
      `${id}: ${s.turns} turns${avg}, ${fmtNum(s.inputTokens)} input, ${fmtNum(s.outputTokens)} output, ` +
      `${fmtNum(s.cacheReadTokens)} cache read, ${fmtNum(s.cacheWriteTokens)} cache write`
    return (
      `<g><title>${esc(title)}</title><rect y="${y}" width="${w}" height="${rowH}" fill="transparent"/>` +
      `<text x="0" y="${y + 14}" fill="${HEX.muted}" font-size="11" ${FONT}>${esc(modelLabel(id))}</text>` +
      `<clipPath id="m${i}"><rect x="${labelW}" y="${y + 6}" width="${bw.toFixed(1)}" height="8" rx="4"/></clipPath>` +
      `<rect x="${labelW}" y="${y + 6}" width="${barW}" height="8" rx="4" fill="${HEX.track}"/>` +
      `<g clip-path="url(#m${i})">${segs.join('')}</g>` +
      `<text x="${w}" y="${y + 14}" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>` +
      `${plural(s.turns, 'turn')} · ${esc(fmtNum(s.outputTokens))} out</text></g>`
    )
  })
  return svg(w, Math.max(rowH, models.length * rowH), rows.join(''))
}

/** Turns, average time, and tokens for each model. */
export const models: Section = (ui, { m }) => {
  const list = Object.entries(m.models).sort((a, b) => b[1].outputTokens - a[1].outputTokens)
  if (list.length === 0) return null
  const { Text } = ui
  return ui.section(
    'Models',
    plural(list.length, 'model'),
    ui.Svg
      ? [ui.chart(modelsSvg(ui.px, list), `Tokens per model, ${list.length} models`)]
      : list.map(([id, s]) => (
          <Text>
            <Text dimColor>{modelLabel(id).slice(0, 13).padEnd(14)}</Text>
            <Text tabular>
              {plural(s.turns, 'turn')} · {fmtNum(s.outputTokens)} out
              {s.mainTurns > 0 ? ` · avg ${fmtMs(s.ms / s.mainTurns)}` : ''}
            </Text>
          </Text>
        )),
  )
}
