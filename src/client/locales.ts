/**
 * Browser-half copy for the agents-md '@' source.
 * @module @dingyi222666/dsh-agents-md/client/locales
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

/** Locale keys owned by the agents-md client half. */
export type AgentBookKey = keyof typeof zh

/** Dictionary namespace owned by this plugin. */
export const NS = 'agents-md'
