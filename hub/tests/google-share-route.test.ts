import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/share — route-owned logic.

   Mocking boundary: next-auth session/JWT + `lib/google/sharing` (the Drive
   REST adapter, unit-tested separately). Real: the gate (`requireAiGate` +
   HMAC tokens), zod validation, the MISSING_SCOPE 403 carve-out that must run
   BEFORE the generic error mapper, the audit contract, and the real
   `file_share` rate limiter.

   A share is outward-facing and un-recallable, so the properties pinned here
   are mostly refusals: no gate token → no share; a body that names both
   recipients AND link sharing → rejected rather than resolved by guessing.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    auditRows: [] as Record<string, unknown>[],
    findShareableFiles: vi.fn(),
    listFileAccess: vi.fn(),
    grantFileAccess: vi.fn(),
    grantLinkAccess: vi.fn(),
    revokeFileAccess: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/ai-audit', () => ({
  recordAiAction: vi.fn(async (row: Record<string, unknown>) => {
    state.auditRows.push(row)
  }),
}))
vi.mock('@/lib/google/sharing', async () => {
  // The pure helpers stay real — normalizeShareRole's least-privilege default
  // is part of what this route promises.
  const roles = await import('@/lib/google/share-roles')
  return {
    ...roles,
    findShareableFiles: (...a: unknown[]) => state.findShareableFiles(...a),
    listFileAccess: (...a: unknown[]) => state.listFileAccess(...a),
    grantFileAccess: (...a: unknown[]) => state.grantFileAccess(...a),
    grantLinkAccess: (...a: unknown[]) => state.grantLinkAccess(...a),
    revokeFileAccess: (...a: unknown[]) => state.revokeFileAccess(...a),
  }
})

process.env.NEXTAUTH_SECRET = 'test-gate-secret'

import { GET, POST, DELETE } from '@/app/api/google/share/route'
import { issueGateToken } from '@/lib/gateToken'
import { _reset as resetRateLimit, ACTION_LIMITS } from '@/lib/rate-limit'

const INTENT = 'share_google_file'

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/google/share${qs}`)
}

/** POST with a valid gate token unless `headers` overrides it. */
function postReq(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/google/share', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function aiHeaders(overrides: Record<string, string> = {}) {
  return {
    'x-ai-intent': INTENT,
    'x-gate-token': issueGateToken(INTENT, 90),
    ...overrides,
  }
}

function deleteReq(qs: string, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost/api/google/share${qs}`, {
    method: 'DELETE',
    headers,
  })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.auditRows = []
  state.findShareableFiles.mockReset()
  state.listFileAccess.mockReset()
  state.grantFileAccess.mockReset()
  state.grantLinkAccess.mockReset()
  state.revokeFileAccess.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  resetRateLimit()
})

