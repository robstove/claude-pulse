import type { Register } from 'claude-code'

import { quietly } from './quietly'
import { record } from './tally'

type On = Parameters<Register>[0]

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
    const r = await next(e)
    const done = r.skip === undefined ? r : undefined
    const at = await quietly(() => $.clock.now())
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
    let firstAt: number | null = null
    // After one failed clock read the step stops its timing, so a broken clock costs one try, not one per chunk.
    let timing = startedAt !== undefined
    const stream = next(e)
    for await (const chunk of stream) {
      // Engine chunks are the envelope and block markers; the first text, thinking, or tool chunk is the first token.
      if (timing && firstAt === null && chunk.kind !== 'engine') {
        const at = await quietly(() => $.clock.now())
        if (at === undefined) timing = false
        else firstAt = at
      }
      yield chunk
    }
    const r = await stream.result
    await record($, {
      kind: 'step',
      agentId: e.agentId,
      startedAt,
      firstAt,
      endedAt: await quietly(() => $.clock.now()),
      output: r.usage?.output_tokens ?? 0,
      serverTools: (r.serverToolUses ?? []).map(u => u.name),
      stopReason: r.stopReason,
      effort: e.effort === undefined ? undefined : String(e.effort),
    })
    return r
  })
}
