/**
 * dsh-agent-book: opencode-style custom agents for dsh. The node half loads
 * one agent per markdown file (YAML frontmatter + body), routes `@mention`s in
 * user messages to a subagent running under that agent's own system prompt and
 * model, publishes the roster for the browser half, and tells the model what
 * the mentions mean.
 *
 * @module @dingyi222666/dsh-agent-book
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, UserMessage } from '@deepseek-ai/dsh-llm'
import { assertSubagentMaxDepth } from '@deepseek-ai/dsh-subagent'
// Type-only: pulls the system-prompt service's cordis Context merge (ctx.systemPrompt).
import type {} from '@deepseek-ai/dsh-system-prompt'
import z from '@deepseek-ai/schemastery'
import { loadAgentsDir, routePart } from './agents.ts'
import type { AgentDefinition } from './agents.ts'
import { dispatchMention } from './dispatch.ts'
import { findMention } from './mention.ts'

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
export const inject = ['subagents', 'systemPrompt']

/** Prompt order of the agent roster section: after the persona, before tool guidance. */
const ROSTER_SECTION_ORDER = 95

/** Model-facing roster statement: what `@mention`s do and who is available. */
export function rosterSectionText(agents: readonly AgentDefinition[]): string {
  if (agents.length === 0) return ''
  const lines = agents.map(agent => `- @${agent.name} — ${agent.description}${routePart(agent)}`)
  return 'The user can dispatch work to named custom agents by writing @<name> in a message. '
    + 'The harness routes the rest of the message to that agent automatically and appends the '
    + 'agent\'s reply as context; you do not need to delegate for them. Available agents:\n'
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

/** Concatenate the text blocks of a user message (image blocks are skipped). */
function textOfMessage(message: UserMessage): string {
  return message.content
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/**
 * Plugin body: load the agents directory, publish the roster section and the
 * browser endpoint, and route `@mention`s in user messages to subagents.
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
    ctx.logger.info(`dsh-agent-book: no agent definitions found in ${agentsDir}; the '@' source stays empty`)
  } else {
    ctx.logger.info(`dsh-agent-book: loaded ${agents.length} agent(s) from ${agentsDir}`)
  }

  ctx.systemPrompt.section({
    name: 'agent-book:roster',
    order: ROSTER_SECTION_ORDER,
    text: () => rosterSectionText(agents),
  })

  // The dispatch is deterministic: the harness routes the mention before the
  // model sees it, so the model never has to decide whether to delegate.
  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted || agents.length === 0) return decision
    for (const message of decision.messages) {
      // Only the end user's own words dispatch; plugin contexts and tool
      // results (including this plugin's own dispatch notices) never do.
      if (message.source.kind !== 'user') continue
      const text = textOfMessage(message)
      if (text.length === 0) continue
      const mention = findMention(text, agents)
      if (mention === undefined) continue
      const outcome = await dispatchMention(ctx, mention, agent, signal, { provider, maxDepth })
      const notice = createUserMessage({
        content: [{ type: 'text', text: outcome.text }],
        source: {
          kind: 'plugin',
          plugin: 'dsh-agent-book',
          form: 'notice',
          summary: boundContextSummary(outcome.summary),
        },
      })
      return { kind: 'enter', messages: [...decision.messages, notice] }
    }
    return decision
  })

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
