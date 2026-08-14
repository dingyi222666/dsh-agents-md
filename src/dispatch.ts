/**
 * Runs one custom agent as a subagent: the child runs under the agent's own
 * system prompt (its `persona`) and, when configured, its own provider/model
 * route, on the configured provider. The tool layer calls this and maps a
 * failed run to an isError tool result.
 *
 * @module @dingyi222666/dsh-agent-book/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import { routePart } from './agents.ts'
import type { AgentDefinition } from './agents.ts'

/** Where the dispatched child should run. */
export interface DispatchOptions {
  /** Subagent provider name (must support the `persona` capability). */
  readonly provider: string
  /** Absolute delegation-depth cap applied to the child (defaults to the provider's policy). */
  readonly maxDepth?: number
}

/** The settled outcome of one dispatch. */
export interface DispatchOutcome {
  /** Whether the child finished cleanly; false means the tool should raise an error. */
  readonly ok: boolean
  /** One-line account of the outcome. */
  readonly summary: string
  /** Full model-facing text (the agent's reply, or the failure explanation). */
  readonly text: string
}

/** Concatenate the text blocks of a content block array. */
function textOf(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Map a terminal stop reason to a short model-facing failure note. */
function stopReasonNote(reason: SubagentStopReason): string {
  switch (reason) {
    case 'completed':
      return 'finished'
    case 'aborted':
      return 'was cancelled'
    case 'error':
      return 'failed'
    case 'max-tokens':
      return 'hit its token limit before finishing'
    case 'refusal':
      return 'declined the task'
    default:
      return `ended abnormally (${String(reason)})`
  }
}

/**
 * Run one custom agent to completion on the configured provider. The caller
 * awaits the child (the tool is foreground), the child is cancelled through
 * the same signal, and the run is always disposed after settlement.
 * @param ctx - the plugin context carrying the `subagents` service.
 * @param agent - the agent definition to dispatch.
 * @param task - the task text delivered as the child's user message.
 * @param parent - the calling agent.
 * @param signal - the caller's abort signal, passed to the child.
 * @param options - provider and depth policy.
 * @returns whether the run finished cleanly, plus summary and full text.
 */
export async function dispatchAgent(
  ctx: Context,
  agent: AgentDefinition,
  task: string,
  parent: Agent,
  signal: AbortSignal,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const modelPart = routePart(agent)
  try {
    const run = await ctx.subagents.start(options.provider, {
      label: `@${agent.name}`,
      prompt: [{ type: 'text', text: task }] as ContentBlock[],
      parent,
      signal,
      ...agent.provider !== undefined || agent.model !== undefined
        ? {
          agentOptions: {
            ...agent.provider !== undefined ? { provider: agent.provider } : {},
            ...agent.model !== undefined ? { model: agent.model } : {},
          },
        }
        : {},
      persona: agent.systemPrompt,
      ...options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {},
    })
    let result: SubagentResult
    try {
      result = await run.result
    } finally {
      await run.dispose()
    }
    const output = textOf(result.output)
    if (result.stopReason !== 'completed') {
      const note = stopReasonNote(result.stopReason)
      return {
        ok: false,
        summary: `@${agent.name} ${note}`,
        text: `The @${agent.name} agent${modelPart} ${note}.${output.length > 0 ? `\nPartial output:\n${output}` : ''}`,
      }
    }
    return {
      ok: true,
      summary: `@${agent.name} returned`,
      text: `The @${agent.name} agent${modelPart} returned:\n${output}`,
    }
  } catch (error: unknown) {
    return {
      ok: false,
      summary: `@${agent.name} could not start`,
      text: `The @${agent.name} agent could not be dispatched: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
