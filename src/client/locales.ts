/**
 * Browser-half copy for the agent-book '@' source.
 * @module @dingyi222666/dsh-agent-book/client/locales
 */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  /** The '@' candidate-menu group title. */
  group: '智能体',
}

/** English copy, key-for-key (the locale gate refuses an asymmetric pair). */
export const en = {
  group: 'Agents',
} satisfies Record<AgentBookKey, string>

/** Locale keys owned by the agent-book client half. */
export type AgentBookKey = keyof typeof zh

/** Dictionary namespace owned by this plugin. */
export const NS = 'agent-book'