describe('GET /api/google/share', () => {
  it('401s when there is no session', async () => {
    state.session = null
    expect((await GET(getReq('?q=memo'))).status).toBe(401)
  })

  it('401s { reauth: true } when the Google token is missing', async () => {
    state.token = null
    const res = await GET(getReq('?q=memo'))
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('400s when neither q nor fileId is given', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(400)
  })

  it('returns managed/unmanaged candidates for ?q', async () => {
    state.findShareableFiles.mockResolvedValue({
      managed: [{ id: 'f1', name: 'Q3 memo' }],
      unmanaged: [],
    })
    const res = await GET(getReq('?q=Q3'))
    expect(res.status).toBe(200)
    expect((await res.json()).managed).toEqual([{ id: 'f1', name: 'Q3 memo' }])
  })

  it('returns current access for ?fileId', async () => {
    state.listFileAccess.mockResolvedValue([{ permissionId: 'p1', role: 'owner' }])
    const res = await GET(getReq('?fileId=f1'))
    expect(res.status).toBe(200)
    expect((await res.json()).access).toHaveLength(1)
  })
})

describe('POST /api/google/share — the gate', () => {
  /**
   * The core refusal. An AI-originated share with no valid gate token must not
   * reach Drive, because the confirm-card approval it claims to represent is a
   * browser-side fact the server cannot otherwise verify.
   */
  it('403s an AI share with no gate token, and never calls Drive', async () => {
    const res = await POST(
      postReq({ fileId: 'f1', recipients: ['m@x.com'] }, { 'x-ai-intent': INTENT }),
    )
    expect(res.status).toBe(403)
    expect(state.grantFileAccess).not.toHaveBeenCalled()
  })

  it("403s when the token's signed intent doesn't match the declared one", async () => {
    const res = await POST(
      postReq(
        { fileId: 'f1', recipients: ['m@x.com'] },
        { 'x-ai-intent': INTENT, 'x-gate-token': issueGateToken('send_gmail', 90) },
      ),
    )
    expect(res.status).toBe(403)
    expect(state.grantFileAccess).not.toHaveBeenCalled()
  })

  it('403s an AI intent this route does not serve', async () => {
    const res = await POST(
      postReq(
        { fileId: 'f1', recipients: ['m@x.com'] },
        { 'x-ai-intent': 'send_gmail', 'x-gate-token': issueGateToken('send_gmail', 90) },
      ),
    )
    expect(res.status).toBe(403)
  })

  /** A human-driven call carries no AI marker, so the gate is not applicable. */
  it('allows a manual (non-AI) share with no gate token', async () => {
    state.grantFileAccess.mockResolvedValue({
      permissionId: 'p1', grantee: 'm@x.com', role: 'reader',
    })
    const res = await POST(postReq({ fileId: 'f1', recipients: ['m@x.com'] }))
    expect(res.status).toBe(200)
    // No AI marker → no audit row either.
    expect(state.auditRows).toHaveLength(0)
  })
})

describe('POST /api/google/share — validation', () => {
  it('rejects a body naming both recipients and link sharing', async () => {
    const res = await POST(
      postReq({ fileId: 'f1', recipients: ['m@x.com'], link: true }, aiHeaders()),
    )
    expect(res.status).toBe(400)
    expect(state.grantFileAccess).not.toHaveBeenCalled()
    expect(state.grantLinkAccess).not.toHaveBeenCalled()
  })

  it('rejects a body naming neither', async () => {
    expect((await POST(postReq({ fileId: 'f1' }, aiHeaders()))).status).toBe(400)
  })

  it('rejects a malformed recipient address', async () => {
    const res = await POST(
      postReq({ fileId: 'f1', recipients: ['not-an-email'] }, aiHeaders()),
    )
    expect(res.status).toBe(400)
    expect(state.grantFileAccess).not.toHaveBeenCalled()
  })

  it('400s on a non-JSON body', async () => {
    expect((await POST(postReq('{oops', aiHeaders()))).status).toBe(400)
  })
})

describe('POST /api/google/share — granting', () => {
  it('grants each recipient and audits the success', async () => {
    state.grantFileAccess
      .mockResolvedValueOnce({ permissionId: 'p1', grantee: 'a@x.com', role: 'writer' })
      .mockResolvedValueOnce({ permissionId: 'p2', grantee: 'b@x.com', role: 'writer' })

    const res = await POST(
      postReq(
        { fileId: 'f1', recipients: ['a@x.com', 'b@x.com'], role: 'writer' },
        aiHeaders(),
      ),
    )

    expect(res.status).toBe(200)
    expect((await res.json()).granted).toHaveLength(2)
    expect(state.grantFileAccess).toHaveBeenCalledTimes(2)
    expect(state.auditRows[0]).toMatchObject({ actionType: 'file_share', status: 'success' })
    expect((state.auditRows[0].target as Record<string, unknown>).granted).toEqual([
      'a@x.com', 'b@x.com',
    ])
  })

  /**
   * An unspecified role must land on `reader`. The route defers to
   * `normalizeShareRole` for this; pinning it here stops a future refactor from
   * defaulting to something more generous at the boundary.
   */
  it('defaults an unspecified role to reader', async () => {
    state.grantFileAccess.mockResolvedValue({
      permissionId: 'p1', grantee: 'a@x.com', role: 'reader',
    })
    await POST(postReq({ fileId: 'f1', recipients: ['a@x.com'] }, aiHeaders()))
    expect(state.grantFileAccess).toHaveBeenCalledWith(
      'goog-token',
      'f1',
      expect.objectContaining({ role: 'reader' }),
    )
  })

  it('routes a link share to grantLinkAccess', async () => {
    state.grantLinkAccess.mockResolvedValue({
      permissionId: 'pl', grantee: 'anyone with the link', role: 'reader',
    })
    const res = await POST(postReq({ fileId: 'f1', link: true }, aiHeaders()))
    expect(res.status).toBe(200)
    expect(state.grantLinkAccess).toHaveBeenCalledWith('goog-token', 'f1', 'reader')
    expect(state.grantFileAccess).not.toHaveBeenCalled()
  })

  /**
   * A grant predating the `drive.file` scope must surface as MISSING_SCOPE, not
   * as the generic mapper's reauth 401 — the client re-consents only on that
   * marker.
   */
  it('maps an insufficient-permission 403 to MISSING_SCOPE', async () => {
    state.grantFileAccess.mockRejectedValue(
      new Error('Google API error 403: insufficientPermissions'),
    )
    const res = await POST(postReq({ fileId: 'f1', recipients: ['a@x.com'] }, aiHeaders()))
    expect(res.status).toBe(403)
    expect((await res.json()).code).toBe('MISSING_SCOPE')
    expect(state.auditRows[0]).toMatchObject({ status: 'failed' })
  })

  it('audits a failure and does not claim success', async () => {
    state.grantFileAccess.mockRejectedValue(new Error('Google API error 500: boom'))
    const res = await POST(postReq({ fileId: 'f1', recipients: ['a@x.com'] }, aiHeaders()))
    expect(res.status).toBe(502)
    expect(state.auditRows[0]).toMatchObject({ actionType: 'file_share', status: 'failed' })
  })

  it('rate-limits AI shares at the file_share allowance', async () => {
    state.grantFileAccess.mockResolvedValue({
      permissionId: 'p1', grantee: 'a@x.com', role: 'reader',
    })
    const limit = ACTION_LIMITS.file_share

    for (let i = 0; i < limit; i++) {
      const ok = await POST(postReq({ fileId: 'f1', recipients: ['a@x.com'] }, aiHeaders()))
      expect(ok.status).toBe(200)
    }

    const blocked = await POST(
      postReq({ fileId: 'f1', recipients: ['a@x.com'] }, aiHeaders()),
    )
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toBeTruthy()
    expect(state.auditRows.at(-1)).toMatchObject({ status: 'failed', error: 'rate_limited' })
  })
})

describe('DELETE /api/google/share', () => {
  it('400s without both fileId and permissionId', async () => {
    expect((await DELETE(deleteReq('?fileId=f1'))).status).toBe(400)
  })

  it('403s an AI revoke with no gate token', async () => {
    const res = await DELETE(
      deleteReq('?fileId=f1&permissionId=p1', { 'x-ai-intent': INTENT }),
    )
    expect(res.status).toBe(403)
    expect(state.revokeFileAccess).not.toHaveBeenCalled()
  })

  it('revokes and audits', async () => {
    state.revokeFileAccess.mockResolvedValue(undefined)
    const res = await DELETE(deleteReq('?fileId=f1&permissionId=p1', aiHeaders()))
    expect(res.status).toBe(200)
    expect((await res.json()).revoked).toBe(true)
    expect(state.auditRows[0]).toMatchObject({ actionType: 'file_unshare', status: 'success' })
  })
})
