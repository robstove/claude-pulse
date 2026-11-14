import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Metrics } from '../types'
import { FILE_TOOLS, SAMPLES, callLabel, pushSlow } from './derive'
import { quietly } from './quietly'
import { EMPTY, SHAPE, live } from './state'
import { taskNotice, taskOf } from './tasks'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

type On = Parameters<Register>[0]

// Paths stop at 100, so one session save stays near 30 KB.
const MAX_FILES = 100
const MAX_TASKS = 50
const MAX_REFUSED = 200

// The tool_use_ids already counted as refused: tool.check can run more than once for one call.
const refusedIds = new Set<string>()

async function settleTask($: EngineInterface, id: string, ended: 'ok' | 'failed'): Promise<void> {
  await quietly(async () => {
    const now = await $.clock.now()
    await update($, metrics, m => {
      const task = m.tasks?.[id]
      if (task === undefined) return m
      const { [id]: _, ...tasks } = m.tasks ?? {}
      const ms = Math.max(0, now - task.startedAt)
      const held = m.background ?? { count: 0, failed: 0, ms: 0 }
      return {
        ...m,
        tasks,
        background: { count: held.count + 1, failed: held.failed + (ended === 'failed' ? 1 : 0), ms: held.ms + ms },
        slowest: pushSlow(m.slowest, { tool: task.tool, ms, label: task.label, background: true }),
      }
    })
  })
}

/** Settles the background task a notification reports on. True when the text is a task notification, so it is no prompt of the person's. */
export async function noteTaskNotice($: EngineInterface, text: string): Promise<boolean> {
  const notice = taskNotice(text)
  if (notice === undefined) return false
  if (notice.ended !== undefined) await settleTask($, notice.id, notice.ended)
  return true
}

async function refuse($: EngineInterface, tool: string, id: string): Promise<void> {
  if (refusedIds.has(id)) return
  if (refusedIds.size >= MAX_REFUSED) refusedIds.delete(refusedIds.values().next().value as string)
  refusedIds.add(id)
  await quietly(() =>
    update($, metrics, m => {
      const prev = m.byTool[tool] ?? { count: 0, errors: 0, ms: 0 }
      return { ...m, toolRefusals: (m.toolRefusals ?? 0) + 1, byTool: { ...m.byTool, [tool]: { ...prev, refused: (prev.refused ?? 0) + 1 } } }
    }),
  )
}

type Ran = { tool: string; id: string; input: unknown; ms: number | undefined; failed: boolean; result?: unknown }

/** Counts a call that ran, with the engine's own run time: no permission prompt and no hook time are in it. */
async function record($: EngineInterface, ran: Ran): Promise<void> {
  live.toolCalls += 1
  await quietly(async () => {
    const input = (typeof ran.input === 'object' && ran.input !== null ? ran.input : {}) as Readonly<Record<string, unknown>>
    const label = callLabel(input)
    const task = ran.failed ? undefined : taskOf(ran.result)
    const now = task === undefined ? 0 : await $.clock.now()
    const path = input.file_path ?? input.notebook_path
    const file = !ran.failed && FILE_TOOLS.has(ran.tool) && typeof path === 'string' ? path : null
    const ms = ran.ms ?? null
    // A plugin above Pulse can turn the deny it saw into an allow; the call then ran, so its refusal is taken back.
    const unrefuse = refusedIds.delete(ran.id)
    await update($, metrics, (m): Metrics => {
      const held = m.byTool[ran.tool] ?? { count: 0, errors: 0, ms: 0 }
      const prev = unrefuse ? { ...held, refused: Math.max(0, (held.refused ?? 0) - 1) } : held
      const files = file === null ? m.files : { ...m.files, [file]: (m.files?.[file] ?? 0) + 1 }
      const tasks =
        task === undefined
          ? m.tasks
          : Object.fromEntries(Object.entries({ ...m.tasks, [task]: { tool: ran.tool, label, startedAt: now - (ms ?? 0) } }).slice(-MAX_TASKS))
      return {
        ...m,
        toolRefusals: unrefuse ? Math.max(0, (m.toolRefusals ?? 0) - 1) : m.toolRefusals,
        toolCalls: m.toolCalls + 1,
        toolErrors: m.toolErrors + (ran.failed ? 1 : 0),
        toolMsTotal: m.toolMsTotal + (ms ?? 0),
        byTool: {
          ...m.byTool,
          [ran.tool]: {
            ...prev,
            count: prev.count + 1,
            errors: prev.errors + (ran.failed ? 1 : 0),
            ms: prev.ms + (ms ?? 0),
            // A call with no duration_ms, from an engine before it, adds no sample rather than a false zero.
            samples: ms === null ? prev.samples : [...(prev.samples ?? []), ms].slice(-SAMPLES),
          },
        },
        slowest: ms === null ? m.slowest : pushSlow(m.slowest, { tool: ran.tool, ms, label }),
        files: files && Object.keys(files).length > MAX_FILES ? m.files : files,
        tasks,
      }
    })
  })
}

// Pulse hooks no tool.call: a plugin that wraps a tool's call turns off, for that tool, the move of a running call to the
// background and a call's live output. The classic events below fire around the call and wrap nothing.
export function observeTools(on: On): void {
  on('classic.PostToolUse', async ($, e, next) => {
    const r = await next(e)
    await record($, { tool: e.tool_name, id: e.tool_use_id, input: e.tool_input, ms: e.duration_ms, failed: false, result: e.tool_response })
    return r
  })

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const r = await next(e)
    // An interrupt is the person's stop, not the tool's failure.
    await record($, { tool: e.tool_name, id: e.tool_use_id, input: e.tool_input, ms: e.duration_ms, failed: e.is_interrupt !== true })
    return r
  })

  // A rule or a hook refused the call before it ran: the verdict holds the PreToolUse hooks' decision too.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (verdict.decision === 'deny' && e.tool_use_id !== undefined) await refuse($, e.tool, e.tool_use_id)
    return verdict
  })

  // Auto mode's classifier refused the call.
  on('classic.PermissionDenied', async ($, e, next) => {
    const r = await next(e)
    await refuse($, e.tool_name, e.tool_use_id)
    return r
  })
}
