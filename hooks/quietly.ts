/** Runs metrics work and swallows its failure, because a fault in Pulse must never reach a tool call, a turn, or a render. */
export async function quietly<T>(work: () => Promise<T> | T): Promise<T | undefined> {
  try {
    return await work()
  } catch {
    return undefined
  }
}
