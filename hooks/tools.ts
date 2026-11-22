import type { Register } from 'claude-code'

import { quietly } from './quietly'
import { callLabel } from './label'
import { record } from './tally'
import { callEnded, callStarted, callWaits } from './watch'

type On = Parameters<Register>[0]

// A call that never reaches tool.call leaves its id, so the oldest goes past MAX_PENDING.
const MAX_PENDING = 200

// The tool_use_ids that tool.check put to a decider, and those it refused, for tool.call to read.
const asked = new Set<string>()
const denied = new Set<string>()

const mark = (set: Set<string>, id: string): void => {
  if (set.size >= MAX_PENDING) set.delete(set.values().next().value as string)
  set.add(id)
}

/** Times each tool call and hands what it saw to the tally; the tally holds the rules for refused, failed, and waited. */
export function observeTools(on: On): void {
  // The verdict comes from beneath Pulse: a plugin above that changes it moves that call between tool time and wait time.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined && verdict.decision === 'ask') {
      mark(asked, e.tool_use_id)
      // The engine runs tool.check inside tool.call's next, so the call is open in the stall watch by now.
      callWaits(e.tool_use_id)
    }
    if (e.tool_use_id !== undefined && verdict.decision === 'deny') mark(denied, e.tool_use_id)
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    // Only the engine's dispatch is the model's call; another plugin's $.tool.call is counted apart.
    const caller = next.origin.plugin
    const startedAt = caller === 'engine' ? await quietly(() => $.clock.now()) : undefined
    // The stall watch holds the main loop's calls; tool.check, which the engine runs inside next, marks one put to a decider.
    const watched = id !== undefined && startedAt !== undefined && e.agentId === undefined
    if (watched) callStarted(id, e.tool, startedAt, callLabel(e as unknown as Readonly<Record<string, unknown>>))
    let ran: Awaited<ReturnType<typeof next>>
    let endedAt: number | undefined
    // The call ends in `finally`, so one that throws never stays open on the strip or holds the stall watch off.
    try {
      ran = await next(e)
    } finally {
      endedAt = startedAt === undefined ? undefined : await quietly(() => $.clock.now())
      if (watched) callEnded(id, endedAt ?? startedAt)
    }
    const wasAsked = id !== undefined && asked.delete(id)
    const wasDenied = id !== undefined && denied.delete(id)
    if (caller !== 'engine') {
      await record($, { kind: 'plugin-call', plugin: caller })
      return ran
    }
    await record($, {
      kind: 'tool',
      tool: e.tool,
      input: e as unknown as Readonly<Record<string, unknown>>,
      agentId: e.agentId,
      asked: wasAsked,
      denied: wasDenied,
      deny: ran.deny !== undefined,
      isError: ran.isError === true,
      text: ran.text,
      result: ran.result,
      aborted: next.signal.aborted,
      startedAt,
      endedAt,
    })
    return ran
  })
}
