// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// next-auth is imported by the module under test; stub it so the import graph
// resolves in the test env. `signIn` is invoked by the hook when
// resolveChatError reports `reauth: true` (verified via that flag here).
const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import { resolveChatError, resolvePreCogVerdict } from './useChatEngine'

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
