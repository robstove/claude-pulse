import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { quietly } from './quietly'
import { record } from './tally'
import { requestStarted } from './cache'
import { callEnded, callStarted, callWaits, keepWatch, progress, requestBegan, requestEnded, touch } from './watch'

type On = Parameters<Register>[0]

// The stall watch's key for a running compaction; no tool_use_id takes this form.
const COMPACTION = 'pulse:compaction'

// Set when the session.compact hook records a main compaction, so the /compact hook does not record it a second time.
let compactSeen = false

// The pane draws a running main compaction from this: its start time, or null when none runs.
const compacting = atom({ plugin: 'pulse', key: 'compactingSince' } as const, null as number | null)
const markCompacting = ($: EngineInterface, since: number | null): Promise<unknown> => quietly(() => update($, compacting, () => since))

// The waits before each read of the count after /compact; the sweep stays until a read sees the count fall or the last one ends.
const SETTLE_MS = [0, 250, 1000]

/** Reads the local count after /compact; a compaction that stands shrinks it, one that failed or found nothing to compact leaves it. */
const settle = ($: EngineInterface, before: number | undefined, i: number): void => {
  $.clock.after(SETTLE_MS[i] ?? 0, () =>
    void quietly(async () => {
      try {
        const tokensAfter = (await $.session.usage({ breakdown: 'summary' })).context.breakdown?.totalTokens
        if (tokensAfter !== undefined && (before === undefined || tokensAfter < before)) {
          const at = await $.clock.now()
          await record($, { kind: 'compaction', at, trigger: 'manual', isSkipped: false, tokensBefore: before, tokensAfter })
        } else if (i + 1 < SETTLE_MS.length) return settle($, before, i + 1)
      } catch {
        // A failed read ends the watch; the sweep must not stay.
      }
      await markCompacting($, null)
    }),
  )
}

/** Hooks that only watch: subagent starts, compactions, prompts, and each model request. Each passes its event on unchanged. */
export function observe(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined) {
      await record($, { kind: 'spawn', type: e.subagentType, agentId: r.agentId, model: r.model, isResume: e.resume !== undefined })
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    // A main compaction inside a turn is work, not a stall: the stall watch holds it open as a waiting call while it runs. A
    // precompute runs beside the turn, so it holds nothing; a compaction that fails still ends the hold.
    const holds = e.agentId === undefined && e.trigger !== 'precompute'
    const began = holds ? await quietly(() => $.clock.now()) : undefined
    if (began !== undefined) {
      callStarted(COMPACTION, 'Compaction', began, '', 'compact')
      callWaits(COMPACTION)
      await keepWatch($)
      await markCompacting($, began)
    }
    let at: number | undefined
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } finally {
      at = await quietly(() => $.clock.now())
      if (began !== undefined) {
        callEnded(COMPACTION, at ?? began)
        await keepWatch($)
        await markCompacting($, null)
      }
    }
    const done = r.skip === undefined ? r : undefined
    if (e.agentId === undefined && e.trigger !== 'precompute') compactSeen = true
    if (at !== undefined) {
      await record($, {
        kind: 'compaction',
        at,
        trigger: e.trigger,
        agentId: e.agentId,
        isSkipped: done === undefined,
        tokensBefore: done?.tokensBefore,
        tokensAfter: done?.tokensAfter,
      })
    }
    return r
  })

  // A policy plugin (cc-plugin-sec-default) keeps session.compact from user plugins, but command.run still reaches Pulse, and its
  // next resolves once /compact ends. The new window has no API count until its first response, so the local estimate stands in.
  on('command.run', { command: 'compact' }, async ($, e, next) => {
    compactSeen = false
    // The local count, as the API count can stay set after /compact (the compaction request's own count, live 2.1.326).
    const before = (await quietly(() => $.session.usage({ breakdown: 'summary' })))?.context.breakdown?.totalTokens
    const began = await quietly(() => $.clock.now())
    if (began !== undefined) await markCompacting($, began)
    let r: Awaited<ReturnType<typeof next>>
    try {
      r = await next(e)
    } catch (err) {
      await markCompacting($, null)
      throw err
    }
    if (compactSeen) await markCompacting($, null)
    // The engine swaps in the compacted conversation only after this hook returns (live 2.1.326), so a timer reads the count.
    else if ((await quietly(async () => settle($, before, 0))) === undefined) await markCompacting($, null)
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    // A notification delivered into a running turn starts no turn, so its task ends here.
    if (e.origin?.kind === 'task-notification') {
      const now = await quietly(() => $.clock.now())
      if (now !== undefined) await record($, { kind: 'notice', text: e.text, now })
    }
    await record($, { kind: 'prompt', origin: e.origin?.kind, isMeta: e.isMeta === true, isDropped: r.drop !== undefined, command: e.command?.name })
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const startedAt = await quietly(() => $.clock.now())
    // A main request starts the cache's clock and a step of the strip; a subagent's request is neither.
    const stepKey = `${e.turnId}:${e.index}`
    if (startedAt !== undefined && e.agentId === undefined) {
      requestStarted(startedAt)
      requestBegan(stepKey, startedAt)
      await keepWatch($)
    }
    let firstAt: number | null = null
    // After one failed clock read the step stops its timing, so a broken clock costs one try, not one per chunk.
    let timing = startedAt !== undefined
    const stream = next(e)
    let r: Awaited<typeof stream.result>
    let endedAt: number | undefined
    // The step ends in `finally`, so one that throws or is stopped never stays open on the strip.
    try {
      for await (const chunk of stream) {
        // Engine chunks are the envelope and block markers; the first text, thinking, or tool chunk is the first token.
        if (timing && firstAt === null && chunk.kind !== 'engine') {
          const at = await quietly(() => $.clock.now())
          if (at === undefined) timing = false
          else firstAt = at
        }
        // Any chunk shows the turn moves, a server tool's engine chunks and a subagent's too; the stall check reads the clock, so a
        // chunk costs no clock read.
        touch()
        yield chunk
      }
      r = await stream.result
    } finally {
      endedAt = await quietly(() => $.clock.now())
      if (endedAt !== undefined) progress(endedAt)
      if (e.agentId === undefined) {
        requestEnded(stepKey, endedAt ?? startedAt ?? 0)
        await keepWatch($)
      }
    }
    await record($, {
      kind: 'step',
      agentId: e.agentId,
      startedAt,
      firstAt,
      endedAt,
      output: r.usage?.output_tokens ?? 0,
      serverTools: (r.serverToolUses ?? []).map(u => u.name),
      stopReason: r.stopReason,
      effort: e.effort === undefined ? undefined : String(e.effort),
    })
    return r
  })
}
