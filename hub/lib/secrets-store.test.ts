import { describe, it, expect } from 'vitest'
import { resolveWorkspaceId, BLOCKED_KEY_NAMES, KEY_NAME_RE } from './secrets-store'

/* ════════════════════════════════════════════════════════════════════════════
   Workspace scoping — the authorization boundary for credential storage.

   This logic was previously private to app/api/settings/keys/route.ts and
   therefore untested: a route.ts may export only HTTP handlers, so the only
   way to test it was to move it. It is the function that decides which
   workspace a write lands in, so it is worth pinning precisely.
   ════════════════════════════════════════════════════════════════════════════ */

describe('resolveWorkspaceId', () => {
  it('lets superadmin target any workspace', () => {
    expect(resolveWorkspaceId({ role: 'superadmin', assignedProjects: [] }, 'anything')).toBe('anything')
  })

  it('lets a wildcard admin target any workspace', () => {
    expect(resolveWorkspaceId({ role: 'admin', assignedProjects: ['*'] }, 'c9')).toBe('c9')
  })

  it('allows an explicitly assigned workspace', () => {
    expect(resolveWorkspaceId({ role: 'admin', assignedProjects: ['c1', 'c2'] }, 'c2')).toBe('c2')
  })

  /* The behaviour change from the Paperclip route. It used to fall through to
     assignedProjects[0] and return 200, filing the write under a workspace the
     operator never chose — invisible because the UI re-queries by the selected
     id and shows the key as still missing. */
  it('REFUSES an unassigned workspace instead of silently redirecting', () => {
    expect(resolveWorkspaceId({ role: 'admin', assignedProjects: ['c1'] }, 'c-other')).toBeNull()
  })

  it('falls back to the first assigned workspace only when none was requested', () => {
    expect(resolveWorkspaceId({ role: 'admin', assignedProjects: ['c1', 'c2'] })).toBe('c1')
  })

  it('returns null when an unassigned user requests nothing', () => {
    expect(resolveWorkspaceId({ role: 'staff', assignedProjects: [] })).toBeNull()
  })

  it('treats a missing role/projects as unauthorized rather than throwing', () => {
    expect(resolveWorkspaceId({}, 'c1')).toBeNull()
  })
})

describe('key name policy', () => {
  it('accepts SCREAMING_SNAKE names', () => {
    expect(KEY_NAME_RE.test('STRIPE_SECRET_KEY')).toBe(true)
    expect(KEY_NAME_RE.test('A1')).toBe(true)
  })

  it('rejects lowercase, leading digits, and punctuation', () => {
    for (const bad of ['stripe_key', '1KEY', 'MY-KEY', 'MY KEY', '', '_KEY']) {
      expect(KEY_NAME_RE.test(bad)).toBe(false)
    }
  })

  it('blocks keys that would compromise the Hub itself', () => {
    // Hub-owned storage adds the at-rest key to the list: letting an operator
    // store SECRET_ENCRYPTION_KEY through this UI would let them overwrite the
    // key that seals every other row.
    for (const name of ['NEXTAUTH_SECRET', 'SECRET_ENCRYPTION_KEY', 'DATABASE_URL']) {
      expect(BLOCKED_KEY_NAMES).toContain(name)
    }
  })
})
