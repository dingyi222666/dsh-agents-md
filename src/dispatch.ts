/**
 * Dispatches one detected `@mention` as a subagent: the child runs under the
 * agent's own system prompt (its `persona`) and, when configured, its own
 * model, on the configured provider. The outcome is a one-line notice summary
 * for the transcript row plus the full model-facing text.
 *
 * @module @dingyi222666/dsh-agent-book/dispatch
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStopReason } from '@deepseek-ai/dsh-subagent'
import type { AgentMention } from './mention.ts'

/** Where the dispatched child should run. */
export interface DispatchOptions {
  /** Subagent provider name (must support the `persona` capability). */
  readonly provider: string
  /** Absolute delegation-depth cap applied to the child (defaults to the provider's policy). */
  readonly maxDepth?: number
}

/** The settled outcome of one dispatch, ready to become a plugin context message. */
export interface DispatchOutcome {
  /** One-line account for the collapsed notice row (bounded by the caller). */
  readonly summary: string
  /** Full model-facing text explaining the dispatch and its result. */
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
 * Run one agent mention to completion on the configured provider and describe
 * the outcome. The parent's turn waits (the dispatch is part of its pre-step),
 * the child is cancelled through the same turn signal, and the run is always
 * disposed after settlement.
 * @param ctx - the plugin context carrying the `subagents` service.
 * @param mention - the detected mention and its task.
 * @param parent - the agent whose step the dispatch serves.
 * @param signal - the parent turn's abort signal, passed to the child.
 * @param options - provider and depth policy.
 * @returns the notice summary and full model-facing text.
 */
export async function dispatchMention(
  ctx: Context,
  mention: AgentMention,
  parent: Agent,
  signal: AbortSignal,
  options: DispatchOptions,
): Promise<DispatchOutcome> {
  const { agent } = mention
  const modelPart = agent.model !== undefined ? ` (model ${agent.model})` : ''
  try {
    const run = await ctx.subagents.start(options.provider, {
      label: `@${agent.name}`,
      prompt: [{ type: 'text', text: mention.task }] as ContentBlock[],
      parent,
      signal,
      ...agent.model !== undefined ? { agentOptions: { model: agent.model } } : {},
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
        summary: `@${agent.name} ${note}`,
        text: `The user's @${agent.name} mention was dispatched to the "${agent.name}" agent`
          + `${modelPart}, which ${note}.${output.length > 0 ? `\nPartial output:\n${output}` : ''}`,
      }
    }
    return {
      summary: `@${agent.name} returned`,
      text: `The user's @${agent.name} mention was dispatched to the "${agent.name}" agent`
        + `${modelPart}. The agent's reply:\n${output}`,
    }
  } catch (error: unknown) {
    return {
      summary: `@${agent.name} could not start`,
      text: `The @${agent.name} mention could not be dispatched: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}
