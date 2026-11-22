import { levels } from './state'

// The helpers every pane section and the prompt hint share; each section's own chart lives in its file under sections/.

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

/** The theme color a meter level takes on a surface that draws Text. */
export const THEME = { ok: 'success', warn: 'warning', bad: 'error' } as const

export const FONT = 'font-family="system-ui,-apple-system,Segoe UI,sans-serif"'

/** The width of the widest of `texts` at 11px, at 0.6em a character (a tabular digit's width), so a column holds its longest entry. */
export const textW = (texts: readonly string[], fontPx = 11): number => Math.ceil(Math.max(0, ...texts.map(t => t.length)) * fontPx * 0.6)

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const fmtNum = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : `${Math.round(n)}`

export const fmtMs = (ms: number): string => {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1_000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  // Past two days the hours read better as days, as a reset or an elapsed week does.
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

export const fmtUsd = (usd: number): string => (usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`)

export const level = (value: number): 'ok' | 'warn' | 'bad' => (value >= levels.alertAt ? 'bad' : value >= levels.warnAt ? 'warn' : 'ok')

export const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const svg = (w: number, h: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

/** One bar split by share, with a hover title on each part. */
export const stackSvg = (w: number, parts: readonly { value: number; color: string; label: string }[]): string => {
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

// Terminal fallbacks: block characters in colored Text.
const SPARK = '▁▂▃▄▅▆▇█'

export const sparkline = (vals: readonly number[]): string => {
  const max = Math.max(0, ...vals)
  return vals.map(v => (max === 0 ? SPARK[0] : SPARK[Math.min(7, Math.floor((v / max) * 7.999))])).join('')
}

export const blockBar = (frac: number, width: number): [string, string] => {
  const n = Math.round(Math.max(0, Math.min(1, frac)) * width)
  return ['█'.repeat(n), '░'.repeat(width - n)]
}
