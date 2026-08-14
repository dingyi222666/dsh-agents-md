/**
 * Dispatch orchestration: the subagent start request carries the agent's
 * persona and provider/model route, the run is disposed after settlement, and
 * failures map to ok:false outcomes instead of throwing.
 */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '../src/agents.ts'
import { dispatchAgent } from '../src/dispatch.ts'

const reviewer: AgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code for bugs',
  provider: 'google',
  model: 'gemini-3-flash-preview',
  systemPrompt: 'You are a senior code reviewer.',
}

const parent = { id: 'agent-1' } as unknown as Agent

function fakeRun(result: SubagentResult, dispose: () => Promise<void> = async () => {}): SubagentRun {
  return {
    id: 'child-1' as unknown as SessionId,
    localAgent: undefined,
    result: Promise.resolve(result),
    dispose,
  }
}

async function startWith(result: SubagentResult): Promise<{ outcome: Awaited<ReturnType<typeof dispatchAgent>>; request: SubagentStartRequest | undefined }> {
  const ctx = new Context()
  let request: SubagentStartRequest | undefined
  ctx.provide('subagents', {
    start: async (_provider: string, req: SubagentStartRequest) => {
      request = req
      return fakeRun(result)
    },
  })
  const outcome = await dispatchAgent(ctx, reviewer, '检查这段代码', parent, new AbortController().signal, {
    provider: 'spawn',
    maxDepth: 3,
  })
  return { outcome, request }
}

const textBlocks = (output: string) => [{ type: 'text' as const, text: output }]

describe('dispatchAgent', () => {
  it('builds the child request from the agent definition and reports a clean completion', async () => {
    const { outcome, request } = await startWith({
      output: textBlocks('代码没问题。'),
      stopReason: 'completed',
    })
    expect(request).toMatchObject({
      label: '@reviewer',
    })
    expect(request?.prompt).toEqual([{ type: 'text', text: '检查这段代码' }])
    expect(request?.agentOptions).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' })
    expect(request?.persona).toBe('You are a senior code reviewer.')
    expect(request?.maxDepth).toBe(3)
    expect(request?.parent).toBe(parent)
    expect(outcome.ok).toBe(true)
    expect(outcome.summary).toBe('@reviewer returned')
    expect(outcome.text).toContain('google/gemini-3-flash-preview')
    expect(outcome.text).toContain('代码没问题。')
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
    await dispatchAgent(ctx, { ...reviewer, provider: undefined, model: undefined }, 'x', parent, new AbortController().signal, { provider: 'spawn' })
    expect(request?.agentOptions).toBeUndefined()
  })

  it('reports a non-completed stop reason with ok:false and the preserved partial output', async () => {
    const { outcome } = await startWith({
      output: textBlocks('看到一半……'),
      stopReason: 'max-tokens',
    })
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toBe('@reviewer hit its token limit before finishing')
    expect(outcome.text).toContain('hit its token limit')
    expect(outcome.text).toContain('看到一半……')
  })

  it('maps a start failure to an ok:false outcome instead of throwing', async () => {
    const ctx = new Context()
    ctx.provide('subagents', {
      start: async () => {
        throw new Error('provider does not support persona')
      },
    })
    const outcome = await dispatchAgent(ctx, reviewer, 'x', parent, new AbortController().signal, { provider: 'spawn' })
    expect(outcome.ok).toBe(false)
    expect(outcome.summary).toBe('@reviewer could not start')
    expect(outcome.text).toContain('provider does not support persona')
  })

  it('always disposes the run after settlement', async () => {
    let disposed = 0
    const ctx = new Context()
    ctx.provide('subagents', {
      start: async () => fakeRun({ output: textBlocks('ok'), stopReason: 'completed' }, async () => { disposed += 1 }),
    })
    await dispatchAgent(ctx, reviewer, 'x', parent, new AbortController().signal, { provider: 'spawn' })
    expect(disposed).toBe(1)
  })
})
