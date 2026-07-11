import { describe, expect, it } from 'vitest'
import { buildAccessRequestMailto } from './access-request'

describe('buildAccessRequestMailto (actionable access-request dead-end escape)', () => {
  it('builds a mailto to the given admin with a pre-filled subject and body', () => {
    const url = buildAccessRequestMailto({ adminEmail: 'admin@example.com', role: 'staff' })
    expect(url.startsWith('mailto:admin@example.com?')).toBe(true)
    expect(url).toContain(`subject=${encodeURIComponent('Hub access request')}`)
    // Role is woven into the (encoded) body for context.
    expect(decodeURIComponent(url)).toContain('current role is staff')
  })

  it('leaves the recipient blank when no admin email is configured (client still opens a draft)', () => {
    // No adminEmail arg; tenant config has no adminContactEmail set by default.
    const url = buildAccessRequestMailto({ role: 'onboarding' })
    expect(url.startsWith('mailto:?')).toBe(true)
  })

  it('includes the reason when provided', () => {
    const url = buildAccessRequestMailto({ adminEmail: 'a@b.co', reason: 'Execution Feed locked' })
    expect(decodeURIComponent(url)).toContain('Execution Feed locked')
  })

  it('encodes the subject/body (no raw spaces that would break the mailto)', () => {
    const url = buildAccessRequestMailto({ adminEmail: 'a@b.co' })
    expect(url).not.toMatch(/\ssubject|body=[^&]*\s/)
    expect(url).toContain('%20')
  })
})
