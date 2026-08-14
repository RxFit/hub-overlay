import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/admin/agy-health — route contract.
 *
 * Locks: the admin gate (401/403), the cheap default report (no model run),
 * probe=1 spending a run and reporting marker verification, and typed error
 * classes surfacing instead of raw stack text.
 */

const { sessionMock, adminMock, generateMock, versionMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  adminMock: vi.fn(),
  generateMock: vi.fn(),
  versionMock: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessAdminRoute: adminMock }))
vi.mock('@/lib/agy', () => ({
  agyGenerateText: generateMock,
  agyVersion: versionMock,
  agyErrorType: (err: unknown) => (err as { agyError?: { type?: string } })?.agyError?.type ?? 'unknown',
  agyTokenSource: () => 'env',
  isAgyConfigured: () => true,
  truncateAgyError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
}))

import { GET } from '@/app/api/admin/agy-health/route'

function request(path = '/api/admin/agy-health'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`)
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'admin@rxfitatx.com', role: 'admin' } })
  adminMock.mockReset().mockReturnValue(true)
  generateMock.mockReset()
  versionMock.mockReset().mockResolvedValue('1.1.12')
})

describe('GET /api/admin/agy-health', () => {
  it('401s without a session', async () => {
    sessionMock.mockResolvedValue(null)
    const res = await GET(request())
    expect(res.status).toBe(401)
  })

  it('403s for non-admin roles', async () => {
    adminMock.mockReturnValue(false)
    const res = await GET(request())
    expect(res.status).toBe(403)
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('default report is cheap: version + config, no model run', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.healthy).toBe(true)
    expect(body.binary).toEqual({ found: true, version: '1.1.12' })
    expect(body.config.tokenSource).toBe('env')
    expect(body.probe).toEqual({ ran: false })
    expect(generateMock).not.toHaveBeenCalled()
  })

  it('missing binary stays healthy (runtime install provisions it on first run)', async () => {
    versionMock.mockResolvedValue(null)
    const body = await (await GET(request())).json()
    expect(body.binary.found).toBe(false)
    expect(body.binary.note).toContain('installs on first run')
    expect(body.healthy).toBe(true)
  })

  it('probe=1 runs a marker prompt and reports verification + cache signal', async () => {
    generateMock.mockResolvedValue({
      text: 'AGY_GATEWAY_OK',
      model: 'gemini-3-flash',
      usage: { cacheReadTokens: 42 },
      raw: {},
      latencyMs: 1234,
    })
    const body = await (await GET(request('/api/admin/agy-health?probe=1'))).json()
    expect(generateMock).toHaveBeenCalledOnce()
    expect(generateMock.mock.calls[0][0]).toContain('AGY_GATEWAY_OK')
    expect(body.probe).toMatchObject({
      ran: true,
      ok: true,
      markerVerified: true,
      model: 'gemini-3-flash',
      cacheReadTokens: 42,
    })
    expect(body.healthy).toBe(true)
  })

  it('probe reply without the marker reports markerVerified false but ok', async () => {
    generateMock.mockResolvedValue({ text: 'sure, here you go!', raw: {}, latencyMs: 900 })
    const body = await (await GET(request('/api/admin/agy-health?probe=1'))).json()
    expect(body.probe.ok).toBe(true)
    expect(body.probe.markerVerified).toBe(false)
  })

  it('probe failure surfaces the typed error class and flips healthy', async () => {
    generateMock.mockRejectedValue(
      Object.assign(new Error('token did not replay'), { agyError: { type: 'auth', message: 'token did not replay' } }),
    )
    const body = await (await GET(request('/api/admin/agy-health?probe=1'))).json()
    expect(body.probe).toMatchObject({ ran: true, ok: false, errorClass: 'auth', error: 'token did not replay' })
    expect(body.healthy).toBe(false)
  })
})
