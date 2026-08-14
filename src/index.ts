/**
 * dsh-agent-book: opencode-style custom agents for dsh. The node half loads
 * one agent per markdown file (YAML frontmatter + body), registers a
 * `call_agent` tool the main model uses to run a named agent as a subagent
 * (the child runs under the agent's own system prompt and provider/model
 * route, with the parent's tool set), publishes the roster for the browser
 * half, and tells the model who is available.
 *
 * @module @dingyi222666/dsh-agent-book
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
// Type-only: pulls the system-prompt service's cordis Context merge (ctx.systemPrompt).
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { loadAgentsDir, routePart } from './agents.ts'
import type { AgentDefinition } from './agents.ts'
import { dispatchAgent } from './dispatch.ts'
import { stripMentions } from './mention.ts'

/** Browser roster endpoint, mirrored by the client half's ROSTER_PATH. */
export const DEFAULT_ROSTER_PATH = '/dsh-agent-book/agents.json'

/** Default agents directory: one `*.md` agent definition per file. */
export function defaultAgentsDir(): string {
  return join(homedir(), '.dsh', 'agents')
}

/** Plugin configuration. */
export interface Config {
  /** Directory holding one `*.md` agent definition per file (default `~/.dsh/agents`). */
  agentsDir?: string
  /** Subagent provider name; must support the `persona` capability (default `spawn`). */
  provider?: string
  /** Absolute delegation-depth cap for dispatched agents (default `3`; `0` forbids dispatch). */
  maxDepth?: number
  /** HTTP path of the browser roster endpoint (default `/dsh-agent-book/agents.json`). */
  rosterPath?: string
}

export const Config: z<Config> = z.object({
  agentsDir: z.string(),
  provider: z.string().default('spawn'),
  maxDepth: z.natural().max(Number.MAX_SAFE_INTEGER).default(3),
  rosterPath: z.string().default(DEFAULT_ROSTER_PATH),
})

export const name = 'dsh-agent-book'
export const inject = ['tools', 'subagents', 'systemPrompt']

/** Prompt order of the agent roster section: after the persona, before tool guidance. */
const ROSTER_SECTION_ORDER = 95

/**
 * Model-facing roster statement: who is available and that the model itself
 * dispatches them through the `call_agent` tool.
 */
export function rosterSectionText(agents: readonly AgentDefinition[]): string {
  if (agents.length === 0) return ''
  const lines = agents.map(agent => `- @${agent.name} — ${agent.description}${routePart(agent)}`)
  return 'The user can call named custom agents by writing @<name> in a message or asking for that '
    + 'role\'s expertise. When a request names one of these agents, call the call_agent tool yourself '
    + 'with that agent\'s name and the task (without the @<name> prefix); the tool runs the agent as a '
    + 'subagent under its own system prompt and model and returns its reply. Available agents:\n'
    + lines.join('\n')
}

/** The browser-facing roster entry for one agent. */
export interface RosterEntry {
  readonly name: string
  readonly description: string
  readonly provider?: string
  readonly model?: string
}

/** Project one agent definition onto the browser roster wire form. */
function toRosterEntry(agent: AgentDefinition): RosterEntry {
  return {
    name: agent.name,
    description: agent.description,
    ...agent.provider !== undefined ? { provider: agent.provider } : {},
    ...agent.model !== undefined ? { model: agent.model } : {},
  }
}

/** Resolve an agent by mention name; undefined when the roster does not hold it. */
function agentByName(agents: readonly AgentDefinition[], name: string): AgentDefinition | undefined {
  return agents.find(agent => agent.name === name)
}

/**
 * Plugin body: load the agents directory, register the `call_agent` tool and
 * the roster section, and publish the browser roster endpoint.
 * @param ctx - the host context.
 * @param config - validated configuration.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // A direct apply() bypasses Schemastery's numeric constraints; keep the
  // direct-apply path as strict as the loader path.
  assertSubagentMaxDepth(config.maxDepth)
  const agentsDir = config.agentsDir ?? defaultAgentsDir()
  const provider = config.provider ?? 'spawn'
  const maxDepth = config.maxDepth ?? 3
  const rosterPath = config.rosterPath ?? DEFAULT_ROSTER_PATH

  const { agents, skipped } = await loadAgentsDir(agentsDir)
  for (const entry of skipped) {
    ctx.logger.warn(`dsh-agent-book: skipped agent file "${entry.file}": ${entry.reason}`)
  }
  if (agents.length === 0) {
    ctx.logger.info(`dsh-agent-book: no agent definitions found in ${agentsDir}; the call_agent tool stays unregistered`)
  } else {
    ctx.logger.info(`dsh-agent-book: loaded ${agents.length} agent(s) from ${agentsDir}`)
  }

  ctx.systemPrompt.section({
    name: 'agent-book:roster',
    order: ROSTER_SECTION_ORDER,
    text: () => rosterSectionText(agents),
  })

  // The model decides: it sees the roster in the system prompt and calls
  // call_agent when a request names one of the agents.
  if (agents.length > 0) {
    ctx.tools.register(defineTool({
      name: 'call_agent',
      description: 'Call one of the user\'s custom agents as a subagent. The agent runs under its '
        + 'own system prompt and provider/model route, can use tools itself, and returns its reply. '
        + 'Use this when the user writes @<name> or asks for that agent\'s role or expertise; pass the '
        + 'agent name exactly as listed and the task without the @<name> prefix.',
      parameters: {
        agent: {
          type: 'string',
          required: true,
          enum: agents.map(agent => agent.name),
          description: 'The custom agent name to call (from the available roster).',
        },
        prompt: {
          type: 'string',
          required: true,
          description: 'The task for the agent, without any @<name> prefix.',
        },
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      isConcurrencySafe: () => true,
      async execute(args, exec: ToolRunContext) {
        const parent = exec.agent
        if (parent === undefined) {
          throw new Error('call_agent requires a calling agent (exec.agent was undefined)')
        }
        const agent = agentByName(agents, args.agent)
        if (agent === undefined) {
          throw new Error(`call_agent: unknown agent "${args.agent}" (roster changed since load?)`)
        }
        const task = stripMentions(args.prompt, agents).trim() || agent.description
        const outcome = await dispatchAgent(ctx, agent, task, parent, exec.signal, { provider, maxDepth })
        if (!outcome.ok) throw new Error(outcome.text)
        return outcome.text
      },
    }))
  }

  // The browser '@' source fetches the roster from this endpoint; without the
  // webserver (headless profiles) the node half simply skips the route.
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    const route: WebRoute = {
      kind: 'exact',
      path: rosterPath,
      handler: (req, res) => {
        if (req.method !== 'GET') {
          res.writeHead(405, { allow: 'GET' })
          res.end()
          return
        }
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        })
        res.end(JSON.stringify(agents.map(toRosterEntry)))
      },
    }
    ctx.effect(() => webServer.register(route), 'dsh-agent-book: roster route')
  }
}
