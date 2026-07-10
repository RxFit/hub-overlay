import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/paperclip/[...path] — P0 uppercase-UUID escalation, at the route boundary.

   A scoped `staff` user calling DELETE on a company path must be rejected with
   403 by the role gate REGARDLESS of UUID case. Before the fix, an uppercase
   UUID failed the case-sensitive matcher, fell through to the staff default, and
   the destructive request was forwarded upstream (Postgres resolved the row
   case-insensitively). The role gate returns BEFORE any upstream fetch, so this
   test needs no Paperclip network mock — reaching a 403 is the whole assertion.
   ════════════════════════════════════════════════════════════════════════════ */

process.env.PAPERCLIP_BASE_URL = 'https://paperclip.test'

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
// Guard: if the role gate ever let the request through, this throws and the test
// fails loudly rather than silently making a network call.
vi.mock('@/lib/paperclipSession', () => ({
  getPaperclipAuthHeaders: vi.fn(async () => {
    throw new Error('upstream must not be reached for a blocked staff mutation')
  }),
  clearPaperclipSession: vi.fn(),
}))

import { DELETE } from '@/app/api/paperclip/[...path]/route'

const UPPER = 'ABC12345-0000-0000-0000-00000000000A'
const LOWER = 'abc12345-0000-0000-0000-00000000000a'

function del(pathSegments: string[]) {
  const req = new NextRequest(`http://localhost/api/paperclip/${pathSegments.join('/')}`, {
    method: 'DELETE',
  })
  return DELETE(req, { params: { path: pathSegments } })
}

beforeEach(() => {
  state.session = null
})

describe('DELETE /api/paperclip/companies/<uuid> — staff is blocked in either case', () => {
  it('403s a staff user on an UPPERCASE-UUID company (escalation fixed)', async () => {
    state.session = { user: { email: 's@x.com', role: 'staff', assignedProjects: ['*'] } }
    const res = await del(['companies', UPPER])
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/insufficient role/i)
  })

  it('403s a staff user on the lowercase-UUID company (same outcome)', async () => {
    state.session = { user: { email: 's@x.com', role: 'staff', assignedProjects: ['*'] } }
    const res = await del(['companies', LOWER])
    expect(res.status).toBe(403)
  })

  it('401s when unauthenticated', async () => {
    state.session = null
    const res = await del(['companies', UPPER])
    expect(res.status).toBe(401)
  })
})
