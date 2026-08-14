/**
 * The plugin's real composition path: apply() over a temp agents directory with
 * fake tools / subagents / systemPrompt / webServer faces. Covers the
 * call_agent tool registration and execution (persona, provider/model route,
 * mention stripping, failure mapping), the roster section, and the roster
 * route.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, DEFAULT_ROSTER_PATH } from '../src/index.ts'

const VALID = `---
description: Reviews code for bugs
provider: google
model: gemini-3-flash-preview
---
You are a senior code reviewer.
`

/** A minimal agent subject for exec.agent (never dereferenced deeply). */
const subject = { id: 'agent-1' } as unknown as Agent

const exec = (signal: AbortSignal = new AbortController().signal): ToolRunContext =>
  ({ agent: subject, signal } as unknown as ToolRunContext)

interface Bench {
  ctx: Context
  fiber: { dispose: () => Promise<void> }
  starts: SubagentStartRequest[]
  /** The tool registered at boot (execution reads the live roster). */
  tool: { name: string; description: string; parameters: unknown; execute: (args: { agent: string; prompt: string }, execCtx: ToolRunContext) => Promise<string> }
  /** The currently registered tool; changes when the watcher re-registers. */
  latestTool: () => { name: string; description: string; parameters: unknown; execute: (args: { agent: string; prompt: string }, execCtx: ToolRunContext) => Promise<string> }
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
  let tool: Bench['tool']
  ctx.provide('tools', {
    register: (registered: Bench['tool']) => {

      tool = registered
      return () => {}
    },
  })
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
  const fiber = ctx.plugin({ inject: [...inject], apply }, {
    agentsDir: dir,
    provider: 'spawn',
    maxDepth: 3,
    rosterPath: DEFAULT_ROSTER_PATH,
    ...config,
  })
  await fiber.await()
  return { ctx, fiber, starts, sections, routes, dir, tool: tool!, latestTool: () => tool! }
}

