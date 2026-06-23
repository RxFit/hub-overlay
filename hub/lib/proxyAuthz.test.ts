import { describe, it, expect } from 'vitest'
import { requiredWriteRank, canWrite, ROLE_RANK } from '@/lib/proxyAuthz'

const AGENT = '/api/agents/abc12345-0000-0000-0000-000000000000'
const COMPANY = '/api/companies/abc12345-0000-0000-0000-000000000000'
const ISSUE = '/api/issues/abc12345-0000-0000-0000-000000000000'

describe('requiredWriteRank', () => {
  it('treats reads as unrestricted by role tier', () => {
    expect(requiredWriteRank('GET', '/api/issues')).toBe(0)
    expect(requiredWriteRank('GET', COMPANY)).toBe(0)
    expect(requiredWriteRank('HEAD', '/api/agents')).toBe(0)
  })

  it('requires superadmin to delete an agent (P1-6 tightening)', () => {
    expect(requiredWriteRank('DELETE', AGENT)).toBe(ROLE_RANK.superadmin)
  })

  it('requires admin to delete a workspace or issue', () => {
    expect(requiredWriteRank('DELETE', COMPANY)).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('DELETE', ISSUE)).toBe(ROLE_RANK.admin)
  })

  it('requires admin to PATCH an issue (assign / change state)', () => {
    expect(requiredWriteRank('PATCH', ISSUE)).toBe(ROLE_RANK.admin)
  })

  it('requires admin to PATCH an agent (restart)', () => {
    expect(requiredWriteRank('PATCH', AGENT)).toBe(ROLE_RANK.admin)
  })

  it('requires admin to create an agent', () => {
    expect(requiredWriteRank('POST', '/api/agents')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('POST', `${COMPANY}/agents`)).toBe(ROLE_RANK.admin)
  })

  it('requires admin to create a company', () => {
    expect(requiredWriteRank('POST', '/api/companies')).toBe(ROLE_RANK.admin)
  })

  it('lets staff create an issue', () => {
    expect(requiredWriteRank('POST', '/api/issues')).toBe(ROLE_RANK.staff)
  })
})

describe('canWrite', () => {
  it('blocks a scoped staff user from admin-tier mutations', () => {
    // The core P0-1 vulnerability: staff calling PATCH/POST directly.
    expect(canWrite('staff', 'PATCH', ISSUE)).toBe(false)
    expect(canWrite('staff', 'PATCH', AGENT)).toBe(false)
    expect(canWrite('staff', 'POST', '/api/agents')).toBe(false)
  })

  it('allows staff to create issues but not to delete', () => {
    expect(canWrite('staff', 'POST', '/api/issues')).toBe(true)
    expect(canWrite('staff', 'DELETE', ISSUE)).toBe(false)
  })

  it('blocks admin from deleting an agent (superadmin only)', () => {
    expect(canWrite('admin', 'DELETE', AGENT)).toBe(false)
    expect(canWrite('superadmin', 'DELETE', AGENT)).toBe(true)
  })

  it('blocks onboarding users from any write', () => {
    expect(canWrite('onboarding', 'POST', '/api/issues')).toBe(false)
    expect(canWrite('onboarding', 'GET', '/api/issues')).toBe(true)
  })

  it('treats an unknown role as the lowest rank', () => {
    expect(canWrite('mystery', 'POST', '/api/issues')).toBe(false)
  })
})
