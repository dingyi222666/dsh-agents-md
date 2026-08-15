/**
 * `@mention` detection and task extraction over user message text. A mention
 * matches only at a name-character boundary, so `@reviewer` never matches the
 * agent `review` and `@types/react` never matches the agent `types` (the
 * boundary rule treats `-`, `_`, and ASCII alphanumerics as name characters).
 *
 * @module @dingyi222666/dsh-agents-md/mention
 */

import type { AgentDefinition } from './agents.ts'

/** One detected mention and the task the rest of the message carries. */
export interface AgentMention {
  /** The matched agent definition. */
  readonly agent: AgentDefinition
  /** The message text with every known `@name` token removed, trimmed. */
  readonly task: string
}

/** Characters that count as part of an agent name token in `@name`. */
const NAME_CHAR = /[A-Za-z0-9_-]/

/**
 * Test whether a single character continues an `@name` token.
 * @param ch - the character (empty string at the text boundary).
 * @returns whether the position is inside a name token.
 */
function isNameChar(ch: string): boolean {
  return ch.length > 0 && NAME_CHAR.test(ch)
}

/**
 * Find the first boundary-checked occurrence of `@name` in text.
 * @param text - the message text to scan.
 * @param name - the agent name to look for.
 * @returns the token index, or -1 when absent.
 */
export function indexOfMention(text: string, name: string): number {
  const token = `@${name}`
  let from = 0
  while (from < text.length) {
    const at = text.indexOf(token, from)
    if (at < 0) return -1
    const before = at === 0 ? '' : text[at - 1]
    const after = at + token.length >= text.length ? '' : text[at + token.length]
    if (!isNameChar(before) && !isNameChar(after)) return at
    from = at + 1
  }
  return -1
}

/**
 * Remove every boundary-checked `@name` token for every known agent, keeping
 * the characters around the tokens (whitespace, punctuation, CJK) intact.
 * @param text - the message text to clean.
 * @param agents - the known agents whose mentions are stripped.
 * @returns the text with all known mentions removed.
 */
export function stripMentions(text: string, agents: readonly AgentDefinition[]): string {
  let result = text
  for (const agent of agents) {
    // The captured prefix keeps the character before the mention; the
    // lookahead demands a non-name character or the end of text after it.
    const pattern = new RegExp(`(^|[^A-Za-z0-9_-])@${agent.name}(?=$|[^A-Za-z0-9_-])`, 'g')
    result = result.replace(pattern, '$1')
  }
  return result
}

/**
 * Detect the first `@mention` of a known agent in text, longest-name-first so
 * `@reviewer` is claimed by `reviewer` before `review` can see it. The task is
 * the whole message with every known mention removed, so the dispatched agent
 * never sees a sibling mention it cannot act on.
 * @param text - the message text.
 * @param agents - the known agents.
 * @returns the first mention with its task, or undefined when none matches.
 */
export function findMention(text: string, agents: readonly AgentDefinition[]): AgentMention | undefined {
  const sorted = [...agents].sort((a, b) => b.name.length - a.name.length)
  for (const agent of sorted) {
    if (indexOfMention(text, agent.name) < 0) continue
    const task = stripMentions(text, agents).trim()
    return { agent, task: task.length > 0 ? task : agent.description }
  }
  return undefined
}
