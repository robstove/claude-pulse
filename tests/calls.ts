import type { test } from 'claude-code/testing'

type Kit = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

let next = 0

/** A tool call that ran, as the engine reports it after the run: PostToolUse, or PostToolUseFailure when it failed. */
export const ran = (
  $: Kit,
  tool: string,
  input: Record<string, unknown>,
  { ms = 100, failed = false, response = {} as unknown, id = `call-${(next += 1)}` } = {},
) =>
  failed
    ? $.classic.PostToolUseFailure({ tool_name: tool, tool_input: input, tool_use_id: id, error: 'failed', duration_ms: ms })
    : $.classic.PostToolUse({ tool_name: tool, tool_input: input, tool_response: response, tool_use_id: id, duration_ms: ms })
