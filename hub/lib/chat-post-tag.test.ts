import { describe, it, expect } from 'vitest'
import { HUB_CHAT_POST_TAG, tagHubChatPost, isHubTaggedPost } from './chat-post-tag'

/**
 * lib/chat-post-tag.ts — the Hub→Google Chat tagging convention.
 *
 * The literal tag is a cross-repo CONTRACT (external agents match on it
 * exactly), so the tests pin the string itself, the placement (own final
 * line), idempotency on retries, and the recognition predicate both ways.
 */

describe('the tagging convention', () => {
  it('the tag literal is pinned — rewording it breaks external listeners silently', () => {
    expect(HUB_CHAT_POST_TAG).toBe('— via HUB')
  })

  it('appends the tag on its own final line', () => {
    expect(tagHubChatPost('Q3 report is ready: https://doc')).toBe('Q3 report is ready: https://doc\n\n— via HUB')
  })

  it('is idempotent — a retried send never double-tags', () => {
    const once = tagHubChatPost('hello team')
    expect(tagHubChatPost(once)).toBe(once)
  })

  it('trailing whitespace does not defeat idempotency or recognition', () => {
    expect(tagHubChatPost('msg\n\n— via HUB\n  ')).toBe('msg\n\n— via HUB')
    expect(isHubTaggedPost('msg\n\n— via HUB \n')).toBe(true)
  })

  it('recognizes tagged posts and rejects untagged or mid-text mentions', () => {
    expect(isHubTaggedPost(tagHubChatPost('anything'))).toBe(true)
    expect(isHubTaggedPost('a normal human message')).toBe(false)
    expect(isHubTaggedPost('discussing the — via HUB tag convention here')).toBe(false)
  })
})
