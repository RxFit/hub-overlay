import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/paperclip/[...path] — protected-workspace DELETE guard (SAFETY).

   A protected company can NEVER be deleted, by ANY role (incl. superadmin) and
   regardless of UUID case. The guard returns 403 { code: PROTECTED_WORKSPACE }
   BEFORE forwarding upstream and INDEPENDENT of the admin role gate. Deletes of
   non-protected companies still pass the guard (they reach the normal forward
   path), and deletes of issues/agents are unaffected.

   The protected id is supplied via PROTECTED_COMPANY_IDS (read lazily by the
   guard). The forward-path machinery is stubbed so a request that PASSES the
   guard is observable: it reaches the mocked upstream fetch and returns 200.
   ════════════════════════════════════════════════════════════════════════════ */

process.env.PAPERCLIP_BASE_URL = 'https://paperclip.test'
const PROTECTED = 'dddddddd-0000-0000-0000-00000000000d'
const PROTECTED_UPPER = PROTECTED.toUpperCase()
const NON_PROTECTED = 'eeeeeeee-0000-0000-0000-00000000000e'
process.env.PROTECTED_COMPANY_IDS = PROTECTED

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))
vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
// Forward-path machinery: stubbed so a request that PASSES the guard reaches
// the mocked upstream fetch (returns 200) rather than blowing up.
vi.mock('@/lib/paperclipSession', () => ({
  getPaperclipAuthHeaders: vi.fn(async () => ({})),
  clearPaperclipSession: vi.fn(),
}))
vi.mock('@/lib/circuit-breaker', () => ({
  breaker: { execute: (_key: string, fn: () => unknown) => fn() },
}))
vi.mock('@/lib/retry', () => ({ withRetry: (fn: () => unknown) => fn() }))
vi.mock('@/lib/loop-detector', () => ({ loopDetector: { detectAndRecord: vi.fn() } }))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'test' }))

import { DELETE } from '@/app/api/paperclip/[...path]/route'

const SUPERADMIN = { user: { email: 'root@x.com', role: 'superadmin', assignedProjects: ['*'] } }

function del(pathSegments: string[]) {
  const req = new NextRequest(`http://localhost/api/paperclip/${pathSegments.join('/')}`, {
    method: 'DELETE',
  })
  return DELETE(req, { params: { path: pathSegments } })
}

const fetchMock = vi.fn()

beforeEach(() => {
  state.session = SUPERADMIN
  fetchMock.mockReset()
  fetchMock.mockResolvedValue(new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

describe('DELETE protected company — refused for every role, any case', () => {
  it('403 PROTECTED_WORKSPACE for a superadmin (lowercase id) — no upstream call', async () => {
    const res = await del(['companies', PROTECTED])
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.code).toBe('PROTECTED_WORKSPACE')
    expect(body.error).toMatch(/protected/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('403 PROTECTED_WORKSPACE on an UPPERCASE-UUID variant (no case bypass)', async () => {
    const res = await del(['companies', PROTECTED_UPPER])
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PROTECTED_WORKSPACE')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('also blocks the /api/-prefixed proxy form', async () => {
    const res = await del(['api', 'companies', PROTECTED])
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('PROTECTED_WORKSPACE')
  })
})

describe('DELETE non-protected resources — guard does not interfere', () => {
  it('a non-protected company delete passes the guard (reaches upstream)', async () => {
    const res = await del(['companies', NON_PROTECTED])
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('deleting an issue is unaffected even when the id equals a protected id', async () => {
    const res = await del(['issues', PROTECTED])
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
  })

  it('deleting an agent is unaffected (agent delete guarded only by role, not this guard)', async () => {
    const res = await del(['agents', PROTECTED])
    expect(res.status).toBe(200)
    expect(fetchMock).toHaveBeenCalled()
  })
})
