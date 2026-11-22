import type { Register } from 'claude-code'

import { budgetState, budgetText, hideBudget } from './budget'
import { quietly } from './quietly'

type On = Parameters<Register>[0]

/** The band above the prompt while today's spend is past the budget's warning share, until the person hides it. */
export function budgetBand(on: On): void {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const state = await quietly(() => budgetState($))
    if (!state) return next(e)
    const { spent, budget, level, day } = state
    const color = level >= 1 ? 'error' : 'warning'
    const { Box, Button, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" columnGap={1} alignItems="center" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text color={color} bold wrap="truncate-end">
            {level >= 1 ? '■' : '▲'} {budgetText(spent, budget, level)}
          </Text>
        </Box>
        <Button key="pulse-budget-hide" role="dismiss" onPress={() => void quietly(() => hideBudget($, { day, level, budget }))}>
          Hide
        </Button>
      </Box>
    )
  })
}
