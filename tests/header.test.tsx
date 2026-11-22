import { expect, test } from 'claude-code/testing'

import { PULSE_MS } from '../hooks/sections/turns'
import { PANE } from './kit'
import { engine } from './live'

// The pane header: the state word and the dot.

test('the pane header dot breathes and rings green while a turn runs, is amber and still when it stalls, and grey between turns', async ($, on) => {
  const { state } = engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const header = async (word: string) => {
    const pane = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const dot = (await pane.findAll({ type: 'Svg' })).find(c => c.props.width === 18)
    const color = (await pane.find({ type: 'Text', text: word }))?.props.color
    await pane.unmount()
    return { alt: dot?.props.alt, source: String(dot?.props.source), color }
  }
  const idle = await header('Idle')
  expect(idle.alt).toBe('Nothing running')
  expect(idle.source).toContain('#8b949e')
  expect(idle.source).not.toContain('class="ring"')
  expect(idle.color).toBeUndefined()
  await $.turn.start({ text: 'hi', turnId: 't1' })
  state.now += 12_000
  const busy = await header('Live')
  expect(busy.alt).toBe('Working · running 12s')
  expect(busy.source).toContain('#3fb950')
  expect(busy.source).toContain('class="ring"')
  expect(busy.source).toContain('class="dot"')
  // The dot moves in step with the strip, and holds still for reduced motion.
  expect(busy.source).toContain(`animation-delay:-${12_000 % PULSE_MS}ms`)
  expect(busy.source).toContain('prefers-reduced-motion: reduce){.dot{animation:none}')
  expect(busy.color).toBe('success')
  const term = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await term.find({ type: 'Text', text: '●' }))?.props.color).toBe('success')
  expect(await term.find({ type: 'Text', text: 'Elapsed · running 12s' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /^━+$/ })).toBeUndefined()
  await term.unmount()
  state.now += 4 * 60_000
  const stalled = await header('Stalled')
  expect(stalled.source).toContain('#d29922')
  expect(stalled.source).not.toContain('class="ring"')
  expect(stalled.color).toBe('warning')
})
