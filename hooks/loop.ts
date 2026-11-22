// A tool that fails this many times in a row in one agent is a loop: the stall watch misses it, because each failure is progress.
export const LOOP_FAILS = 3

// Per agent and tool: the failures in a row, and when the last counted one ended. A call that does not fail starts the count again.
const streaks = new Map<string, { n: number; endedAt: number }>()

const prefix = (agentId: string | undefined): string => `${agentId ?? ''}|`

/** Starts the counts of one agent again (the main loop when `agentId` is undefined): at a main turn's start, or a subagent's end. */
export const resetLoops = (agentId?: string): void => {
  for (const key of [...streaks.keys()]) if (key.startsWith(prefix(agentId))) streaks.delete(key)
}

/** Counts one finished call; true only for the failure that reaches LOOP_FAILS, so one loop gives one toast. A failure that
 * started before the last counted one ended ran beside it in one batch, so it is no retry and does not count. */
export const loopReached = (agentId: string | undefined, tool: string, failed: boolean, startedAt: number, endedAt: number): boolean => {
  const key = `${prefix(agentId)}${tool}`
  const prev = streaks.get(key)
  if (!failed) {
    streaks.delete(key)
    return false
  }
  if (prev !== undefined && startedAt < prev.endedAt) return false
  const n = (prev?.n ?? 0) + 1
  streaks.set(key, { n, endedAt })
  return n === LOOP_FAILS
}

/** The toast for a loop, with the call's label so the person sees what fails. */
export const loopText = (tool: string, detail: string, inAgent: boolean): string =>
  `Pulse: ${tool}${detail !== '' ? ` (${detail})` : ''} failed ${LOOP_FAILS} times in a row${inAgent ? ' in a subagent' : ''}.`