describe('apply', () => {
  let current: Bench | undefined

  beforeEach(() => { current = undefined })
  afterEach(async () => {
    if (current !== undefined) {
      // Dispose the fiber first so the directory watcher closes before the
      // temp dir is removed (an rm-triggered reload would be harmless, but
      // ordering keeps the watcher quiet).
      await current.fiber!.dispose()
      await rm(current.dir, { recursive: true, force: true })
    }
  })

  it('declares the services it binds', () => {
    expect(inject).toEqual(['tools', 'subagents', 'systemPrompt'])
  })

  it('registers the call_agent tool with an enum of the loaded agents', async () => {
    const b = await bench()
    current = b
    expect(b.tool.name).toBe('call_agent')
    const parameters = b.tool.parameters as {
      type: string
      required: string[]
      properties: {
        agent: { type: string; enum: string[] }
        prompt: { type: string }
      }
    }
    expect(parameters.properties.agent).toMatchObject({
      type: 'string',
      enum: ['reviewer'],
    })
    expect(parameters.properties.prompt).toMatchObject({ type: 'string' })
    expect(parameters.required).toEqual(['agent', 'prompt'])
  })

  it('runs the named agent with its persona, route, and a mention-stripped task', async () => {
    const b = await bench()
    current = b
    const result = await b.tool.execute({ agent: 'reviewer', prompt: '@reviewer 检查这段代码' }, exec())
    expect(b.starts).toHaveLength(1)
    expect(b.starts[0]).toMatchObject({
      label: '@reviewer',
      persona: 'You are a senior code reviewer.',
      agentOptions: { provider: 'google', model: 'gemini-3-flash-preview' },
      maxDepth: 3,
    })
    expect(b.starts[0].prompt).toEqual([{ type: 'text', text: '检查这段代码' }])
    expect(b.starts[0].parent).toBe(subject)
    expect(result).toContain('代码没问题。')
    expect(result).toContain('google/gemini-3-flash-preview')
  })

  it('uses the agent description as the task when the prompt is only the mention', async () => {
    const b = await bench()
    current = b
    await b.tool.execute({ agent: 'reviewer', prompt: '@reviewer' }, exec())
    expect(b.starts[0]?.prompt).toEqual([{ type: 'text', text: 'Reviews code for bugs' }])
  })

  it('rejects an unknown agent name through the enum argument validation', async () => {
    const b = await bench()
    current = b
    await expect(b.tool.execute({ agent: 'ghost', prompt: 'x' }, exec()))
      .rejects.toThrow(/must be one of/)
    expect(b.starts).toHaveLength(0)
  })

  it('throws without a calling agent', async () => {
    const b = await bench()
    current = b
    await expect(b.tool.execute({ agent: 'reviewer', prompt: 'x' }, { signal: new AbortController().signal } as unknown as ToolRunContext))
      .rejects.toThrow(/calling agent/)
  })

  it('maps a failed child run to a tool error carrying the partial output', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-book-fail-'))
    await writeFile(join(dir, 'reviewer.md'), VALID)
    const ctx = new Context()
    let tool: Bench['tool']
    ctx.provide('tools', { register: (registered: Bench['tool']) => { tool = registered; return () => {} } })
    ctx.provide('subagents', {
      start: async (_provider: string, _request: SubagentStartRequest) => ({
        id: 'child-1' as never,
        localAgent: undefined,
        result: Promise.resolve({ output: [{ type: 'text', text: '看到一半……' }], stopReason: 'max-tokens' }),
        dispose: async () => {},
      }),
    })
    ctx.provide('systemPrompt', { section: () => () => {} })
    await ctx.plugin({ inject: [...inject], apply }, { agentsDir: dir })
    await rm(dir, { recursive: true, force: true })
    await expect(tool!.execute({ agent: 'reviewer', prompt: 'x' }, exec()))
      .rejects.toThrow(/hit its token limit/)
  })

  it('registers a roster section that lists the loaded agents with their route', async () => {
    const b = await bench()
    current = b
    const section = b.sections.find(entry => entry.name === 'agent-book:roster')
    expect(section).toBeDefined()
    expect(section!.order).toBe(95)
    expect(section!.text()).toContain('@reviewer — Reviews code for bugs (google/gemini-3-flash-preview)')
    expect(section!.text()).toContain('call_agent')
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
      { name: 'reviewer', description: 'Reviews code for bugs', provider: 'google', model: 'gemini-3-flash-preview' },
    ])
  })

  it('registers no tool and an empty roster section without agents, and still boots without a webserver', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-book-empty-'))
    const ctx = new Context()
    let registered = 0
    ctx.provide('tools', { register: () => { registered += 1; return () => {} } })
    ctx.provide('subagents', {
      start: async (_provider: string, _request: SubagentStartRequest) => {
        throw new Error('unexpected start')
      },
    })
    ctx.provide('systemPrompt', { section: () => () => {} })
    const fiber = ctx.plugin({ inject: [...inject], apply }, { agentsDir: dir })
    await fiber.await()
    await fiber.dispose()
    await rm(dir, { recursive: true, force: true })
    expect(registered).toBe(0)
    expect(ctx.get('webServer')).toBeUndefined()
  })

  it('live-reloads a new agent file into the tool enum', async () => {
    const b = await bench()
    current = b
    const enumOf = (): string[] =>
      (b.latestTool().parameters as { properties: { agent: { enum: string[] } } }).properties.agent.enum
    expect(enumOf()).toEqual(['reviewer'])
    await writeFile(join(b.dir, 'writer.md'), '---\ndescription: Writes prose\n---\nYou write.\n')
    await vi.waitFor(() => {
      expect(enumOf()).toEqual(['reviewer', 'writer'])
    }, { timeout: 5000 })
  })

  it('live-reloads edited definitions into the roster section and dispatch', async () => {
    const b = await bench()
    current = b
    const section = b.sections.find(entry => entry.name === 'agent-book:roster')!
    expect(section.text()).toContain('Reviews code for bugs')
    await writeFile(join(b.dir, 'reviewer.md'), `---
description: Reviews code AND security
provider: google
model: gemini-3-flash-preview
---
You are a senior code and security reviewer.
`)
    await vi.waitFor(() => {
      expect(section.text()).toContain('Reviews code AND security')
    }, { timeout: 5000 })
    // The enum is unchanged, so the tool is not re-registered; execution
    // reads the live roster and picks up the new persona.
    const result = await b.tool.execute({ agent: 'reviewer', prompt: '检查' }, exec())
    expect(b.starts[0]?.persona).toBe('You are a senior code and security reviewer.')
    expect(result).toContain('代码没问题。')
  })
})
