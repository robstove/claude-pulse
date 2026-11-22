import { HEX, fmtMs, fmtUsd, svg } from '../charts'
import { PULSE_MS, liveStatus } from './turns'
import type { LiveTurn, Section } from './ui'

// The dot's box: room for the ring to grow to twice the dot.
const DOT_BOX = 12

/** The turn state as one dot: green and pulsing while it runs, amber when it stalls, grey when it waits or between turns. */
const dotSvg = (live: LiveTurn | null): string => {
  const status = live === null ? null : liveStatus(live)
  const color = status === null || status.waiting ? HEX.muted : status.stalled ? HEX.warn : HEX.ok
  const c = DOT_BOX / 2
  const dot = `<circle cx="${c}" cy="${c}" r="3" fill="${color}"/>`
  if (live === null || status === null || status.waiting || status.stalled) return svg(DOT_BOX, DOT_BOX, dot)
  // The phase comes from the turn's time, so the redraw each second does not restart the ring.
  return svg(
    DOT_BOX,
    DOT_BOX,
    `<style>@keyframes ring{from{transform:scale(1);opacity:.6}to{transform:scale(2);opacity:0}}` +
      `.ring{transform-box:fill-box;transform-origin:center;animation:ring ${PULSE_MS}ms cubic-bezier(.16,1,.3,1) infinite;` +
      `animation-delay:-${Math.round(live.ms % PULSE_MS)}ms}@media (prefers-reduced-motion: reduce){.ring{animation:none;opacity:0}}</style>` +
      `<circle class="ring" cx="${c}" cy="${c}" r="3" fill="${color}"/>${dot}`,
  )
}

/** The session's cost, its cost per hour, the elapsed time, and a dot that tells whether a turn runs. */
export const header: Section = ({ Box, Text, Svg }, { usage, elapsedMs, live }) => {
  // Cost per hour of wall time; under a minute the rate swings too far to read.
  const perHour = usage.cost && elapsedMs >= 60_000 ? usage.cost.usd / (elapsedMs / 3_600_000) : null
  const status = live === null ? null : liveStatus(live)
  const tone = status === null || status.waiting ? undefined : status.stalled ? 'warning' : 'success'
  return (
    <Box flexDirection="row" justifyContent="space-between" alignItems="flex-end">
      <Box flexDirection="column">
        <Text size="title" weight="semibold" tabular>
          {usage.cost ? fmtUsd(usage.cost.usd) : 'n/a'}
        </Text>
        <Text size="caption" dimColor tabular>
          Session cost{perHour !== null ? ` · ${fmtUsd(perHour)}/h` : ''}
        </Text>
      </Box>
      <Box flexDirection="column" alignItems="flex-end">
        {/* The dot is always there, so nothing moves when a turn starts or ends. */}
        <Box flexDirection="row" alignItems="center" columnGap="xs">
          {Svg ? (
            <Svg source={dotSvg(live)} alt={status === null ? 'No turn running' : status.now} width={DOT_BOX} height={DOT_BOX} />
          ) : (
            <Text color={tone} dimColor={tone === undefined}>
              ●
            </Text>
          )}
          <Text size="heading" tabular>
            {fmtMs(elapsedMs)}
          </Text>
        </Box>
        <Text size="caption" color={tone} dimColor={tone === undefined} tabular>
          {/* The label stays, so the big number never reads as the turn's time. */}
          {live === null ? 'Elapsed' : `Elapsed · running ${fmtMs(Math.max(1000, Math.floor(live.ms / 1000) * 1000))}`}
        </Text>
      </Box>
    </Box>
  )
}
