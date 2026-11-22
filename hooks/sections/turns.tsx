import type { Metrics, TurnRecord } from '../../types'
import { FONT, HEX, esc, fmtMs, fmtNum, fmtUsd, plural, sparkline, svg } from '../charts'
import type { LiveStep, LiveTurn, Section, Ui } from './ui'

/** Turn time over cost per turn on one x-axis, newest at the right; a turn of unknown cost draws a stub to keep the column. */
const turnsSvg = (w: number, done: readonly TurnRecord[], firstTurn: number, live: LiveTurn | null): string => {
  // The running turn draws as one more column, faded, with no cost yet.
  const turns: readonly TurnRecord[] = live
    ? [...done, { ms: live.ms, inputTokens: 0, outputTokens: 0, costUsd: null, contextPct: null, toolCalls: live.toolCalls, isAborted: false, reason: '' }]
    : done
  const gutter = 34
  const timeH = 40
  const costH = 16
  const gap = 8
  const h = timeH + gap + costH
  const label = (y: number, text: string) => `<text x="0" y="${y}" fill="${HEX.muted}" font-size="10" ${FONT}>${text}</text>`
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

/** One line on model requests: per turn, first-token time, stream speed, effort, server tools, and cut-off replies. */
const requestsLine = (ui: Ui, m: Metrics) => {
  const s = m.steps
  if (s.count === 0) return null
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
      {ui.caption(bits.join(' · '))}
      {cut > 0 && ui.caption(`${plural(cut, 'reply', 'replies')} hit the output token limit`, 'warning')}
    </ui.Box>
  )
}

// A turn quiet this long shows its quiet time; it turns amber past the stallMinutes option.
const QUIET_SHOW_MS = 30_000

// One sweep of the shimmer over the running step. Its phase comes from the turn's time, so the redraw each tick does not restart it.
export const PULSE_MS = 1600
const STEP_COLOR = { request: HEX.accent, tool: HEX.muted, compact: HEX.cost } as const

const wholeSeconds = (ms: number): string => fmtMs(Math.max(1000, Math.floor(ms / 1000) * 1000))

/** What the running turn does now: its newest open step and how long it has run, or how long it went quiet past the limit. */
export const liveStatus = (live: LiveTurn): { open: LiveStep | undefined; stalled: boolean; now: string; counts: string } => {
  const open = live.steps.filter(s => s.toMs === null).at(-1)
  // A call put to a permission decision may wait on the person or run once decided, and in auto mode nearly every call that
  // writes is put to the classifier: it shows as running, and never as a stall, since its wait may be the person's.
  const waiting = open?.waits === true
  const stalled = !waiting && live.stallMs > 0 && live.quietMs >= live.stallMs
  const what = open === undefined ? 'Working' : `${open.name}${open.detail !== '' ? ` · ${open.detail.length > 40 ? `${open.detail.slice(0, 39)}…` : open.detail}` : ''}`
  const since = open === undefined ? Math.max(0, ...live.steps.map(s => s.toMs ?? 0)) : open.fromMs
  const quiet = !waiting && live.quietMs >= QUIET_SHOW_MS ? ` · quiet ${wholeSeconds(live.quietMs)}` : ''
  const now = stalled ? `${what} · quiet ${wholeSeconds(live.quietMs)}` : `${what} · running ${wholeSeconds(live.ms - since)}${quiet}`
  const requests = live.steps.filter(s => s.kind === 'request').length
  const calls = live.steps.filter(s => s.kind === 'tool').length
  return { open, stalled, now, counts: `${plural(requests, 'request')} · ${plural(calls, 'call')}` }
}

