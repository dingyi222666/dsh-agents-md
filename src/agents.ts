/**
 * Agent definitions: opencode-style markdown files, one agent per file. Each
 * file carries a YAML frontmatter block (`description`, optional `model`) and
 * the body becomes the agent's system prompt (the per-child persona the
 * dispatched subagent runs under).
 *
 * @module @dingyi222666/dsh-agents-md/agents
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'

/** One parsed custom agent definition. */
export interface AgentDefinition {
  /** Mention name (the file stem, e.g. `reviewer` for `reviewer.md`). */
  readonly name: string
  /** One-line role description shown in the '@' menu and to the model. */
  readonly description: string
  /** Optional provider route; inherits the parent agent's provider when absent. */
  readonly provider?: string
  /** Optional model id routed to the provider adapter; inherits the parent agent's model when absent. */
  readonly model?: string
  /** The agent's system prompt (the dispatched child's persona). */
  readonly systemPrompt: string
}

/** Why one agent file was skipped during a directory load. */
export interface SkippedAgent {
  /** File path relative to the agents directory. */
  readonly file: string
  /** Human-readable reason (the parse/validation error message). */
  readonly reason: string
}

/** The result of loading one agents directory. */
export interface AgentsLoadResult {
  /** Parsed agents in filename order. */
  readonly agents: readonly AgentDefinition[]
  /** Files that were skipped, with the reason for each. */
  readonly skipped: readonly SkippedAgent[]
}

/** One raw agent file, before parsing. */
export interface AgentFileInput {
  /** File name relative to the agents directory. */
  readonly file: string
  /** Full file text. */
  readonly text: string
}

/** Valid mention names: ASCII word characters plus `-`, no spaces or CJK. */
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

/**
 * Render an agent's provider/model route for model-facing text:
 * `(provider/model)`, `(model: X)`, `(provider: P)`, or empty.
 * @param agent - the agent (or any object carrying the optional fields).
 * @returns the parenthesized route text, or '' when neither field is set.
 */
export function routePart(agent: { readonly provider?: string; readonly model?: string }): string {
  if (agent.provider !== undefined && agent.model !== undefined) return ` (${agent.provider}/${agent.model})`
  if (agent.model !== undefined) return ` (model: ${agent.model})`
  if (agent.provider !== undefined) return ` (provider: ${agent.provider})`
  return ''
}

/** The frontmatter fence: `---`, the YAML block, a closing `---`, then the body. */
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/

/**
 * Detect a complete `{{...}}` group in a persona body. The system-prompt
 * renderer treats `{{name}}` as a strict prompt-variable reference and throws
 * on an unknown variable, so a body containing any complete group cannot be
 * used as a per-child persona. A lone `{{` without a later `}}` is literal
 * prose and stays allowed.
 * @param text - the candidate persona body.
 * @returns whether the body contains a complete group the renderer would try to interpolate.
 */
export function hasStrictVariableGroup(text: string): boolean {
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', open + 2)) {
    if (text.indexOf('}}', open + 2) >= 0) return true
  }
  return false
}

/**
 * Parse one agent markdown file into a definition. Throws with a descriptive
 * error on malformed frontmatter, invalid fields, or a persona body the
 * system-prompt renderer cannot accept.
 * @param name - the mention name (normally the file stem).
 * @param text - the full file text.
 * @returns the parsed definition.
 */
export function parseAgentFile(name: string, text: string): AgentDefinition {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `agent name "${name}" is not usable as a mention (names match ${String(NAME_PATTERN)})`,
    )
  }
  const match = FRONTMATTER.exec(text)
  if (match === null) {
    throw new Error('missing frontmatter: the file must start with a `---` YAML block and a body')
  }
  const [, frontmatter, body] = match
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter)
  } catch (error: unknown) {
    throw new Error(`frontmatter is not valid YAML: ${String(error)}`)
  }
  const fields = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
  const description = fields.description
  if (typeof description !== 'string' || description.trim().length === 0) {
    throw new Error('frontmatter must set a non-empty `description` (e.g. `description: Reviews code for bugs`)')
  }
  const model = fields.model
  if (model !== undefined && (typeof model !== 'string' || model.trim().length === 0)) {
    throw new Error('frontmatter `model`, when present, must be a non-empty string')
  }
  const provider = fields.provider
  if (provider !== undefined && (typeof provider !== 'string' || provider.trim().length === 0)) {
    throw new Error('frontmatter `provider`, when present, must be a non-empty string')
  }
  if (body.trim().length === 0) {
    throw new Error('the agent body (its system prompt) must not be empty')
  }
  const systemPrompt = body.trim()
  if (hasStrictVariableGroup(systemPrompt)) {
    throw new Error(
      'the agent body must not contain a complete `{{...}}` group: the body is used as the child '
      + 'persona, where `{{name}}` is a strict prompt-variable reference and an unknown variable '
      + 'fails the child\'s first request (a lone `{{` without a later `}}` is fine)',
    )
  }
  return {
    name,
    description: description.trim(),
    ...provider !== undefined ? { provider: provider.trim() } : {},
    ...model !== undefined ? { model: model.trim() } : {},
    systemPrompt,
  }
}

/**
 * Parse and dedupe a batch of raw agent files. Malformed files are skipped
 * with their reason so one bad file cannot take the whole profile down — the
 * same degradation user-authored settings documents get; a name that repeats
 * (case-insensitively) keeps its first (filename-sorted) definition.
 * @param inputs - raw files, in any order.
 * @returns the parsed agents and the skipped files.
 */
export function collectAgents(inputs: readonly AgentFileInput[]): AgentsLoadResult {
  const agents: AgentDefinition[] = []
  const skipped: SkippedAgent[] = []
  const seen = new Set<string>()
  for (const { file, text } of [...inputs].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    const stem = file.slice(0, -'.md'.length)
    try {
      const agent = parseAgentFile(stem, text)
      const key = agent.name.toLowerCase()
      if (seen.has(key)) {
        skipped.push({ file, reason: `duplicate agent name "${agent.name}" (case-insensitive)` })
        continue
      }
      seen.add(key)
      agents.push(agent)
    } catch (error: unknown) {
      skipped.push({ file, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  return { agents, skipped }
}

/**
 * Load every `*.md` file in one agents directory. A missing directory is an
 * empty roster (a fresh install has no agents yet).
 * @param dir - the directory to scan.
 * @returns the parsed agents and the skipped files.
 */
export async function loadAgentsDir(dir: string): Promise<AgentsLoadResult> {
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return { agents: [], skipped: [] }
  }
  const files = entries.filter(entry => entry.endsWith('.md'))
  const inputs: AgentFileInput[] = []
  for (const file of files) {
    inputs.push({ file, text: await readFile(join(dir, file), 'utf8') })
  }
  return collectAgents(inputs)
}
