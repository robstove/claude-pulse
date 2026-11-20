import { plural } from '../charts'
import { shortPath } from '../label'
import type { Section } from './ui'

/** The files Claude edited, most edited first. */
export const files: Section = (ui, { m }) => {
  const list = Object.entries(m.files).sort((a, b) => b[1] - a[1])
  if (list.length === 0) return null
  const edits = list.reduce((s, [, n]) => s + n, 0)
  const { Box, Text } = ui
  return ui.section(
    'Files',
    `${plural(list.length, 'file')} · ${plural(edits, 'edit')}`,
    list.slice(0, 5).map(([path, n]) => (
      <Box flexDirection="row" justifyContent="space-between" columnGap="sm">
        <Text size="caption">{shortPath(path)}</Text>
        <Text size="caption" dimColor tabular>
          {n}×
        </Text>
      </Box>
    )),
  )
}
