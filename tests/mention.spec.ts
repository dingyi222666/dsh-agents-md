/**
 * `@mention` detection and task extraction: boundary rules, longest-name-first
 * claiming, and mention stripping.
 */
import { describe, expect, it } from 'vitest'
import type { AgentDefinition } from '../src/agents.ts'
import { findMention, indexOfMention, stripMentions } from '../src/mention.ts'

const reviewer: AgentDefinition = {
  name: 'reviewer',
  description: 'Reviews code for bugs',
  systemPrompt: 'You are a reviewer.',
}
const review: AgentDefinition = {
  name: 'review',
  description: 'Short-named agent',
  systemPrompt: 'You review.',
}
const writer: AgentDefinition = {
  name: 'writer',
  description: 'Writes prose',
  systemPrompt: 'You write.',
}

describe('indexOfMention', () => {
  it('matches a leading mention', () => {
    expect(indexOfMention('@reviewer 检查代码', 'reviewer')).toBe(0)
  })

  it('matches an inline CJK-surrounded mention (CJK is not a name character)', () => {
    expect(indexOfMention('帮我@reviewer看看', 'reviewer')).toBe(2)
  })

  it('rejects a longer token (no boundary after the name)', () => {
    expect(indexOfMention('@reviewerX 检查', 'reviewer')).toBe(-1)
    expect(indexOfMention('a@reviewer 检查', 'reviewer')).toBe(-1)
  })

  it('matches an @types/react-style path mention (the boundary guards only name characters)', () => {
    expect(indexOfMention('import @types/react', 'types')).toBe(7)
  })

  it('rejects a longer token (name characters continue the token)', () => {
    expect(indexOfMention('@typescript', 'types')).toBe(-1)
  })

  it('accepts a mention followed by punctuation', () => {
    expect(indexOfMention('用@reviewer!处理', 'reviewer')).toBe(1)
  })
})

describe('stripMentions', () => {
  it('removes every known mention, keeping surrounding characters', () => {
    expect(stripMentions('@reviewer 检查这段代码', [reviewer])).toBe(' 检查这段代码')
    expect(stripMentions('帮我@reviewer看看@writer', [reviewer, writer])).toBe('帮我看看')
  })

  it('leaves unknown @tokens intact', () => {
    expect(stripMentions('@unknown 你好', [reviewer])).toBe('@unknown 你好')
  })
})

describe('findMention', () => {
  it('claims the longest name first: @reviewer goes to reviewer, not review', () => {
    const mention = findMention('@reviewer 检查这段代码', [review, reviewer])
    expect(mention?.agent.name).toBe('reviewer')
    expect(mention?.task).toBe('检查这段代码')
  })

  it('falls back to the shorter agent when only it matches', () => {
    const mention = findMention('@review 检查这段代码', [review, reviewer])
    expect(mention?.agent.name).toBe('review')
    expect(mention?.task).toBe('检查这段代码')
  })

  it('strips every known mention from the task', () => {
    const mention = findMention('@reviewer 看看,顺便@writer 记录', [reviewer, writer])
    expect(mention?.agent.name).toBe('reviewer')
    expect(mention?.task).toBe('看看,顺便 记录')
  })

  it('uses the agent description as the task when the mention is the whole message', () => {
    const mention = findMention('@reviewer', [reviewer])
    expect(mention?.agent.name).toBe('reviewer')
    expect(mention?.task).toBe('Reviews code for bugs')
  })

  it('returns undefined when no agent is mentioned', () => {
    expect(findMention('普通消息', [reviewer])).toBeUndefined()
    expect(findMention('@unknown 你好', [reviewer])).toBeUndefined()
  })

  it('does not match a mention inside a longer word', () => {
    expect(findMention('这个@reviewerX是啥', [reviewer])).toBeUndefined()
  })
})
