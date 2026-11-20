import type { RenderElement } from 'claude-code'

import { activity } from './sections/activity'
import { agents } from './sections/agents'
import { context } from './sections/context'
import { files } from './sections/files'
import { header } from './sections/header'
import { history } from './sections/history'
import { limits } from './sections/limits'
import { models } from './sections/models'
import { plugins } from './sections/plugins'
import { tokens } from './sections/tokens'
import { tools } from './sections/tools'
import { turns } from './sections/turns'
import { makeUi } from './sections/ui'
import type { Kit, PaneData, Section } from './sections/ui'

// Each section draws its chart where the surface draws Svg and block characters elsewhere, and drops out when it has nothing.
const SECTIONS: readonly Section[] = [header, limits, context, turns, activity, tokens, tools, files, models, agents, history, plugins]

export const drawPane = (kit: Kit, d: PaneData): RenderElement => {
  const ui = makeUi(kit, d.columns)
  return (
    <kit.Box flexDirection="column" gap="lg">
      {SECTIONS.map(section => section(ui, d))}
    </kit.Box>
  )
}
