import type { Section } from './ui'

/** The calls other plugins made through the tool chain, which no section above counts. */
export const plugins: Section = ({ Text }, { m }) => {
  const calls = Object.entries(m.pluginCalls)
  return (
    calls.length > 0 && (
      <Text size="caption" dimColor>
        Not counted above: {calls.map(([p, n]) => `${n} calls by ${p}`).join(', ')}
      </Text>
    )
  )
}
