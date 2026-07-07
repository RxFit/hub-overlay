import { describe, it, expect } from 'vitest'
import { extractEmail, replySubject } from './email-address'

describe('extractEmail', () => {
  it('passes a plain address through unchanged', () => {
    expect(extractEmail('billing@acme.com')).toBe('billing@acme.com')
  })

  it('extracts the address from a Name <addr> header', () => {
    expect(extractEmail('Acme Billing <billing@acme.com>')).toBe('billing@acme.com')
  })

  it('handles a quoted display name containing a comma', () => {
    expect(extractEmail('"Lopez, Maria" <m@x.com>')).toBe('m@x.com')
  })

  it('trims whitespace padding', () => {
    expect(extractEmail('  billing@acme.com  ')).toBe('billing@acme.com')
    expect(extractEmail('Acme Billing < billing@acme.com >')).toBe('billing@acme.com')
  })
})

describe('replySubject', () => {
  it('prefixes a plain subject with Re:', () => {
    expect(replySubject('Invoice #42')).toBe('Re: Invoice #42')
  })

  it('leaves an existing Re: subject unchanged (no doubling)', () => {
    expect(replySubject('Re: Invoice #42')).toBe('Re: Invoice #42')
  })

  it('does not double regardless of Re: casing', () => {
    expect(replySubject('RE: hello')).toBe('RE: hello')
    expect(replySubject('re: hello')).toBe('re: hello')
  })

  it('trims surrounding whitespace before deciding', () => {
    expect(replySubject('  Re: hello  ')).toBe('Re: hello')
    expect(replySubject('  hello  ')).toBe('Re: hello')
  })

  it('falls back to (no subject) for empty input', () => {
    expect(replySubject('')).toBe('Re: (no subject)')
    expect(replySubject('   ')).toBe('Re: (no subject)')
  })
})
