import { describe, it, expect } from 'vitest'
import { resolveSubject, looksLikeMessageId, NO_SUBJECT } from './gmail-subject'

describe('looksLikeMessageId', () => {
  it('recognizes an RFC 2822 Message-ID', () => {
    expect(looksLikeMessageId('<CAKx8s7dQ@mail.gmail.com>')).toBe(true)
  })

  it('does not flag ordinary subjects', () => {
    expect(looksLikeMessageId('Re: Invoice 1042')).toBe(false)
    expect(looksLikeMessageId('Question about <tags> in the doc')).toBe(false)
    expect(looksLikeMessageId('')).toBe(false)
  })
})

describe('resolveSubject', () => {
  it('passes a real subject through unchanged', () => {
    expect(resolveSubject('Re: Invoice 1042')).toBe('Re: Invoice 1042')
  })

  it('falls back to the placeholder when blank', () => {
    expect(resolveSubject(undefined)).toBe(NO_SUBJECT)
    expect(resolveSubject('')).toBe(NO_SUBJECT)
    expect(resolveSubject('   ')).toBe(NO_SUBJECT)
  })

  it('never puts a Message-ID in front of a recipient', () => {
    // The regression: replies used to go out as "Re: <CAKx...@mail.gmail.com>"
    // because the Message-ID was interpolated as if it were a subject.
    expect(resolveSubject('<CAKx8s7dQ@mail.gmail.com>')).toBe(NO_SUBJECT)
  })

  it('trims surrounding whitespace', () => {
    expect(resolveSubject('  Weekly update  ')).toBe('Weekly update')
  })
})
