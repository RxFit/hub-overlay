import { describe, it, expect } from 'vitest'
import { extractEmail } from './email-address'

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
