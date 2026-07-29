import { describe, it, expect } from 'vitest'
import {
  selectSpacesToSearch,
  messageMatches,
  queryTerms,
  RETRIEVAL_LIMITS,
} from './retrieval-tools'
import { escapeDriveQueryTerm } from './google'
import type { ChatSpace } from './google'

const space = (displayName: string, name = `spaces/${displayName.replace(/\W/g, '')}`): ChatSpace =>
  ({ name, displayName, type: 'ROOM', spaceType: 'SPACE' })

describe('selectSpacesToSearch', () => {
  const spaces = [space('Nuvita'), space('Corporate Wellness'), space('RxFit Ops'), space('Vendors')]

  it('matches a named space case-insensitively', () => {
    expect(selectSpacesToSearch(spaces, 'nuvita').map(s => s.displayName)).toEqual(['Nuvita'])
  })

  it('matches on a substring, as a person would refer to a space', () => {
    expect(selectSpacesToSearch(spaces, 'wellness').map(s => s.displayName)).toEqual(['Corporate Wellness'])
  })

  it('returns NOTHING when a named space matches nothing', () => {
    // Falling back to every space would answer a Nuvita question with unrelated
    // messages — worse than finding nothing.
    expect(selectSpacesToSearch(spaces, 'acme corp')).toEqual([])
  })

  it('falls back to the visible spaces when no space is named', () => {
    expect(selectSpacesToSearch(spaces, undefined)).toHaveLength(4)
  })

  it('respects the scan limit', () => {
    const many = Array.from({ length: 20 }, (_, i) => space(`Space ${i}`))
    expect(selectSpacesToSearch(many, undefined)).toHaveLength(RETRIEVAL_LIMITS.chatSpacesScanned)
  })

  it('treats a blank space filter as "no filter"', () => {
    expect(selectSpacesToSearch(spaces, '   ')).toHaveLength(4)
  })

  it('can return several spaces for an ambiguous name', () => {
    const dupes = [space('Nuvita Ops'), space('Nuvita Billing'), space('Other')]
    expect(selectSpacesToSearch(dupes, 'nuvita')).toHaveLength(2)
  })
})

describe('queryTerms', () => {
  it('strips filler words that would match everything', () => {
    expect(queryTerms('who is our account manager')).toEqual(['account', 'manager'])
  })

  it('keeps emails and dotted identifiers intact', () => {
    expect(queryTerms('contact sarah@nuvita.com')).toContain('sarah@nuvita.com')
  })

  it('drops very short tokens', () => {
    expect(queryTerms('is it ok')).toEqual([])
  })

  it('deduplicates repeated terms', () => {
    expect(queryTerms('pricing pricing PRICING')).toEqual(['pricing'])
  })

  it('lowercases for case-insensitive matching', () => {
    expect(queryTerms('Nuvita Contract')).toEqual(['nuvita', 'contract'])
  })
})

describe('messageMatches', () => {
  it('matches any term, not the whole phrase', () => {
    // "your manager on the account is Dana" should surface for "account manager".
    expect(messageMatches('Your manager on the account is Dana', ['account', 'manager'])).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(messageMatches('ACCOUNT details attached', ['account'])).toBe(true)
  })

  it('rejects a message with no matching term', () => {
    expect(messageMatches('lunch at noon?', ['account', 'manager'])).toBe(false)
  })

  it('matches everything when there are no usable terms', () => {
    // A query that reduced to nothing must not silently return zero results.
    expect(messageMatches('anything at all', [])).toBe(true)
  })

  it('handles an empty message body', () => {
    expect(messageMatches('', ['account'])).toBe(false)
  })
})

describe('escapeDriveQueryTerm', () => {
  it("escapes an apostrophe that would otherwise terminate the query literal", () => {
    expect(escapeDriveQueryTerm("Danny's notes")).toBe("Danny\\'s notes")
  })

  it('escapes backslashes before quotes so the escapes are not themselves escaped', () => {
    expect(escapeDriveQueryTerm('a\\b')).toBe('a\\\\b')
    expect(escapeDriveQueryTerm("a\\'b")).toBe("a\\\\\\'b")
  })

  it('leaves an ordinary term untouched', () => {
    expect(escapeDriveQueryTerm('Nuvita partnership')).toBe('Nuvita partnership')
  })
})
