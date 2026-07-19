import { describe, it, expect } from 'vitest'
import { requiredWriteRank, canWrite, ROLE_RANK } from '@/lib/proxyAuthz'

const AGENT = '/api/agents/abc12345-0000-0000-0000-000000000000'
const COMPANY = '/api/companies/abc12345-0000-0000-0000-000000000000'
const ISSUE = '/api/issues/abc12345-0000-0000-0000-000000000000'

// Same UUIDs, UPPERCASE hex — Postgres resolves these to the identical rows.
const AGENT_UPPER = '/api/agents/ABC12345-0000-0000-0000-00000000000A'
const COMPANY_UPPER = '/api/companies/ABC12345-0000-0000-0000-00000000000A'
const ISSUE_UPPER = '/api/issues/ABC12345-0000-0000-0000-00000000000A'

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

  it('lets staff comment on an issue (right-panel Phase 2)', () => {
    expect(requiredWriteRank('POST', '/api/issues/abc-123/comments')).toBe(ROLE_RANK.staff)
    // Uppercase-UUID form must resolve identically (case-insensitive matching)
    expect(requiredWriteRank('POST', '/api/issues/ABC-123/comments')).toBe(ROLE_RANK.staff)
    // Deeper subpaths are NOT comments and fall closed to admin
    expect(requiredWriteRank('POST', '/api/issues/abc-123/comments/extra')).toBe(ROLE_RANK.admin)
  })

  it('requires admin for agent lifecycle actions (wake/pause/resume/clear-error)', () => {
    for (const action of ['wakeup', 'pause', 'resume', 'clear-error']) {
      expect(requiredWriteRank('POST', `/api/agents/abc-123/${action}`)).toBe(ROLE_RANK.admin)
    }
    // Unlisted agent subpath writes stay fail-closed at admin
    expect(requiredWriteRank('POST', '/api/agents/abc-123/terminate')).toBe(ROLE_RANK.admin)
  })

  it('lets staff fire an existing routine, but requires admin to manage routines (Phase 3)', () => {
    expect(requiredWriteRank('POST', '/api/routines/abc-123/run')).toBe(ROLE_RANK.staff)
    expect(requiredWriteRank('POST', '/api/routines/ABC-123/run')).toBe(ROLE_RANK.staff)
    expect(requiredWriteRank('PATCH', '/api/routines/abc-123')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('DELETE', '/api/routines/abc-123')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('POST', '/api/companies/abc-123/routines')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('POST', '/api/routines/abc-123/triggers')).toBe(ROLE_RANK.admin)
    // routine-trigger mutations stay fail-closed at admin
    expect(requiredWriteRank('PATCH', '/api/routine-triggers/abc-123')).toBe(ROLE_RANK.admin)
  })

  it('requires admin for goal CRUD (Phase 3)', () => {
    expect(requiredWriteRank('POST', '/api/companies/abc-123/goals')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PATCH', '/api/goals/abc-123')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('DELETE', '/api/goals/abc-123')).toBe(ROLE_RANK.admin)
  })

  it('requires admin for workspace runtime services and workspace CRUD (Phase 4)', () => {
    for (const action of ['start', 'stop', 'restart']) {
      expect(requiredWriteRank('POST', `/api/projects/abc-1/workspaces/def-2/runtime-services/${action}`)).toBe(ROLE_RANK.admin)
    }
    expect(requiredWriteRank('POST', '/api/projects/abc-1/workspaces')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PATCH', '/api/projects/abc-1/workspaces/def-2')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('DELETE', '/api/projects/abc-1/workspaces/def-2')).toBe(ROLE_RANK.admin)
    // Unknown runtime action falls closed to admin too
    expect(requiredWriteRank('POST', '/api/projects/abc-1/workspaces/def-2/runtime-services/nuke')).toBe(ROLE_RANK.admin)
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

/* ════════════════════════════════════════════════════════════════════════════
   P0 — uppercase-UUID must NOT defeat the role gate, and unrecognized writes
   must fail CLOSED (not silently default to staff). This was a live privilege
   escalation: a case-sensitive matcher let `DELETE /api/companies/<UPPERCASE>`
   fall through to the old staff default while Postgres still resolved the row.
   ════════════════════════════════════════════════════════════════════════════ */
describe('requiredWriteRank — case-insensitive matching (P0 escalation fix)', () => {
  it('requires the SAME rank for an uppercase-UUID path as its lowercase form', () => {
    expect(requiredWriteRank('DELETE', COMPANY_UPPER)).toBe(requiredWriteRank('DELETE', COMPANY))
    expect(requiredWriteRank('DELETE', COMPANY_UPPER)).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('DELETE', AGENT_UPPER)).toBe(ROLE_RANK.superadmin)
    expect(requiredWriteRank('DELETE', ISSUE_UPPER)).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PATCH', ISSUE_UPPER)).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PATCH', AGENT_UPPER)).toBe(ROLE_RANK.admin)
  })

  it('still treats POST /api/issues as a staff write regardless of path case', () => {
    expect(requiredWriteRank('POST', '/api/issues')).toBe(ROLE_RANK.staff)
    expect(requiredWriteRank('POST', '/API/ISSUES')).toBe(ROLE_RANK.staff)
  })

  it('fails CLOSED (admin, never staff) for an unrecognized write path', () => {
    // Previously these fell through to the staff default — the escalation vector.
    expect(requiredWriteRank('POST', '/api/runs')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PATCH', '/api/companies/abc/settings')).toBe(ROLE_RANK.admin)
    expect(requiredWriteRank('PUT', '/api/agents')).toBe(ROLE_RANK.admin)
  })
})

describe('canWrite — uppercase-UUID escalation is blocked, legit access preserved', () => {
  it('blocks a staff user from an uppercase-UUID DELETE/PATCH exactly as the lowercase path', () => {
    expect(canWrite('staff', 'DELETE', COMPANY_UPPER)).toBe(false)
    expect(canWrite('staff', 'DELETE', COMPANY)).toBe(false)
    expect(canWrite('staff', 'DELETE', ISSUE_UPPER)).toBe(false)
    expect(canWrite('staff', 'PATCH', ISSUE_UPPER)).toBe(false)
    expect(canWrite('staff', 'DELETE', AGENT_UPPER)).toBe(false)
  })

  it('still allows a legitimate admin/superadmin on the uppercase-UUID path', () => {
    expect(canWrite('admin', 'DELETE', COMPANY_UPPER)).toBe(true)
    expect(canWrite('admin', 'DELETE', ISSUE_UPPER)).toBe(true)
    expect(canWrite('admin', 'DELETE', AGENT_UPPER)).toBe(false) // agent delete = superadmin
    expect(canWrite('superadmin', 'DELETE', AGENT_UPPER)).toBe(true)
  })

  it('blocks staff from an unrecognized (fail-closed) write', () => {
    expect(canWrite('staff', 'POST', '/api/runs')).toBe(false)
    expect(canWrite('admin', 'POST', '/api/runs')).toBe(true)
  })
})
