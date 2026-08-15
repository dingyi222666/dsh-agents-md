/**
 * Agent definition parsing and directory loading: frontmatter extraction, field
 * validation, the strict `{{...}}` persona rule, and per-file skip degradation.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectAgents, hasStrictVariableGroup, loadAgentsDir, parseAgentFile } from '../src/agents.ts'

const VALID = `---
description: Reviews code for bugs
model: deepseek-chat
---
You are a senior code reviewer. Check for edge cases.
`

describe('hasStrictVariableGroup', () => {
  it('rejects a complete {{...}} group, which the renderer would interpolate', () => {
    expect(hasStrictVariableGroup('use the {{variable}} syntax')).toBe(true)
    expect(hasStrictVariableGroup('a {{ b }} group')).toBe(true)
  })

  it('allows a lone {{ without a later }} (literal prose) and plain text', () => {
    expect(hasStrictVariableGroup('lone {{ opener')).toBe(false)
    expect(hasStrictVariableGroup('no braces at all')).toBe(false)
  })
})

describe('parseAgentFile', () => {
  it('parses frontmatter fields and the body as the system prompt', () => {
    const agent = parseAgentFile('reviewer', VALID)
    expect(agent).toEqual({
      name: 'reviewer',
      description: 'Reviews code for bugs',
      model: 'deepseek-chat',
      systemPrompt: 'You are a senior code reviewer. Check for edge cases.',
    })
  })

  it('omits model when absent', () => {
    const agent = parseAgentFile('scout', '---\ndescription: Explores the codebase\n---\nExplore.\n')
    expect(agent).toEqual({
      name: 'scout',
      description: 'Explores the codebase',
      systemPrompt: 'Explore.',
    })
  })

  it('parses a provider route alongside the model', () => {
    const agent = parseAgentFile('frontend-review', `---
description: Reviews frontend code
provider: google
model: gemini-3-flash-preview
---
Review UI only.
`)
    expect(agent).toEqual({
      name: 'frontend-review',
      description: 'Reviews frontend code',
      provider: 'google',
      model: 'gemini-3-flash-preview',
      systemPrompt: 'Review UI only.',
    })
  })

  it('rejects an empty provider value', () => {
    expect(() => parseAgentFile('reviewer', '---\ndescription: Hi\nprovider: "  "\n---\nBody.')).toThrow(/non-empty string/)
  })

  it('rejects a name that cannot be mentioned', () => {
    expect(() => parseAgentFile('中文名', VALID)).toThrow(/not usable as a mention/)
    expect(() => parseAgentFile('has space', VALID)).toThrow(/not usable as a mention/)
  })

  it('rejects a missing frontmatter block', () => {
    expect(() => parseAgentFile('reviewer', 'plain text only')).toThrow(/missing frontmatter/)
  })

  it('rejects an empty or missing description', () => {
    expect(() => parseAgentFile('reviewer', '---\nmodel: deepseek-chat\n---\nBody.')).toThrow(/non-empty `description`/)
    expect(() => parseAgentFile('reviewer', '---\ndescription: "  "\n---\nBody.')).toThrow(/non-empty `description`/)
  })

  it('rejects an empty body', () => {
    expect(() => parseAgentFile('reviewer', '---\ndescription: Hi\n---\n   ')).toThrow(/must not be empty/)
  })

  it('rejects a body with a strict variable group, explaining why', () => {
    expect(() => parseAgentFile('reviewer', '---\ndescription: Hi\n---\nUse {{input}} here.')).toThrow(/must not contain a complete `\{\{\.\.\.\}\}` group/)
  })

  it('rejects malformed YAML frontmatter', () => {
    expect(() => parseAgentFile('reviewer', '---\ndescription: [unclosed\n---\nBody.')).toThrow(/not valid YAML/)
  })
})

describe('loadAgentsDir', () => {
  let dir: string | undefined

  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
    dir = undefined
  })

  async function withDir(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'agents-md-'))
    for (const [name, text] of Object.entries(files)) {
      await writeFile(join(dir, name), text)
    }
    return dir
  }

  it('loads every *.md in filename order and reports skipped files', async () => {
    const d = await withDir({
      'reviewer.md': VALID,
      'scout.md': '---\ndescription: Explores\n---\nExplore.\n',
      'broken.md': 'no frontmatter',
      'notes.txt': '---\ndescription: ignored\n---\nIgnored.',
    })
    const result = await loadAgentsDir(d)
    expect(result.agents.map(agent => agent.name)).toEqual(['reviewer', 'scout'])
    expect(result.skipped).toEqual([
      { file: 'broken.md', reason: expect.stringMatching(/missing frontmatter/) as string },
    ])
  })

  it('skips a duplicate agent name (case-insensitive), keeping the first', () => {
    // macOS folders are case-insensitive, so the duplicate pair is staged
    // directly — the same directory listing a Linux user sees. 'Reviewer.md'
    // sorts before 'reviewer.md', so the uppercase definition wins.
    const result = collectAgents([
      { file: 'Reviewer.md', text: '---\ndescription: Duplicate\n---\nDupe.\n' },
      { file: 'reviewer.md', text: VALID },
    ])
    expect(result.agents.map(agent => agent.name)).toEqual(['Reviewer'])
    expect(result.skipped).toEqual([
      { file: 'reviewer.md', reason: expect.stringMatching(/duplicate agent name/) as string },
    ])
  })

  it('treats a missing directory as an empty roster', async () => {
    const result = await loadAgentsDir(join(tmpdir(), 'agents-md-missing-' + Math.random()))
    expect(result).toEqual({ agents: [], skipped: [] })
  })
})
