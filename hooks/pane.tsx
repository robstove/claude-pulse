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
import { prefs } from './state'
import { makeUi } from './sections/ui'
import type { Kit, PaneData, Section } from './sections/ui'

// Each section draws its chart where the surface draws Svg and block characters elsewhere, and drops out when it has nothing.
const SECTIONS: Readonly<Record<string, Section>> = { header, limits, context, turns, activity, tokens, tools, files, models, agents, history, plugins }

/** The sections option, in its order, with unknown names left out; every section when it names none that exists. */
const chosen = (): Section[] => {
  const named = [...new Set(prefs.sections)].filter(n => Object.hasOwn(SECTIONS, n)).map(n => SECTIONS[n] as Section)
  return named.length > 0 ? named : Object.values(SECTIONS)
}

export const drawPane = (kit: Kit, d: PaneData): RenderElement => {
  const ui = makeUi(kit, d.columns)
  return (
    <kit.Box flexDirection="column" gap="lg">
      {chosen().map(section => section(ui, d))}
    </kit.Box>
  )
}
