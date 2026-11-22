import { HEX, fmtMs, fmtUsd, svg } from '../charts'
import { PULSE_MS, liveStatus, phase, shineDef, stillWhenReduced, sweepCss } from './turns'
import type { LiveTurn, Section } from './ui'

// The dot's box: room for the ring to grow to twice the dot.
const DOT_BOX = 12
const BAND_H = 4
// The longest state word, Stalled, in cells: the word's box keeps this width, so the dot does not move when the word changes.
const WORD_CELLS = 7

/** The turn state as one dot: green and pulsing while it runs, amber when it stalls, grey when it waits or between turns. */
const dotSvg = (live: LiveTurn | null): string => {
  const status = live === null ? null : liveStatus(live)
  const color = status === null ? HEX.muted : status.stalled ? HEX.warn : HEX.ok
  const c = DOT_BOX / 2
  const dot = `<circle cx="${c}" cy="${c}" r="3" fill="${color}"/>`
  if (live === null || status === null || status.stalled) return svg(DOT_BOX, DOT_BOX, dot)
  return svg(
    DOT_BOX,
    DOT_BOX,
    `<style>@keyframes ring{from{transform:scale(1);opacity:.6}to{transform:scale(2);opacity:0}}` +
      `.ring{transform-box:fill-box;transform-origin:center;animation:ring ${PULSE_MS}ms cubic-bezier(.16,1,.3,1) infinite;${phase(live.ms)}}` +
      `${stillWhenReduced('.ring')}</style>` +
      `<circle class="ring" cx="${c}" cy="${c}" r="3" fill="${color}"/>${dot}`,
  )
}

/** A band across the pane's top: green with a sweep while a turn runs, amber and still when it stalls, a grey track between turns. */
const bandSvg = (w: number, live: LiveTurn | null): string => {
  const shape = `width="${w}" height="${BAND_H}" rx="2"`
  if (live === null) return svg(w, BAND_H, `<rect ${shape} fill="${HEX.track}"/>`)
  const { stalled } = liveStatus(live)
  const bar = `<rect ${shape} fill="${stalled ? HEX.warn : HEX.ok}"/>`
  if (stalled) return svg(w, BAND_H, bar)
  const gw = Math.max(40, w * 0.25)
  // The clip keeps the sheen inside the band's rounded ends.
  return svg(
    w,
    BAND_H,
    `<defs>${shineDef('shine')}<clipPath id="band"><rect ${shape}/></clipPath></defs>` +
      `<style>${sweepCss('sweep', gw, w, live.ms)}${stillWhenReduced('.sweep')}</style>` +
      `${bar}<g clip-path="url(#band)"><rect class="sweep" width="${gw.toFixed(0)}" height="${BAND_H}" fill="url(#shine)"/></g>`,
  )
}

/** The band, then the session's cost, its cost per hour, the elapsed time, and a dot and a word that tell whether a turn runs. */
export const header: Section = ({ Box, Text, Svg, px, cells }, { usage, elapsedMs, live }) => {
  // Cost per hour of wall time; under a minute the rate swings too far to read.
  const perHour = usage.cost && elapsedMs >= 60_000 ? usage.cost.usd / (elapsedMs / 3_600_000) : null
  const status = live === null ? null : liveStatus(live)
  const tone = status === null ? undefined : status.stalled ? 'warning' : 'success'
  const word = status === null ? 'Idle' : status.stalled ? 'Stalled' : 'Live'
  return (
    <Box flexDirection="column" gap="sm">
      {/* The band is always there, so nothing below moves when a turn starts or ends. Its alt names the state only: the dot's
          alt and the strip already read out what the turn does. */}
      {Svg ? (
        <Svg source={bandSvg(px, live)} alt={`Turn state: ${word}`} />
      ) : (
        <Text color={tone} dimColor={tone === undefined}>
          {'━'.repeat(cells)}
        </Text>
      )}
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
          <Box flexDirection="row" alignItems="center" columnGap="xs">
            {Svg ? (
              <Svg source={dotSvg(live)} alt={status === null ? 'No turn running' : status.now} width={DOT_BOX} height={DOT_BOX} />
            ) : (
              <Text color={tone} dimColor={tone === undefined}>
                ●
              </Text>
            )}
            <Box minWidth={WORD_CELLS}>
              <Text size="caption" weight="semibold" color={tone} dimColor={tone === undefined}>
                {word}
              </Text>
            </Box>
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
    </Box>
  )
}
