import { describe, it, expect } from 'vitest'
import { needsInternalSearch, needsExternalSearch, isTrivialMessage } from '@/lib/search-routing'

describe('needsInternalSearch', () => {
  it('matches genuine internal-data signals', () => {
    expect(needsInternalSearch('What are our KPIs this week?')).toBe(true)
    expect(needsInternalSearch('show my open issues')).toBe(true)
    expect(needsInternalSearch('check the paperclip workspace')).toBe(true)
    expect(needsInternalSearch('what is the project status for RxFit')).toBe(true)
  })

  it('does NOT false-positive on substrings (the original bug)', () => {
    // 'our' must not match 'hour' / 'source'
    expect(needsInternalSearch('I have an hour to spare')).toBe(false)
    expect(needsInternalSearch('look at the source code')).toBe(false)
    // 'team' must not match 'steam'
    expect(needsInternalSearch('I love a hot bowl of steam buns')).toBe(false)
  })

  it('returns false for unrelated chit-chat', () => {
    expect(needsInternalSearch('what is the capital of France')).toBe(false)
  })
})

describe('needsExternalSearch', () => {
  it('matches genuine external/web signals', () => {
    expect(needsExternalSearch('search for the latest SEO trends')).toBe(true)
    expect(needsExternalSearch('who is the CEO of Stripe')).toBe(true)
    expect(needsExternalSearch('compare with our competitors')).toBe(true)
    expect(needsExternalSearch('read https://example.com/post')).toBe(true)
  })

  it('does NOT false-positive on substrings', () => {
    // 'seo' must not match 'museo'
    expect(needsExternalSearch('we visited a museo in Madrid')).toBe(false)
  })

  it('returns false for purely internal requests', () => {
    expect(needsExternalSearch('summarize my tasks for today')).toBe(false)
  })
})

describe('isTrivialMessage', () => {
  it('returns true for short greetings/acks', () => {
    expect(isTrivialMessage('thanks')).toBe(true)
    expect(isTrivialMessage('Thanks!')).toBe(true)
    expect(isTrivialMessage('ok')).toBe(true)
    expect(isTrivialMessage('got it')).toBe(true)
    expect(isTrivialMessage('👍')).toBe(true)
    expect(isTrivialMessage('  hey  ')).toBe(true)
    expect(isTrivialMessage('thank you')).toBe(true)
  })

  it('returns false for any message containing a question mark', () => {
    expect(isTrivialMessage("what's next?")).toBe(false)
    expect(isTrivialMessage('ok?')).toBe(false)
  })

  it('returns false for messages longer than 3 words', () => {
    expect(isTrivialMessage('summarize the Q3 revenue report')).toBe(false)
    expect(isTrivialMessage('thanks for the detailed audit report')).toBe(false)
  })

  it('returns false when the message carries an internal/external search signal', () => {
    // 'my' is an internal signal → not trivial even though it is short
    expect(isTrivialMessage('show my issues')).toBe(false)
    // 'seo' is an external signal
    expect(isTrivialMessage('seo trends')).toBe(false)
  })

  it('returns false for empty/whitespace messages', () => {
    expect(isTrivialMessage('')).toBe(false)
    expect(isTrivialMessage('   ')).toBe(false)
  })

  it('returns false for ordinary short non-greeting messages', () => {
    expect(isTrivialMessage('the revenue')).toBe(false)
  })
})
