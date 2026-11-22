const TASK_ID = /^[\w-]{1,64}$/

const idOf = (v: unknown): string | undefined => (typeof v === 'string' && TASK_ID.test(v) ? v : undefined)

/** The id of the background task a tool's result started: a background command or subagent, a workflow, a monitor. */
export const taskOf = (result: unknown): string | undefined => {
  if (typeof result !== 'object' || result === null) return undefined
  const r = result as Record<string, unknown>
  if (r.status === 'async_launched' || r.status === 'remote_launched') return idOf(r.agentId) ?? idOf(r.taskId)
  // A monitor answers with its taskId and a timeout; other results that carry a taskId only name a task, they start none.
  // A persistent monitor (timeout 0) runs for the whole session, so it is no task to time.
  return idOf(r.backgroundTaskId) ?? (typeof r.timeoutMs === 'number' && r.timeoutMs > 0 ? idOf(r.taskId) : undefined)
}

export type TaskEnd = 'ok' | 'failed' | 'stopped'

// A block opens at the start of a line: the desktop app puts a "[SYSTEM NOTIFICATION ...]" frame before it, and one
// delivery can carry several blocks. A block inside a sentence is quoted text, not a notification.
const BLOCK = /(?:^|\n)[ \t]*<task-notification>([\s\S]*?)(?=<\/task-notification>|\n[ \t]*<task-notification>|$)/g

/** Each task notification in a delivery, read for the task id and how it ended; its summary and output are never read.
 * No end: the task goes on. */
export const taskNotices = (text: string): { id: string; ended?: TaskEnd }[] =>
  [...text.matchAll(BLOCK)].flatMap(([, body = '']) => {
    const id = /<task-id>([\w-]{1,64})<\/task-id>/.exec(body)?.[1]
    if (id === undefined) return []
    const status = /<status>([^<]{1,32})<\/status>/.exec(body)?.[1]
    if (status === undefined) return [{ id }]
    // `killed` is a stop by the person or by Claude, not a failure and not a success.
    return [{ id, ended: status === 'failed' ? 'failed' : status === 'killed' ? 'stopped' : 'ok' }]
  })

/** True for a text that opens as a notification, bare or under the desktop frame. turn.start carries no origin, so this keeps
 * a notification block that the person pasted into a prompt from ending a task. */
export const opensAsNotice = (text: string): boolean => /^\s*(?:<task-notification>|\[SYSTEM NOTIFICATION\b)/.test(text)

/** The task a TaskStop call names; a task it stops sends no notification. */
export const taskStopped = (input: Readonly<Record<string, unknown>>): string | undefined => idOf(input.task_id) ?? idOf(input.shell_id)
