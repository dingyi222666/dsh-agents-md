/**
 * Package-owned invariant companion for `dsh-agents-md`.
 * @module @dingyi222666/dsh-agents-md/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
// Type-only: pulls the invariants package's cordis Context merge (ctx.invariants).
import type {} from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-agents-md'

/** Cordis companion plugin name. */
export const name = 'dsh-agents-md-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: a pure-consumer plugin — it registers an ordered
 * prompt section, a pre-step waterfall listener, and an optional webserver
 * route, all plain effects whose disposal the harness's own prompt-assembly,
 * loop, and webserver specs plus this package's behavior specs observe
 * directly; it owns no mutable cross-plugin state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
