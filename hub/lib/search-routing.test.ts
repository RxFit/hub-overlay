import { describe, it, expect } from 'vitest'
import { needsInternalSearch, needsExternalSearch } from '@/lib/search-routing'

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
