import { HEX, fmtNum, stackSvg } from '../charts'
import type { Section } from './ui'

/** Cache read, cache write, input, and output as one stacked bar, with each count. */
export const tokens: Section = (ui, { m }) => {
  const { Box, Text } = ui
  const parts = [
    { value: m.cacheReadTokens, color: HEX.cacheRead, label: 'Cache read' },
    { value: m.cacheWriteTokens, color: HEX.cacheWrite, label: 'Cache write' },
    { value: m.inputTokens, color: HEX.input, label: 'Input' },
    { value: m.outputTokens, color: HEX.output, label: 'Output' },
  ]
  const total = parts.reduce((s, p) => s + p.value, 0)
  const sent = m.cacheReadTokens + m.cacheWriteTokens + m.inputTokens
  const cachedPct = sent > 0 ? Math.round((m.cacheReadTokens / sent) * 100) : 0
  return ui.section('Tokens', total === 0 ? 'none yet' : `${fmtNum(total)} · ${cachedPct}% of input cached`, [
    ui.Svg ? ui.chart(stackSvg(ui.px, parts), 'Token mix') : ui.termBar(sent > 0 ? m.cacheReadTokens / sent : 0, 'suggestion'),
    // Two fixed columns, so the four entries never wrap 3 + 1.
    <Box flexDirection="row" flexWrap="wrap" rowGap="xs">
      {parts.map(p => (
        <Box width="50%">
          <Text size="caption">
            <Text backgroundColor={p.color}>{'  '}</Text>
            <Text dimColor> {p.label} </Text>
            <Text tabular>{fmtNum(p.value)}</Text>
          </Text>
        </Box>
      ))}
    </Box>,
  ])
}
