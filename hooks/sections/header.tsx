import { fmtMs, fmtUsd } from '../charts'
import type { Section } from './ui'

/** The session's cost, its cost per hour, and the elapsed time. */
export const header: Section = ({ Box, Text }, { usage, elapsedMs }) => {
  // Cost per hour of wall time; under a minute the rate swings too far to read.
  const perHour = usage.cost && elapsedMs >= 60_000 ? usage.cost.usd / (elapsedMs / 3_600_000) : null
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
        <Text size="heading" tabular>
          {fmtMs(elapsedMs)}
        </Text>
        <Text size="caption" dimColor>
          Elapsed
        </Text>
      </Box>
    </Box>
  )
}
