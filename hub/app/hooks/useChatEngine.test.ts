// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// next-auth is imported by the module under test; stub it so the import graph
// resolves in the test env. `signIn` is invoked by the hook when
// resolveChatError reports `reauth: true` (verified via that flag here).
const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import { resolveChatError, resolvePreCogVerdict, buildQuotedReplyContext } from './useChatEngine'

describe('resolveChatError (chat error → bubble + reauth decision)', () => {
  it('flags a 401 for reauth (routes chat 401 through signIn like the other hooks)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })
    const { content, reauth } = resolveChatError(err)
    expect(reauth).toBe(true)
    expect(content).toMatch(/session expired/i)
  })

  it('does NOT reauth on a 500', () => {
    const err = Object.assign(new Error('boom'), { status: 500 })
    const { reauth } = resolveChatError(err)
    expect(reauth).toBe(false)
  })

  it('does NOT reauth on a network error (no status)', () => {
    const { reauth } = resolveChatError(new Error('network down'))
    expect(reauth).toBe(false)
  })

  it('surfaces the timeout copy for an AbortError without reauth', () => {
    const abort = new DOMException('aborted', 'AbortError')
    const { content, reauth } = resolveChatError(abort)
    expect(reauth).toBe(false)
    expect(content).toMatch(/took longer than expected/i)
  })

  it('gives a 413 (oversized conversation) actionable copy, not the generic bubble', () => {
    const err = Object.assign(new Error('Request too large'), { status: 413 })
    const { content, reauth } = resolveChatError(err)
    expect(reauth).toBe(false)
    expect(content).toMatch(/too large/i)
    expect(content).toMatch(/new chat/i)
    expect(content).not.toMatch(/went wrong on my end/i)
  })

  it('gives a 429 (rate limit) slow-down copy, not the generic bubble', () => {
    const err = Object.assign(new Error('Too many requests'), { status: 429 })
    const { content, reauth } = resolveChatError(err)
    expect(reauth).toBe(false)
    expect(content).toMatch(/too quickly|few seconds/i)
    expect(content).not.toMatch(/went wrong on my end/i)
  })
})

describe('buildQuotedReplyContext (Reply → context fed into the next prompt)', () => {
  it('returns an empty prefix when there is no quote (unconditional concat is safe)', () => {
    expect(buildQuotedReplyContext(null)).toBe('')
    expect(buildQuotedReplyContext(undefined)).toBe('')
    expect(buildQuotedReplyContext('')).toBe('')
    expect(buildQuotedReplyContext('   \n  ')).toBe('')
  })

  it('feeds the ENTIRE quoted message as context — no truncation', () => {
    // A long assistant reply (was previously clipped to 200 chars). The whole
    // thing must survive so it is real context for the next prompt.
    const long = 'A'.repeat(1000)
    const prefix = buildQuotedReplyContext(long)
    expect(prefix).toContain(long)
    expect(prefix).not.toContain('...')
    expect(prefix.startsWith('> Replying to: ')).toBe(true)
    expect(prefix.endsWith('\n\n')).toBe(true)
  })

  it('prefixes every line so a multi-line quote renders as one blockquote', () => {
    const prefix = buildQuotedReplyContext('line one\nline two\nline three')
    expect(prefix).toBe('> Replying to: line one\n> line two\n> line three\n\n')
  })

  it('prepends cleanly before the user message (full round-trip shape)', () => {
    const full = buildQuotedReplyContext('Send the invoice') + 'Email this to Danny'
    expect(full).toBe('> Replying to: Send the invoice\n\nEmail this to Danny')
  })
})

describe('resolvePreCogVerdict (high-stakes briefing eval → outcome)', () => {
  it('passes a genuine SUFFICIENT verdict (success path unchanged)', () => {
    expect(resolvePreCogVerdict('SUFFICIENT', true)).toEqual({ outcome: 'sufficient' })
    // Case-insensitive + tolerant of surrounding prose, matching the prior
    // `.toUpperCase().includes('SUFFICIENT')` success check.
    expect(resolvePreCogVerdict('This brief is sufficient.', true)).toEqual({ outcome: 'sufficient' })
  })

  it('treats a genuine follow-up question as insufficient (success path unchanged)', () => {
    const q = 'What should we do if the client has no email on file?'
    expect(resolvePreCogVerdict(q, true)).toEqual({ outcome: 'insufficient', question: q })
  })

  it('strips the suggestedTools metadata comment before judging the verdict', () => {
    const raw = '<!--suggestedTools:["a"]-->SUFFICIENT'
    expect(resolvePreCogVerdict(raw, true)).toEqual({ outcome: 'sufficient' })
  })

  it('strips the degraded-mode banner so it never leaks into a follow-up question', () => {
    const q = 'What should we do if the client has no email on file?'
    const raw = `⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n${q}`
    expect(resolvePreCogVerdict(raw, true)).toEqual({ outcome: 'insufficient', question: q })
  })

  it('fails OPEN when the eval produced ONLY a banner (no verdict text)', () => {
    const raw = '⚠️ *Primary model unavailable — using Claude Sonnet 4.6*\n\n'
    expect(resolvePreCogVerdict(raw, true)).toEqual({ outcome: 'unavailable' })
  })

  it('fails OPEN (unavailable, NOT a silent insufficient) when the eval response is not ok', () => {
    // A 429/5xx yields an empty/opaque stream — must never read as insufficient
    // with a blank reason. evalOk=false → proceed.
    expect(resolvePreCogVerdict('', false)).toEqual({ outcome: 'unavailable' })
    expect(resolvePreCogVerdict('anything', false)).toEqual({ outcome: 'unavailable' })
  })

  it('fails OPEN when the verdict text is empty/whitespace (e.g. aborted mid-stream)', () => {
    expect(resolvePreCogVerdict('', true)).toEqual({ outcome: 'unavailable' })
    expect(resolvePreCogVerdict('   \n  ', true)).toEqual({ outcome: 'unavailable' })
  })
})
