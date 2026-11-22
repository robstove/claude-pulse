import { HEX, fmtMs, fmtUsd, svg } from '../charts'
import { PULSE_MS, liveStatus, phase, stillWhenReduced } from './turns'
import type { Section } from './ui'

// The dot's box: room for the ring to grow to 2.4 times the dot.
const DOT_BOX = 18
const DOT_R = 3.5

type State = 'idle' | 'live' | 'stalled'

/** The session state as one dot: green, breathing, and ringed while work runs, amber when a turn stalls, grey when idle.
 * `ms` is how long the work has run, so the motion keeps its phase across redraws. */
const dotSvg = (state: State, ms: number): string => {
  const color = state === 'idle' ? HEX.muted : state === 'stalled' ? HEX.warn : HEX.ok
  const c = DOT_BOX / 2
  const circle = (cls: string) => `<circle${cls ? ` class="${cls}"` : ''} cx="${c}" cy="${c}" r="${DOT_R}" fill="${color}"/>`
  if (state !== 'live') return svg(DOT_BOX, DOT_BOX, circle(''))
  const motion = `${PULSE_MS}ms cubic-bezier(.16,1,.3,1) infinite;${phase(ms)}`
  return svg(
    DOT_BOX,
    DOT_BOX,
    `<style>@keyframes ring{from{transform:scale(1);opacity:.7}to{transform:scale(2.4);opacity:0}}` +
      `@keyframes breathe{0%,100%{opacity:1}50%{opacity:.45}}` +
      `.ring{transform-box:fill-box;transform-origin:center;animation:ring ${motion}}.dot{animation:breathe ${motion}}` +
      // Reduced motion keeps the dot whole and drops the ring.
      `@media (prefers-reduced-motion: reduce){.dot{animation:none}}${stillWhenReduced('.ring')}</style>` +
      `${circle('ring')}${circle('dot')}`,
  )
}

/** The session's cost, its cost per hour of work, Claude's working time, and a dot and a word that tell whether work runs. */
export const header: Section = ({ Box, Text, Svg }, { m, usage, now, live }) => {
  // Working time, as Activity counts it, plus the running turn: a session left open for days spends its idle time on nothing.
  const workMs = m.turnMsTotal + (live?.ms ?? 0)
  // Under a minute of work the rate swings too far to read.
  const perHour = usage.cost && workMs >= 60_000 ? usage.cost.usd / (workMs / 3_600_000) : null
  const status = live === null ? null : liveStatus(live)
  // A background task works on after its turn ends, so between turns the session is still live while one runs.
  const tasks = Object.values(m.tasks)
  const state: State = status !== null ? (status.stalled ? 'stalled' : 'live') : tasks.length > 0 ? 'live' : 'idle'
  const tone = state === 'idle' ? undefined : state === 'stalled' ? 'warning' : 'success'
  const word = state === 'idle' ? 'Idle' : state === 'stalled' ? 'Stalled' : 'Live'
  const ms = live !== null ? live.ms : now - Math.min(now, ...tasks.map(t => t.startedAt))
  const background = `${tasks.length} background task${tasks.length === 1 ? '' : 's'}`
  return (
    <Box flexDirection="column" gap="sm">
      {/* The state row first, so whether work runs is the first thing the pane says. */}
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap="sm">
        <Box flexDirection="row" alignItems="center" columnGap="xs">
          {Svg ? (
            <Svg source={dotSvg(state, ms)} alt={status !== null ? status.now : state === 'live' ? `${background} running` : 'Nothing running'} width={DOT_BOX} height={DOT_BOX} />
          ) : (
            <Text color={tone} dimColor={tone === undefined}>
              ●
            </Text>
          )}
          <Text size="caption" weight="semibold" color={tone} dimColor={tone === undefined}>
            {word}
          </Text>
        </Box>
        {/* What runs: the turn's time, or the background tasks; nothing while idle. */}
        {state !== 'idle' && (
          <Text size="caption" color={tone} tabular>
            {live !== null ? `running ${fmtMs(Math.max(1000, Math.floor(live.ms / 1000) * 1000))}` : background}
          </Text>
        )}
      </Box>
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start">
        <Box flexDirection="column">
          <Text size="title" weight="semibold" tabular>
            {usage.cost ? fmtUsd(usage.cost.usd) : 'n/a'}
          </Text>
          <Text size="caption" dimColor tabular>
            Session cost{perHour !== null ? ` · ${fmtUsd(perHour)}/h worked` : ''}
          </Text>
        </Box>
        {/* The label sits under the number, so the session's work never reads as the turn's time. */}
        <Box flexDirection="column" alignItems="flex-end">
          <Text size="heading" tabular>
            {fmtMs(workMs)}
          </Text>
          <Text size="caption" dimColor>
            Working
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
