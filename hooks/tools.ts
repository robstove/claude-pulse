import { atom, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { FILE_TOOLS, SAMPLES, callLabel, pushSlow } from './derive'
import { quietly } from './quietly'
import { EMPTY, SHAPE, live } from './state'
import { taskNotice, taskOf } from './tasks'
import type { TaskEnd } from './tasks'

// The state scan reads an atom only where its file declares it, so each file that reads or writes Metrics declares the same one.
const metrics = atom({ plugin: 'pulse', key: 'metrics' } as const, EMPTY, { shape: SHAPE })

type On = Parameters<Register>[0]

// Paths stop at 100, so one session save stays near 30 KB.
const MAX_FILES = 100
const MAX_TASKS = 50
const MAX_PENDING = 200
// The engine's words when the person says no at the permission dialog, or when an ask has nobody to answer it. No field marks
// these refusals, so the text is the sign; if the engine changes the words, such a call counts as failed again.
const REJECTED = /^(The user doesn't want to proceed with this tool use|Permission to use \S+ has been denied)/

// The tool_use_ids that tool.check put to a decider, and those it refused. A call that never reaches tool.call leaves its id,
// so the oldest goes past MAX_PENDING.
const asked = new Set<string>()
const denied = new Set<string>()

const mark = (set: Set<string>, id: string): void => {
  if (set.size >= MAX_PENDING) set.delete(set.values().next().value as string)
  set.add(id)
}

async function settleTask($: EngineInterface, id: string, ended: TaskEnd): Promise<void> {
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
        background: {
          count: held.count + 1,
          failed: held.failed + (ended === 'failed' ? 1 : 0),
          stopped: (held.stopped ?? 0) + (ended === 'stopped' ? 1 : 0),
          ms: held.ms + ms,
        },
        slowest: pushSlow(m.slowest, { tool: task.tool, ms, label: task.label, background: true }),
      }
    })
  })
}

/** Settles the background task a notification reports on; any other text changes nothing. */
export async function noteTaskNotice($: EngineInterface, text: string): Promise<void> {
  const notice = taskNotice(text)
  if (notice?.ended !== undefined) await settleTask($, notice.id, notice.ended)
}

// tool.call's span holds the permission decision. The span of a call that tool.check put to a decider (a person, auto mode's
// classifier, a host) counts as wait time apart from tool time, because the engine reports no point where the decision ends.
export function observeTools(on: On): void {
  // The verdict comes from beneath Pulse: a plugin above that changes it moves that call between tool time and wait time.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id !== undefined && verdict.decision === 'ask') mark(asked, e.tool_use_id)
    if (e.tool_use_id !== undefined && verdict.decision === 'deny') mark(denied, e.tool_use_id)
    return verdict
  })

  on('tool.call', async ($, e, next) => {
    // Only the engine's dispatch is the model's call; another plugin's $.tool.call is counted apart.
    const caller = next.origin.plugin
    if (caller !== 'engine') {
      const ran = await next(e)
      if (e.tool_use_id !== undefined) {
        asked.delete(e.tool_use_id)
        denied.delete(e.tool_use_id)
      }
      await quietly(() => update($, metrics, m => ({ ...m, pluginCalls: { ...m.pluginCalls, [caller]: (m.pluginCalls?.[caller] ?? 0) + 1 } })))
      return ran
    }
    const started = await quietly(() => $.clock.now())
    const ran = await next(e)
    const ended = started === undefined ? undefined : await quietly(() => $.clock.now())
    const id = e.tool_use_id
    const wasAsked = id !== undefined && asked.delete(id)
    const wasDenied = id !== undefined && denied.delete(id)
    // A rule or a hook refuses through tool.check, and the call comes back as an error; a plugin beneath answers a deny.
    // A refusal at the permission dialog comes back as an asked call's error that the engine words in its fixed refusal text.
    const rejected = wasAsked && ran.isError === true && REJECTED.test(ran.text ?? '')
    const refused = ran.deny !== undefined || (wasDenied && ran.isError === true) || rejected
    // The running turn counts the main loop's calls, as its steps do; a subagent's calls are its own.
    if (!refused && e.agentId === undefined) live.toolCalls += 1
    const span = started === undefined || ended === undefined ? 0 : Math.max(0, ended - started)
    // The tool's own time; null when the span also holds a decider's wait.
    const ms = wasAsked ? null : span
    await quietly(async () => {
      // A call the person interrupted ends with isError too, but the tool did not fail.
      const failed = !refused && ran.isError === true && !next.signal.aborted
      const input = e as unknown as Readonly<Record<string, unknown>>
      const label = callLabel(input)
      // A subagent's task reports its end to that subagent, which Pulse does not hear, so only the main loop's tasks are timed.
      const task = refused || failed || e.agentId !== undefined ? undefined : taskOf(ran.result)
      // The task starts when its call does, or, after a decider's wait, when the call answers, so the wait stays out.
      const startedAt = task === undefined ? 0 : ((wasAsked ? ended : started) ?? (await $.clock.now()))
      const path = input.file_path ?? input.notebook_path
      const file = !refused && !failed && FILE_TOOLS.has(e.tool) && typeof path === 'string' ? path : null
      await update($, metrics, m => {
        const prev = m.byTool[e.tool] ?? { count: 0, errors: 0, ms: 0 }
        if (refused) {
          return {
            ...m,
            toolRefusals: (m.toolRefusals ?? 0) + 1,
            byTool: { ...m.byTool, [e.tool]: { ...prev, refused: (prev.refused ?? 0) + 1 } },
          }
        }
        const files = file === null ? m.files : { ...m.files, [file]: (m.files?.[file] ?? 0) + 1 }
        const tasks =
          task === undefined
            ? m.tasks
            : Object.fromEntries(Object.entries({ ...m.tasks, [task]: { tool: e.tool, label, startedAt } }).slice(-MAX_TASKS))
        return {
          ...m,
          toolCalls: m.toolCalls + 1,
          toolErrors: m.toolErrors + (failed ? 1 : 0),
          toolMsTotal: m.toolMsTotal + (ms ?? 0),
          toolWaited: (m.toolWaited ?? 0) + (ms === null ? 1 : 0),
          toolWaitMs: (m.toolWaitMs ?? 0) + (ms === null ? span : 0),
          byTool: {
            ...m.byTool,
            [e.tool]: {
              ...prev,
              count: prev.count + 1,
              errors: prev.errors + (failed ? 1 : 0),
              ms: prev.ms + (ms ?? 0),
              waited: (prev.waited ?? 0) + (ms === null ? 1 : 0),
              waitMs: (prev.waitMs ?? 0) + (ms === null ? span : 0),
              samples: ms === null ? prev.samples : [...(prev.samples ?? []), ms].slice(-SAMPLES),
            },
          },
          slowest: ms === null ? m.slowest : pushSlow(m.slowest, { tool: e.tool, ms, label }),
          files: files && Object.keys(files).length > MAX_FILES ? m.files : files,
          tasks,
        }
      })
    })

    return ran
  })
}
