import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'

import { addStep } from './derive'
import { EMPTY, SHAPE, live } from './state'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

type On = Parameters<Register>[0]

const MAX_COMPACTIONS = 20
const MAX_AGENT_IDS = 200

/** Hooks that only watch: subagent starts, compactions, prompts, and each model request. Each passes its event on unchanged. */
export function observe(on: On): void {
  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.deny !== undefined) return r
    try {
      await update($, metrics, m => {
        const prev = m.agents?.[e.subagentType] ?? { spawns: 0, turns: 0, ms: 0, inputTokens: 0, outputTokens: 0 }
        const ids = r.agentId
          ? Object.fromEntries(Object.entries({ ...m.agentTypes, [r.agentId]: e.subagentType }).slice(-MAX_AGENT_IDS))
          : m.agentTypes
        return {
          ...m,
          agents: { ...m.agents, [e.subagentType]: { ...prev, spawns: prev.spawns + 1, model: r.model } },
          agentTypes: ids,
        }
      })
    } catch {
      // Metrics are best effort.
    }
    return r
  })

  on('session.compact', async ($, e, next) => {
    const r = await next(e)
    // A precompute only prepares a summary; the conversation changes on the compaction that uses it.
    if (e.trigger === 'precompute' || r.skip !== undefined) return r
    try {
      const at = await $.clock.now()
      await update($, metrics, m => ({
        ...m,
        compactions: [
          ...(m.compactions ?? []),
          { at, trigger: e.trigger, turn: m.mainTurns, tokensBefore: r.tokensBefore, tokensAfter: r.tokensAfter },
        ].slice(-MAX_COMPACTIONS),
      }))
    } catch {
      // Metrics are best effort.
    }
    return r
  })

  on('prompt.submit', async ($, e, next) => {
    const r = await next(e)
    if (e.isMeta) return r
    try {
      const name = e.command?.name
      await update($, metrics, m => ({
        ...m,
        prompts: (m.prompts ?? 0) + 1,
        commands: name ? { ...m.commands, [name]: (m.commands?.[name] ?? 0) + 1 } : m.commands,
      }))
    } catch {
      // Metrics are best effort.
    }
    return r
  })

  on('turn.step', async function* ($, e, next) {
    const started = await $.clock.now()
    let first: number | null = null
    const stream = next(e)
    for await (const chunk of stream) {
      // Engine chunks are the envelope and block markers; the first text, thinking, or tool chunk is the first token.
      if (first === null && chunk.kind !== 'engine') first = await $.clock.now()
      yield chunk
    }
    const r = await stream.result
    try {
      const ended = await $.clock.now()
      if (e.agentId === undefined) live.steps += 1
      await update($, metrics, m => ({
        ...m,
        steps: addStep(m.steps, {
          firstMs: first === null ? null : first - started,
          streamMs: first === null ? 0 : ended - first,
          output: r.usage?.output_tokens ?? 0,
          serverTools: (r.serverToolUses ?? []).map(u => u.name),
          stopReason: r.stopReason,
          effort: e.effort === undefined ? undefined : String(e.effort),
        }),
      }))
    } catch {
      // Metrics are best effort.
    }
    return r
  })
}
