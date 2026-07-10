import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/tool-artifacts — creator-ownership on PATCH/DELETE (P2 IDOR).

   GET already scopes non-admins to artifacts they created, but PATCH and DELETE
   previously verified only tenant ownership — so a `staff` user could edit or
   soft-delete ANOTHER user's artifact by id (IDOR across users within a tenant).
   The fix enforces creator ownership on mutate: non-admins may only mutate
   artifacts where createdBy === their email; admin/superadmin may mutate any in
   the tenant. These tests exercise the guard at the DB boundary with the lib
   mocked so authorized calls reach the handler without a live Postgres.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({ state: { session: null as unknown } }))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/tenant-context', () => ({ getTenantId: () => 'rxfit' }))
vi.mock('@/lib/tool-artifacts', () => ({
  saveToolArtifact: vi.fn(async () => ({ id: 'a1' })),
  getToolArtifacts: vi.fn(async () => []),
  getToolArtifact: vi.fn(async () => null),
  updateToolArtifact: vi.fn(async () => ({ id: 'a1', title: 'updated' })),
  archiveToolArtifact: vi.fn(async () => ({ id: 'a1', status: 'archived' })),
}))

import { PATCH, DELETE } from '@/app/api/tool-artifacts/route'
import { getToolArtifact, updateToolArtifact, archiveToolArtifact } from '@/lib/tool-artifacts'

function sess(role: string, email = 'me@example.com') {
  return { user: { email, role } }
}
function patchReq(body: unknown) {
  return new NextRequest('http://localhost/api/tool-artifacts', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function deleteReq(body: unknown) {
  return new NextRequest('http://localhost/api/tool-artifacts', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// An artifact in the tenant owned by someone OTHER than the caller.
const OTHERS_ARTIFACT = { id: 'a1', tenantId: 'rxfit', createdBy: 'owner@example.com' }
const MY_ARTIFACT = { id: 'a1', tenantId: 'rxfit', createdBy: 'me@example.com' }

beforeEach(() => {
  state.session = null
  vi.mocked(getToolArtifact).mockReset()
  vi.mocked(updateToolArtifact).mockClear()
  vi.mocked(archiveToolArtifact).mockClear()
})

describe('PATCH /api/tool-artifacts — creator ownership (IDOR)', () => {
  it('401s when unauthenticated', async () => {
    state.session = null
    expect((await PATCH(patchReq({ id: 'a1', title: 'x' }))).status).toBe(401)
  })

  it('403s a staff user mutating ANOTHER user\'s artifact (never reaches update)', async () => {
    state.session = sess('staff')
    vi.mocked(getToolArtifact).mockResolvedValue(OTHERS_ARTIFACT as never)
    const res = await PATCH(patchReq({ id: 'a1', title: 'hijack' }))
    expect(res.status).toBe(403)
    expect(updateToolArtifact).not.toHaveBeenCalled()
  })

  it('allows the owner (staff) to mutate their own artifact', async () => {
    state.session = sess('staff', 'me@example.com')
    vi.mocked(getToolArtifact).mockResolvedValue(MY_ARTIFACT as never)
    const res = await PATCH(patchReq({ id: 'a1', title: 'ok' }))
    expect(res.status).toBe(200)
    expect(updateToolArtifact).toHaveBeenCalledTimes(1)
  })

  it('allows an admin to mutate ANY artifact in the tenant', async () => {
    state.session = sess('admin', 'admin@example.com')
    vi.mocked(getToolArtifact).mockResolvedValue(OTHERS_ARTIFACT as never)
    const res = await PATCH(patchReq({ id: 'a1', title: 'ok' }))
    expect(res.status).toBe(200)
    expect(updateToolArtifact).toHaveBeenCalledTimes(1)
  })

  it('allows superadmin as well', async () => {
    state.session = sess('superadmin', 'root@example.com')
    vi.mocked(getToolArtifact).mockResolvedValue(OTHERS_ARTIFACT as never)
    expect((await PATCH(patchReq({ id: 'a1', title: 'ok' }))).status).toBe(200)
  })

  it('404s when the artifact is in another tenant (non-disclosure)', async () => {
    state.session = sess('admin')
    vi.mocked(getToolArtifact).mockResolvedValue({ id: 'a1', tenantId: 'other', createdBy: 'x' } as never)
    const res = await PATCH(patchReq({ id: 'a1', title: 'x' }))
    expect(res.status).toBe(404)
    expect(updateToolArtifact).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/tool-artifacts — creator ownership (IDOR)', () => {
  it('403s a staff user soft-deleting ANOTHER user\'s artifact', async () => {
    state.session = sess('staff')
    vi.mocked(getToolArtifact).mockResolvedValue(OTHERS_ARTIFACT as never)
    const res = await DELETE(deleteReq({ id: 'a1' }))
    expect(res.status).toBe(403)
    expect(archiveToolArtifact).not.toHaveBeenCalled()
  })

  it('allows the owner to delete their own artifact', async () => {
    state.session = sess('staff', 'me@example.com')
    vi.mocked(getToolArtifact).mockResolvedValue(MY_ARTIFACT as never)
    const res = await DELETE(deleteReq({ id: 'a1' }))
    expect(res.status).toBe(200)
    expect(archiveToolArtifact).toHaveBeenCalledTimes(1)
  })

  it('allows an admin to delete any artifact in the tenant', async () => {
    state.session = sess('admin')
    vi.mocked(getToolArtifact).mockResolvedValue(OTHERS_ARTIFACT as never)
    const res = await DELETE(deleteReq({ id: 'a1' }))
    expect(res.status).toBe(200)
    expect(archiveToolArtifact).toHaveBeenCalledTimes(1)
  })
})
