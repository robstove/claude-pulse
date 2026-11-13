import type { ModelStat, ToolStat, TurnRecord } from '../types'

// Mid-tone colors, because an Svg cannot read the theme and must read on dark and light.
export const HEX = {
  ok: '#3fb950',
  warn: '#d29922',
  bad: '#f85149',
  accent: '#58a6ff',
  cost: '#a371f7',
  cacheRead: '#39c5cf',
  cacheWrite: '#a371f7',
  input: '#58a6ff',
  output: '#f0883e',
  muted: '#8b949e',
  track: 'rgba(139,148,158,0.18)',
  rule: 'rgba(139,148,158,0.35)',
} as const

const FONT = 'font-family="system-ui,-apple-system,Segoe UI,sans-serif"'

export const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n)}`

export const fmtMs = (ms: number): string => {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1_000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

export const fmtUsd = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`)

export const level = (value: number, warnAt: number, badAt: number): 'ok' | 'warn' | 'bad' =>
  value >= badAt ? 'bad' : value >= warnAt ? 'warn' : 'ok'

/** `mcp__server__tool` reads as `tool`, so two tools of one server do not truncate to the same label. */
export const toolLabel = (name: string): string => {
  const parts = name.split('__')
  return parts.length >= 3 && parts[0] === 'mcp' ? parts.slice(2).join('__') : name
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** The height the markup declares, so an interactive frame is not left at its 150px default. */
export const heightOf = (source: string): number => Number(/height="(\d+)"/.exec(source)?.[1] ?? 0)

/** A thin gauge filled to `pct` in its status color, with ticks at the warn and bad thresholds. */
export const gaugeSvg = (w: number, pct: number): string => {
  const h = 8
  const fill = HEX[level(pct, 60, 80)]
  const fw = (Math.max(0, Math.min(100, pct)) * w) / 100
  const ticks = [60, 80].map(t => `<rect x="${((t * w) / 100).toFixed(1)}" width="1" height="${h}" fill="${HEX.rule}"/>`)
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${HEX.track}"/>` +
      `<rect width="${Math.max(fw, pct > 0 ? h : 0).toFixed(1)}" height="${h}" rx="${h / 2}" fill="${fill}"/>` +
      ticks.join(''),
  )
}

/** One bar split by share, with a hover title on each part. */
export const stackSvg = (w: number, parts: { value: number; color: string; label: string }[]): string => {
  const h = 8
  const total = parts.reduce((s, p) => s + p.value, 0)
  let x = 0
  const segs = parts
    .filter(p => p.value > 0)
    .map(p => {
      const sw = (p.value / total) * w
      const pct = (p.value / total) * 100
      const r =
        `<rect x="${x.toFixed(1)}" width="${Math.max(sw, 1.5).toFixed(1)}" height="${h}" fill="${p.color}">` +
        `<title>${esc(`${p.label}: ${fmtNum(p.value)} (${pct < 1 ? '<1' : Math.round(pct)}%)`)}</title></rect>`
      x += sw
      return r
    })
  return svg(
    w,
    h,
    `<clipPath id="c"><rect width="${w}" height="${h}" rx="${h / 2}"/></clipPath>` +
      `<rect width="${w}" height="${h}" rx="${h / 2}" fill="${HEX.track}"/><g clip-path="url(#c)">${segs.join('')}</g>`,
  )
}

/** Turn time over cost per turn on one x-axis, newest at the right; a turn of unknown cost draws a stub to keep the column. */
export type LiveTurn = { ms: number; toolCalls: number }

export const turnsSvg = (w: number, done: TurnRecord[], firstTurn: number, live: LiveTurn | null = null): string => {
  // The running turn draws as one more column, faded, with no cost yet.
  const turns: TurnRecord[] = live
    ? [...done, { ms: live.ms, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null, toolCalls: live.toolCalls, isAborted: false }]
    : done
  const gutter = 34
  const timeH = 40
  const costH = 16
  const gap = 8
  const h = timeH + gap + costH
  const label = (y: number, text: string) =>
    `<text x="0" y="${y}" fill="${HEX.muted}" font-size="10" ${FONT}>${text}</text>`
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

/** One row per tool: total time as the bar, the error share as a red tail, count and time at the right. */
export const toolsSvg = (w: number, tools: [string, ToolStat][]): string => {
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
    const title = `${name}: ${s.count} calls, ${s.errors} errors, ${fmtMs(s.ms)} total, ${fmtMs(s.ms / s.count)} average`
    return (
      `<g><title>${esc(title)}</title><rect y="${y}" width="${w}" height="${rowH}" fill="transparent"/>` +
      `<text x="0" y="${y + 14}" fill="${HEX.muted}" font-size="11" ${FONT}>${esc(short)}</text>` +
      `<rect x="${labelW}" y="${y + 6}" width="${barW}" height="8" rx="4" fill="${HEX.track}"/>` +
      `<rect x="${labelW}" y="${y + 6}" width="${bw.toFixed(1)}" height="8" rx="4" fill="${HEX.accent}"/>` +
      (errW > 0
        ? `<rect x="${(labelW + bw - errW).toFixed(1)}" y="${y + 6}" width="${Math.max(errW, 3).toFixed(1)}" height="8" rx="4" fill="${HEX.bad}"/>`
        : '') +
      `<text x="${w}" y="${y + 14}" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>` +
      `${s.count}× ${esc(fmtMs(s.ms))}</text></g>`
    )
  })
  return svg(w, Math.max(rowH, tools.length * rowH), rows.join(''))
}

/** `claude-opus-5-5` reads as `opus-5-5`; the hover title keeps the full id. */
export const modelLabel = (id: string): string => id.replace(/^claude-/, '')

/** One row per model: its tokens as a bar split like the token mix, sized against the busiest model. */
export const modelsSvg = (w: number, models: [string, ModelStat][]): string => {
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
      `${s.turns} ${s.turns === 1 ? 'turn' : 'turns'} · ${esc(fmtNum(s.outputTokens))} out</text></g>`
    )
  })
  return svg(w, Math.max(rowH, models.length * rowH), rows.join(''))
}

// Terminal fallbacks: block characters in colored Text.
const SPARK = '▁▂▃▄▅▆▇█'

export const sparkline = (vals: number[]): string => {
  const max = Math.max(0, ...vals)
  return vals.map(v => (max === 0 ? SPARK[0] : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}

export const blockBar = (frac: number, width: number): [string, string] => {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width)
  return ['█'.repeat(n), '░'.repeat(width - n)]
}
