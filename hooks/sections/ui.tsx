import type { BoxProps, ElementConstructor, RenderElement, SessionUsage, SvgProps, TextProps } from 'claude-code'

import type { Metrics } from '../../types'
import { blockBar, heightOf } from '../charts'

/** The elements of the surface that draws the pane; Svg only where the surface draws charts. */
export type Kit = {
  Box: ElementConstructor<BoxProps>
  Text: ElementConstructor<TextProps>
  Svg?: ElementConstructor<SvgProps>
}

/** The main turn that runs now, as the pane draws it. */
export type LiveTurn = {
  ms: number
  toolCalls: number
  /** Time since the turn last moved: a model chunk, a step's end, or a tool call's start or end. */
  quietMs: number
  /** The quiet time at which the turn counts as stalled; 0 never. */
  stallMs: number
}

export type PaneData = {
  m: Metrics
  usage: SessionUsage
  now: number
  /** Cost per local day across sessions, from the store. */
  daily: Readonly<Record<string, number>>
  elapsedMs: number
  /** The pane body's width in cells of the surface's code font. */
  columns: number
  rows: number
  /** The running main turn, or null between turns. */
  live: LiveTurn | null
  /** Time left before the prompt cache of the last main turn expires; null while a turn runs or before the first ends. */
  cacheLeftMs: number | null
  cacheTtlMs: number
  /** The token count at which auto-compaction runs; null when it is off or not read yet. */
  compactAt: number | null
}

type Body = RenderElement | (RenderElement | null | false)[]

/** What each section gets: the element table, the chart width, and the shared builders. */
export type Ui = Kit & {
  /** The chart width in pixels. */
  px: number
  /** The bar width in terminal cells. */
  cells: number
  section: (title: string, meta: RenderElement | string, body: Body) => RenderElement
  chart: (source: string, alt: string, isInteractive?: boolean) => RenderElement | null
  /** A bar of block characters, `cells` wide unless a row puts a label before it. */
  termBar: (frac: number, color: string, width?: number) => RenderElement
  /** A small line of text, dim unless it has a color. */
  caption: (text: string, color?: TextProps['color']) => RenderElement
}

/** One part of the pane, drawn from the figures; null or false when it has nothing to show. */
export type Section = (ui: Ui, d: PaneData) => RenderElement | null | false

// A remote surface counts cells in its code font, and the desktop app's run about 9px. A chart drawn a little wider than the
// body reaches its right edge: an Svg with no width prop scales down to its slot, never up, so a narrow guess left a gap.
const PX_PER_CELL = 9

export const makeUi = ({ Box, Text, Svg }: Kit, columns: number): Ui => {
  const px = Math.max(220, Math.min(960, Math.floor(columns * PX_PER_CELL)))
  const cells = Math.max(16, columns - 2)
  return {
    Box,
    Text,
    Svg,
    px,
    cells,
    section: (title, meta, body) => (
      <Box flexDirection="column" gap="xs">
        <Box flexDirection="row" justifyContent="space-between" columnGap="sm" flexWrap="wrap">
          <Text weight="semibold" size="footnote">
            {title}
          </Text>
          {typeof meta === 'string' ? (
            <Text size="caption" dimColor tabular>
              {meta}
            </Text>
          ) : (
            meta
          )}
        </Box>
        {body}
      </Box>
    ),
    chart: (source, alt, isInteractive = true) =>
      Svg ? <Svg source={source} alt={alt} height={heightOf(source)} isInteractive={isInteractive || undefined} /> : null,
    termBar: (frac, color, width = cells) => {
      const [filled, empty] = blockBar(frac, width)
      return (
        <Text>
          <Text color={color}>{filled}</Text>
          <Text dimColor>{empty}</Text>
        </Text>
      )
    },
    caption: (text, color) => (
      <Text size="caption" dimColor={color === undefined} color={color} tabular>
        {text}
      </Text>
    ),
  }
}
