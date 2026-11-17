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

/** A task notification, read for the task id and how it ended; its summary and output are never read. No end: the task goes on. */
export const taskNotice = (text: string): { id: string; ended?: TaskEnd } | undefined => {
  if (!text.trimStart().startsWith('<task-notification>')) return undefined
  const id = /<task-id>([\w-]{1,64})<\/task-id>/.exec(text)?.[1]
  if (id === undefined) return undefined
  const status = /<status>([^<]{1,32})<\/status>/.exec(text)?.[1]
  if (status === undefined) return { id }
  // `killed` is a stop by the person or by Claude, not a failure and not a success.
  return { id, ended: status === 'failed' ? 'failed' : status === 'killed' ? 'stopped' : 'ok' }
}
