// @vitest-environment jsdom
/**
 * dsh-agent-book browser half: source registration (duplicate-name proof) +
 * fiber-teardown removal (HMR safety) against a fake trigger pipeline, then
 * the source behavior contract driven directly on the captured source: the
 * roster fetch (candidates filter, lexicon warm-up notification, failure
 * degradation), the plain-text pick outcome, and the reference codec.
 *
 * The trigger pipeline is a stub with the service's real seat rule (unique
 * (trigger, name)); the published lib/client.js is a loader-wrapped browser
 * bundle and cannot be imported in a Node/jsdom test. The locale face is a
 * stub too — the group label only needs to be a string here.
 */
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, inject, ROSTER_PATH } from '../src/client/index.ts'

const ROSTER = [
  { name: 'reviewer', description: 'Reviews code for bugs', model: 'deepseek-chat' },
  { name: 'writer', description: 'Writes prose' },
]

const proj = (id: string): ClientSessionContext => ({ sessionId: id as SessionId })

/** Fake locale face: registers nothing, binds every key to itself. */
function stubLocale(): { register: () => () => void; bind: () => (key: string) => string } {
  return {
    register: () => () => {},
    bind: () => (key: string) => (key === 'group' ? '智能体' : key),
  }
}

/**
 * Fake trigger pipeline with the service's seat rule: one (trigger, name)
 * per source; a duplicate registration throws, disposal frees the seat.
 */
function stubInputTriggers(): {
  registerSource: (src: InputTriggerSource) => () => void
  seats: () => string[]
  captured: () => InputTriggerSource | undefined
} {
  const seats = new Set<string>()
  let captured: InputTriggerSource | undefined
  return {
    registerSource: (src: InputTriggerSource) => {
      const key = `${src.trigger}${src.name}`
      if (seats.has(key)) throw new Error(`slash source "${key}" is already registered`)
      seats.add(key)
      captured = src
      return () => { seats.delete(key) }
    },
    seats: () => [...seats],
    captured: () => captured,
  }
}

/** Boot the plugin over fake trigger and locale faces. */
async function boot(): Promise<{ source: InputTriggerSource; triggers: ReturnType<typeof stubInputTriggers> }> {
  const ctx = new Context()
  const triggers = stubInputTriggers()
  ctx.provide('inputTriggers', { registerSource: triggers.registerSource })
  ctx.provide('locale', stubLocale() as never)
  await ctx.plugin({ inject: [...inject], apply }).await()
  return { source: triggers.captured()!, triggers }
}

function jsonResponse(body: unknown): { ok: boolean; json: () => Promise<unknown> } {
  return { ok: true, json: async () => body }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['inputTriggers', 'locale'])
  })

  it('registers the "@" agent source; disposal frees the name (HMR safety)', async () => {
    const ctx = new Context()
    const triggers = stubInputTriggers()
    ctx.provide('inputTriggers', { registerSource: triggers.registerSource })
    ctx.provide('locale', stubLocale() as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(triggers.seats()).toEqual(['@智能体'])
    const rival = {
      trigger: '@' as const,
      name: '智能体',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    }
    expect(() => triggers.registerSource(rival)).toThrow(/already registered/)
    await fiber.dispose()
    expect(triggers.seats()).toEqual([])
    expect(() => triggers.registerSource(rival)).not.toThrow()
  })
})

describe('roster source', () => {
  it('serves candidates from the fetched roster, filtered by name or description', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ROSTER)))
    const { source } = await boot()
    source.warm?.(proj('s'))
    await vi.waitFor(() => { expect(source.lexicon?.(proj('s'))).toEqual(['reviewer', 'writer']) })
    const all = await source.candidates(proj('s'), { query: '', position: 'inline', signal: new AbortController().signal })
    expect(all).toEqual([
      { name: 'reviewer', description: 'Reviews code for bugs' },
      { name: 'writer', description: 'Writes prose' },
    ])
    const filtered = await source.candidates(proj('s'), { query: 'writ', position: 'inline', signal: new AbortController().signal })
    expect(filtered).toEqual([{ name: 'writer', description: 'Writes prose' }])
    expect(fetch).toHaveBeenCalledWith(ROSTER_PATH, { cache: 'no-store' })
  })

  it('is candidate-less and lexicon-warm (empty) when the roster fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const { source } = await boot()
    source.warm?.(proj('s'))
    await vi.waitFor(() => { expect(source.lexicon?.(proj('s'))).toEqual([]) })
    await expect(source.candidates(proj('s'), { query: '', position: 'inline', signal: new AbortController().signal }))
      .resolves.toEqual([])
  })

  it('reports the lexicon as not warm before the fetch settles, then notifies listeners', async () => {
    let resolveFetch!: (value: unknown) => void
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise(resolve => { resolveFetch = resolve })))
    const { source } = await boot()
    const session = proj('s')
    expect(source.lexicon?.(session)).toBeUndefined()
    let notified = 0
    const off = source.subscribeLexicon!(session, () => { notified += 1 })
    source.warm?.(session)
    expect(notified).toBe(0)
    resolveFetch(jsonResponse(ROSTER))
    await vi.waitFor(() => { expect(notified).toBe(1) })
    expect(source.lexicon?.(session)).toEqual(['reviewer', 'writer'])
    off()
  })

  it('onPick inserts the literal @name text with a closing space', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(ROSTER)))
    const { source } = await boot()
    const outcome = source.onPick({
      candidate: { name: 'reviewer' },
      session: proj('s'),
      position: 'inline',
      via: 'menu',
      span: { start: 0, end: 9, draftRev: 1 },
    })
    expect(outcome).toEqual({ text: '@reviewer ' })
  })

  it('codec projects clipboard @name and serializes the same literal', async () => {
    const { source } = await boot()
    expect(source.codec!.clipboardText('reviewer')).toBe('@reviewer')
    await expect(source.codec!.serialize('reviewer', new AbortController().signal)).resolves.toBe('@reviewer')
  })

  it('never participates in command adjudication', async () => {
    const { source } = await boot()
    expect('matchSpace' in source && source.matchSpace !== undefined).toBe(false)
    expect('matchEnter' in source && source.matchEnter !== undefined).toBe(false)
  })
})
