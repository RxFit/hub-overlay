// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

// next-auth is imported by the module under test; stub it so the import graph
// resolves in the test env. `signIn` is invoked by the hook when
// resolveChatError reports `reauth: true` (verified via that flag here).
const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import { resolveChatError } from './useChatEngine'

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
