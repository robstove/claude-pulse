import { fmtMs, fmtNum, plural } from '../charts'
import { modelLabel } from './models'
import type { Section } from './ui'

/** Starts, time, tokens, and model for each subagent type. */
export const agents: Section = (ui, { m }) => {
  const list = Object.entries(m.agents).sort((a, b) => b[1].ms - a[1].ms)
  if (list.length === 0) return null
  const spawns = list.reduce((s, [, a]) => s + a.spawns, 0)
  const { Box, Text } = ui
  return ui.section(
    'Subagents',
    `${plural(spawns, 'start')} · ${plural(list.length, 'type')}`,
    list.slice(0, 6).map(([type, a]) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
          <Text size="caption" weight="semibold">
            {type}
          </Text>
          <Text size="caption" dimColor tabular>
            {a.spawns}× · {fmtMs(a.ms)}
          </Text>
        </Box>
        {ui.caption(`${fmtNum(a.inputTokens)} in · ${fmtNum(a.outputTokens)} out${a.model ? ` · ${modelLabel(a.model)}` : ''}`)}
      </Box>
    )),
  )
}