// The running turn on its own time axis: requests blue, tool calls grey, compactions purple. The open step is green with a
// shimmer and a pulsing dot; past the stall limit it is amber and still, so motion means work.
// Between turns (`idleText` given) it shows the last turn's steps faded under a grey still dot, in the same space, so nothing below moves.
export const stripSvg = (w: number, live: LiveTurn, idleText?: string): string => {
  const idle = idleText !== undefined
  const status = liveStatus(live)
  const { open, stalled, counts } = status
  const now = idleText ?? status.now
  const still = idle || stalled
  const total = Math.max(1, live.ms)
  const h = 38
  const x = (ms: number) => (Math.min(ms, total) / total) * w
  const phase = `animation-delay:-${Math.round(live.ms % PULSE_MS)}ms`
  // Running is green, the pane's healthy colour: an orange step read as a failure beside the red of failed calls.
  const color = idle ? HEX.muted : stalled ? HEX.warn : HEX.ok
  const closed = live.steps
    .filter(s => s !== open)
    .map(s => {
      const x0 = x(s.fromMs)
      const width = Math.max(2, x(s.toMs ?? total) - x0 - 1)
      const fill = s.toMs === null ? color : STEP_COLOR[s.kind]
      return `<rect x="${x0.toFixed(1)}" y="3" width="${width.toFixed(1)}" height="8" rx="2" fill="${fill}"${idle ? ' opacity="0.45"' : ''}/>`
    })
  let current = ''
  if (open !== undefined) {
    const x0 = x(open.fromMs)
    const ow = Math.max(4, w - x0)
    const gw = Math.max(16, ow * 0.45)
    current =
      `<clipPath id="now"><rect x="${x0.toFixed(1)}" y="0" width="${ow.toFixed(1)}" height="14" rx="3"/></clipPath>` +
      `<rect x="${x0.toFixed(1)}" y="0" width="${ow.toFixed(1)}" height="14" rx="3" fill="${color}"/>` +
      (still
        ? ''
        : `<style>@keyframes sweep{from{transform:translateX(-${gw.toFixed(0)}px)}to{transform:translateX(${ow.toFixed(0)}px)}}` +
          `.sweep{animation:sweep ${PULSE_MS}ms cubic-bezier(.65,0,.35,1) infinite;${phase}}</style>` +
          `<g clip-path="url(#now)"><rect class="sweep" x="${x0.toFixed(1)}" y="0" width="${gw.toFixed(1)}" height="14" fill="url(#shine)"/></g>`)
  }
  const dot = still
    ? `<circle cx="4" cy="28" r="4" fill="${color}"/>`
    : `<style>@keyframes ring{from{transform:scale(1);opacity:.6}to{transform:scale(2.6);opacity:0}}` +
      `.ring{transform-box:fill-box;transform-origin:center;animation:ring ${PULSE_MS}ms cubic-bezier(.16,1,.3,1) infinite;${phase}}` +
      `@media (prefers-reduced-motion: reduce){.ring,.sweep{animation:none;opacity:0}}</style>` +
      `<circle class="ring" cx="4" cy="28" r="4" fill="${color}"/><circle cx="4" cy="28" r="4" fill="${color}"/>`
  return svg(
    w,
    h,
    `<defs><linearGradient id="shine"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".5" stop-color="#fff" stop-opacity=".55"/>` +
      `<stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient></defs>` +
      `<rect width="${w}" height="14" rx="3" fill="${HEX.track}"/>` +
      // The open step first: a step that ended while it ran draws over it.
      current +
      closed.join('') +
      dot +
      `<text x="14" y="32" fill="${color}" font-size="11" font-weight="600" ${FONT}>${esc(now)}</text>` +
      (live.steps.length > 0 || !idle
        ? `<text x="${w}" y="32" text-anchor="end" fill="${HEX.muted}" font-size="11" font-variant-numeric="tabular-nums" ${FONT}>${esc(counts)}</text>`
        : ''),
  )
}

/** The running turn's strip, or between turns the last one's, still; a line where the surface draws no charts. */
const liveStrip = (ui: Ui, live: LiveTurn | null, last: { ms: number; steps: LiveStep[] } | null, m: Metrics) => {
  if (live === null) {
    const past: LiveTurn = { ms: last?.ms ?? 0, toolCalls: 0, steps: last?.steps ?? [], quietMs: 0, stallMs: 0 }
    // The turn's own duration, as the hint and the header show it, not the hook's clock readings; its cost when it is known.
    const cost = m.turns.at(-1)?.costUsd ?? null
    const idle = past.steps.length > 0 ? `Idle · last turn ${fmtMs(m.lastTurnMs)}${cost !== null ? ` · ${fmtUsd(cost)}` : ''}` : 'Idle'
    const line = past.steps.length > 0 ? `${idle} · ${liveStatus(past).counts}` : idle
    return ui.Svg ? ui.chart(stripSvg(ui.px, past, idle), line) : ui.caption(line)
  }
  if (ui.Svg) return ui.chart(stripSvg(ui.px, live), `Running turn: ${liveStatus(live).now}`)
  const { stalled, now, counts } = liveStatus(live)
  return ui.caption(`${now} · ${counts}`, stalled ? 'warning' : undefined)
}

/** Main turns that did not end with an answer, in red; nothing when every turn answered. */
const endsLine = (ui: Ui, m: Metrics) => {
  const r = m.endReasons
  const bits = [r.aborted ? `${r.aborted} interrupted` : null, r.error ? plural(r.error, 'API error') : null, r.refusal ? `${r.refusal} refused` : null].filter(
    b => b !== null,
  )
  return bits.length > 0 ? ui.caption(bits.join(' · '), 'error') : null
}

/** Time and cost per turn, the running turn, model requests, and the turns that did not answer. */
export const turns: Section = (ui, { m, live, lastTurn }) => {
  const { Text } = ui
  const avgMs = m.mainTurns > 0 ? m.turnMsTotal / m.mainTurns : 0
  const costPending = m.turns.length > 0 && m.turns.every(t => t.costUsd === null)
  const firstTurn = m.mainTurns - m.turns.length + 1
  return ui.section(
    'Turns',
    // The pane's header shows the running time beside its dot, so this line keeps the summary at all times.
    m.mainTurns === 0
      ? 'none yet'
      : `${plural(m.mainTurns, 'turn')}${m.agentTurns > 0 ? ` + ${m.agentTurns} subagent` : ''} · avg ${fmtMs(avgMs)} · max ${fmtMs(m.longestTurnMs)}`,
    [
      liveStrip(ui, live, lastTurn, m),
      ui.Svg ? (
        ui.chart(turnsSvg(ui.px, m.turns, firstTurn, live), `Turn time and cost, last ${fmtMs(m.lastTurnMs)}`)
      ) : (
        <Text color="suggestion">{sparkline([...m.turns.map(t => t.ms), ...(live ? [live.ms] : [])].slice(-ui.cells)) || 'No turns yet'}</Text>
      ),
      costPending && ui.caption('Cost per turn shows from the next turn.'),
      requestsLine(ui, m),
      endsLine(ui, m),
    ],
  )
}
