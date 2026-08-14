/**
 * Agent-book reference plugin, browser half: registers the '@' source whose
 * candidates are the custom agents the host loaded from its agents directory.
 * The roster rides one fetch from the host's roster endpoint (mirror of the
 * node half's `DEFAULT_ROSTER_PATH`); picking an agent inserts the literal
 * `@name ` text (the plain-text-reference decision — the draft carries plain
 * text, chip visuals are derived by scanning against the source lexicon, and
 * the prompt ships the same literal), and the node half's pre-step listener
 * routes the mention to the agent. No adjudication hooks: agent references
 * never enter command adjudication.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  CandidateRequest, ClientSessionContext, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the slot registry's LocaleNamespaceMap augmentation seat.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { en, NS, zh, type AgentBookKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The agent-book '@' reference source copy. */
    'agent-book': AgentBookKey
  }
}

export type { AgentBookKey } from './locales.ts'

/** Required services: the trigger pipeline and the locale dictionaries. */
export const inject = ['inputTriggers', 'locale']

/** The host roster endpoint, mirrored from the node half's `DEFAULT_ROSTER_PATH`. */
export const ROSTER_PATH = '/dsh-agent-book/agents.json'

/** One roster entry as served by the host. */
export interface AgentSummary {
  readonly name: string
  readonly description?: string
  readonly model?: string
}

/** Fetch and decode the roster; any failure degrades to an empty roster. */
async function fetchRoster(): Promise<readonly AgentSummary[]> {
  const response = await fetch(ROSTER_PATH, { cache: 'no-store' })
  if (!response.ok) throw new Error(`agent roster fetch failed (${response.status})`)
  const parsed: unknown = await response.json()
  if (!Array.isArray(parsed)) throw new Error('agent roster is not an array')
  return parsed.filter((entry): entry is AgentSummary =>
    typeof entry === 'object' && entry !== null
    && typeof (entry as Record<string, unknown>).name === 'string')
}

/**
 * The warm agent roster. `snapshot` is `undefined` until the first fetch
 * settles (cold → the lexicon reports "not warm"), then the fetched list
 * (possibly empty) forever; listeners are notified on that single transition.
 */
class AgentRoster {
  private agents: readonly AgentSummary[] | undefined
  private readonly listeners = new Set<() => void>()
  private loading: Promise<void> | undefined

  get snapshot(): readonly AgentSummary[] | undefined {
    return this.agents
  }

  /** Fetch once; later calls no-op while a fetch is pending or done. */
  warm(): void {
    if (this.loading !== undefined) return
    this.loading = fetchRoster()
      .then(agents => { this.agents = agents })
      .catch(() => { this.agents = [] })
      .finally(() => {
        for (const listener of [...this.listeners]) listener()
      })
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
}

/**
 * Client plugin body: register the '@' agent source over the host roster.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-agent-book: dictionaries')
  const roster = new AgentRoster()
  const source: InputTriggerSource = {
    trigger: '@',
    name: ctx.locale.bind(NS)('group'),
    candidates(_session: ClientSessionContext, req: CandidateRequest) {
      const agents = roster.snapshot ?? []
      const query = req.query
      return Promise.resolve(agents
        .filter(agent =>
          agent.name.includes(query) || (agent.description ?? '').includes(query))
        .map(agent => ({ name: agent.name, description: agent.description })))
    },
    lexicon() {
      return roster.snapshot === undefined ? undefined : roster.snapshot.map(agent => agent.name)
    },
    subscribeLexicon(_session: ClientSessionContext, listener: () => void) {
      return roster.subscribe(listener)
    },
    warm() {
      roster.warm()
    },
    onPick({ candidate }) {
      // Plain-text reference: the literal lands in the draft and ships to the
      // model verbatim (trailing space closes the token).
      return { text: `@${candidate.name} ` }
    },
    codec: {
      clipboardText: ref => `@${ref}`,
      serialize: ref => Promise.resolve(`@${ref}`),
    },
  }
  ctx.effect(() => ctx.inputTriggers.registerSource(source), 'dsh-agent-book: @ source')
}
