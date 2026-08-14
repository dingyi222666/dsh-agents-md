/**
 * The plugin's real composition path: apply() over a temp agents directory with
 * fake subagents / systemPrompt / webServer faces, driving the pre-step
 * waterfall exactly as the loop does. Covers the @mention dispatch, the
 * user-source-only guard, the roster section, and the roster route.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { apply, inject, DEFAULT_ROSTER_PATH } from '../src/index.ts'

const VALID = `---
description: Reviews code for bugs
model: deepseek-chat
---
You are a senior code reviewer.
`

/** A minimal agent subject for agentEvents (object-keyed scope; never dereferenced deeply). */
const subject = { id: 'agent-1' } as unknown as Agent

const userMessage = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

const pluginMessage = (text: string): UserMessage => createUserMessage({
  content: [{ type: 'text', text }],
  source: { kind: 'plugin', plugin: 'other-plugin' },
})

/** Narrow an enter decision; rejects the test when the decision is a reject. */
function enter(decision: PreStepDecision): Extract<PreStepDecision, { kind: 'enter' }> {
  if (decision.kind !== 'enter') throw new Error(`expected an enter decision, got ${decision.kind}`)
  return decision
}

interface Bench {
  ctx: Context
  starts: SubagentStartRequest[]
  sections: { name: string; order: number; text: () => string }[]
  routes: { kind: string; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void> }[]
  dir: string
}

async function bench(config: Record<string, unknown> = {}): Promise<Bench> {
  const dir = await mkdtemp(join(tmpdir(), 'agent-book-apply-'))
  await writeFile(join(dir, 'reviewer.md'), VALID)
  await writeFile(join(dir, 'broken.md'), 'no frontmatter')
  const ctx = new Context()
  const starts: SubagentStartRequest[] = []
  const sections: Bench['sections'] = []
  const routes: Bench['routes'] = []
  ctx.provide('subagents', {
    start: async (_provider: string, request: SubagentStartRequest) => {
      starts.push(request)
      return {
        id: 'child-1' as never,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: '代码没问题。' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
    },
  })
  ctx.provide('systemPrompt', {
    section: (section: Bench['sections'][number]) => {
      sections.push(section)
      return () => {}
    },
  })
  ctx.provide('webServer', {
    register: (route: Bench['routes'][number]) => {
      routes.push(route)
      return () => {}
    },
  })
  await ctx.plugin({ inject: [...inject], apply }, {
    agentsDir: dir,
    provider: 'spawn',
    maxDepth: 3,
    rosterPath: DEFAULT_ROSTER_PATH,
    ...config,
  })
  return { ctx, starts, sections, routes, dir }
}

async function fire(ctx: Context, messages: UserMessage[], signal: AbortSignal = new AbortController().signal): Promise<PreStepDecision> {
  return agentEvents(ctx, subject).waterfall(
    'agent/pre-step',
    { messages, turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter', messages }),
  )
}

const texts = (decision: PreStepDecision): string[] =>
  decision.kind === 'enter'
    ? decision.messages.map(message =>
      message.content.filter(block => block.type === 'text').map(block => block.text).join(''))
    : []

describe('apply', () => {
  let current: Bench | undefined

  beforeEach(() => { current = undefined })
  afterEach(async () => {
    if (current !== undefined) await rm(current.dir, { recursive: true, force: true })
  })

  it('declares the services it binds', () => {
    expect(inject).toEqual(['subagents', 'systemPrompt'])
  })

  it('dispatches a @mention in a user message to the agent and appends the result notice', async () => {
    const b = await bench()
    current = b
    const message = userMessage('@reviewer 检查这段代码')
    const decision = enter(await fire(b.ctx, [message]))

    expect(b.starts).toHaveLength(1)
    expect(b.starts[0]).toMatchObject({
      label: '@reviewer',
      persona: 'You are a senior code reviewer.',
      agentOptions: { model: 'deepseek-chat' },
      maxDepth: 3,
    })
    expect(b.starts[0].prompt).toEqual([{ type: 'text', text: '检查这段代码' }])
    expect(b.starts[0].parent).toBe(subject)

    expect(decision.messages).toHaveLength(2)
    expect(decision.messages[0]).toBe(message)
    const notice = decision.messages[1]
    expect(notice.source).toMatchObject({
      kind: 'plugin', plugin: 'dsh-agent-book', form: 'notice', summary: '@reviewer returned',
    })
    expect(texts(decision)[1]).toContain('代码没问题。')
  })

  it('passes the parent turn signal to the child', async () => {
    const b = await bench()
    current = b
    const signal = new AbortController().signal
    await fire(b.ctx, [userMessage('@reviewer 检查')], signal)
    expect(b.starts[0]?.signal).toBe(signal)
  })

  it('leaves messages without a mention untouched', async () => {
    const b = await bench()
    current = b
    const message = userMessage('普通消息')
    const decision = await fire(b.ctx, [message])
    expect(b.starts).toHaveLength(0)
    expect(enter(decision).messages).toEqual([message])
  })

  it('never dispatches on plugin-source messages, even with a mention', async () => {
    const b = await bench()
    current = b
    const decision = await fire(b.ctx, [pluginMessage('@reviewer 检查')])
    expect(b.starts).toHaveLength(0)
    expect(enter(decision).messages).toHaveLength(1)
  })

  it('delegates a rejected step without dispatching', async () => {
    const b = await bench()
    current = b
    const message = userMessage('@reviewer 检查')
    const decision = await agentEvents(b.ctx, subject).waterfall(
      'agent/pre-step',
      { messages: [message], turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'reject' }),
    )
    expect(b.starts).toHaveLength(0)
    expect(decision).toEqual({ kind: 'reject' })
  })

  it('registers a roster section that lists the loaded agents', async () => {
    const b = await bench()
    current = b
    const section = b.sections.find(entry => entry.name === 'agent-book:roster')
    expect(section).toBeDefined()
    expect(section!.order).toBe(95)
    expect(section!.text()).toContain('@reviewer — Reviews code for bugs (model: deepseek-chat)')
  })

  it('registers the roster route on the webserver and serves the agent list as JSON', async () => {
    const b = await bench()
    current = b
    const route = b.routes.find(entry => entry.path === DEFAULT_ROSTER_PATH)
    expect(route).toBeDefined()
    expect(route!.kind).toBe('exact')
    let body = ''
    const res = {
      writeHead: () => {},
      end: (chunk: string) => { body = chunk },
    } as unknown as ServerResponse
    await route!.handler({ method: 'GET' } as IncomingMessage, res)
    expect(JSON.parse(body)).toEqual([
      { name: 'reviewer', description: 'Reviews code for bugs', model: 'deepseek-chat' },
    ])
  })

  it('still boots without a webserver, serving no roster route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-book-noroute-'))
    await writeFile(join(dir, 'reviewer.md'), VALID)
    const ctx = new Context()
    ctx.provide('subagents', {
      start: async (_provider: string, _request: SubagentStartRequest) => {
        throw new Error('unexpected start')
      },
    })
    ctx.provide('systemPrompt', { section: () => () => {} })
    await ctx.plugin({ inject: [...inject], apply }, { agentsDir: dir })
    await rm(dir, { recursive: true, force: true })
    expect(ctx.get('webServer')).toBeUndefined()
  })
})
