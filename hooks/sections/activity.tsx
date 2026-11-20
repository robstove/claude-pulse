import { HEX, plural, stackSvg } from '../charts'
import type { Section } from './ui'

/** Claude's working time against the person's time between turns, with the prompt and slash-command counts. */
export const activity: Section = (ui, { m }) => {
  // Both counts start when Pulse first loads in the session, so the split compares like with like.
  const claude = m.turnMsTotal
  const you = m.idleMs
  if (claude + you === 0 && m.prompts === 0) return null
  // Until a main turn ends there is no time to split, and a 0% share would be false.
  const timed = claude + you > 0
  const share = timed ? Math.round((claude / (claude + you)) * 100) : 0
  const commands = Object.entries(m.commands).sort((a, b) => b[1] - a[1])
  const cmdCount = commands.reduce((s, [, n]) => s + n, 0)
  const parts = [
    { value: claude, color: HEX.accent, label: 'Claude working' },
    { value: you, color: HEX.muted, label: 'Between turns' },
  ]
  const listed = commands
    .slice(0, 4)
    .map(([c, n]) => `/${c}${n > 1 ? ` ${n}×` : ''}`)
    .join(', ')
  return ui.section('Activity', timed ? `Claude ${share}% · you ${100 - share}%` : 'no turn ended yet', [
    timed && (ui.Svg ? ui.chart(stackSvg(ui.px, parts), `Claude worked ${share}% of active time`) : ui.termBar(share / 100, 'suggestion')),
    ui.caption(`${plural(m.prompts, 'prompt')}${cmdCount > 0 ? ` · ${plural(cmdCount, 'command')}: ${listed}` : ''}`),
    ui.caption('A gap over 30 min between turns counts as away.'),
  ])
}
