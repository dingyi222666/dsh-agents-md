/**
 * Dispatch orchestration: the subagent start request carries the agent's
 * persona and model, the run is disposed after settlement, and failures map to
 * notice outcomes instead of rejecting the step.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '../src/agents.ts'
import { dispatchMention } from '../src/dispatch.ts'
import type { AgentMention } from '../src/mention.ts'

const reviewer: AgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code for bugs',
  model: 'deepseek-chat',
  systemPrompt: 'You are a senior code reviewer.',
}

const mentionOf = (task = '检查这段代码'): AgentMention => ({ agent: reviewer, task })

const parent = { id: 'agent-1' } as unknown as Agent

function fakeRun(result: SubagentResult, dispose: () => Promise<void> = async () => {}): SubagentRun {
  return {
    id: 'child-1' as unknown as SessionId,
    localAgent: undefined,
    result: Promise.resolve(result),
    dispose,
  }
}

async function startWith(result: SubagentResult): Promise<{ outcome: Awaited<ReturnType<typeof dispatchMention>>; request: SubagentStartRequest | undefined }> {
  const ctx = new Context()
  let request: SubagentStartRequest | undefined
  ctx.provide('subagents', {
    start: async (_provider: string, req: SubagentStartRequest) => {
      request = req
      return fakeRun(result)
    },
  })
  const outcome = await dispatchMention(ctx, mentionOf(), parent, new AbortController().signal, {
    provider: 'spawn',
    maxDepth: 3,
  })
  return { outcome, request }
}

const textBlocks = (output: string) => [{ type: 'text' as const, text: output }]

describe('dispatchMention', () => {
  it('builds the child request from the agent definition and reports a clean completion', async () => {
    const { outcome, request } = await startWith({
      output: textBlocks('代码没问题。'),
      stopReason: 'completed',
    })
    expect(request).toMatchObject({
      label: '@reviewer',
    })
    expect(request?.prompt).toEqual([{ type: 'text', text: '检查这段代码' }])
    expect(request?.agentOptions).toEqual({ model: 'deepseek-chat' })
    expect(request?.persona).toBe('You are a senior code reviewer.')
    expect(request?.maxDepth).toBe(3)
    expect(request?.parent).toBe(parent)
    expect(outcome.summary).toBe('@reviewer returned')
    expect(outcome.text).toContain('The agent\'s reply:')
    expect(outcome.text).toContain('代码没问题。')
    expect(outcome.text).toContain('model: deepseek-chat')
  })

  it('routes provider and model together when both are set', async () => {
    const ctx = new Context()
    let request: SubagentStartRequest | undefined
    ctx.provide('subagents', {
      start: async (_provider: string, req: SubagentStartRequest) => {
        request = req
        return fakeRun({ output: textBlocks('ok'), stopReason: 'completed' })
      },
    })
    await dispatchMention(
      ctx,
      { agent: { ...reviewer, provider: 'google', model: 'gemini-3-flash-preview' }, task: 'x' },
      parent,
      new AbortController().signal,
      { provider: 'spawn' },
    )
    expect(request?.agentOptions).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' })
  })

  it('omits agentOptions when the agent defines neither provider nor model', async () => {
    const ctx = new Context()
    let request: SubagentStartRequest | undefined
    ctx.provide('subagents', {
      start: async (_provider: string, req: SubagentStartRequest) => {
        request = req
        return fakeRun({ output: textBlocks('ok'), stopReason: 'completed' })
      },
    })
    await dispatchMention(ctx, { agent: { ...reviewer, provider: undefined, model: undefined }, task: 'x' }, parent, new AbortController().signal, { provider: 'spawn' })
    expect(request?.agentOptions).toBeUndefined()
  })

  it('reports a non-completed stop reason with the preserved partial output', async () => {
    const { outcome } = await startWith({
      output: textBlocks('看到一半……'),
      stopReason: 'max-tokens',
    })
    expect(outcome.summary).toBe('@reviewer hit its token limit before finishing')
    expect(outcome.text).toContain('hit its token limit')
    expect(outcome.text).toContain('看到一半……')
  })

  it('maps a start failure to a could-not-start notice instead of throwing', async () => {
    const ctx = new Context()
    ctx.provide('subagents', {
      start: async () => {
        throw new Error('provider does not support persona')
      },
    })
    const outcome = await dispatchMention(ctx, mentionOf(), parent, new AbortController().signal, { provider: 'spawn' })
    expect(outcome.summary).toBe('@reviewer could not start')
    expect(outcome.text).toContain('provider does not support persona')
  })

  it('always disposes the run after settlement', async () => {
    let disposed = 0
    const ctx = new Context()
    ctx.provide('subagents', {
      start: async () => fakeRun({ output: textBlocks('ok'), stopReason: 'completed' }, async () => { disposed += 1 }),
    })
    await dispatchMention(ctx, mentionOf(), parent, new AbortController().signal, { provider: 'spawn' })
    expect(disposed).toBe(1)
  })
})
