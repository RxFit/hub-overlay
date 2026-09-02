import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/admin/paperclip-health — live Paperclip connectivity probe.

   Guards mirror /api/admin/ai-health (401 unauthenticated, 403 non-admin).
   The probe itself is exercised with the paperclip/paperclipSession layers
   mocked: auth-mode detection (session cookie vs API key), success shape
   (count + latency, no company data), and error classification for the
   failure classes an admin acts on (auth, network, circuit-open,
   no-credentials, http-NNN).
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    authHeaders: null as (() => Promise<Record<string, string>>) | null,
    companies: null as (() => Promise<unknown[]>) | null,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/paperclip', () => ({
  getCompanies: vi.fn(async () => state.companies!()),
}))
vi.mock('@/lib/paperclipSession', () => ({
  getPaperclipAuthHeaders: vi.fn(async () => state.authHeaders!()),
}))
vi.mock('@/lib/paperclipConfig', () => ({
  PAPERCLIP_BASE_URL: 'https://paperclip.test',
}))

import { GET } from '@/app/api/admin/paperclip-health/route'
import { classifyPaperclipError } from '@/lib/paperclip-health'

// The handler is withFault-wrapped now, so it takes a request even though the
// route's own body ignores it — the wrapper reads x-hub-request-id off it.
function req() {
  return new NextRequest('http://localhost/api/admin/paperclip-health')
}

function sess(role?: string) {
  return role ? { user: { email: 'u@example.com', role } } : null
}

beforeEach(() => {
  state.session = null
  state.authHeaders = async () => ({ Cookie: 'session_token=x' })
  state.companies = async () => [{ id: 'c1' }, { id: 'c2' }]
})

describe('GET /api/admin/paperclip-health — guards', () => {
  it('401s when unauthenticated', async () => {
    state.session = null
    expect((await GET(req())).status).toBe(401)
  })

  it('403s for non-admin roles', async () => {
    state.session = sess('staff')
    expect((await GET(req())).status).toBe(403)
  })
})

describe('GET /api/admin/paperclip-health — probes', () => {
  it('reports healthy with session-cookie auth mode and companies count only', async () => {
    state.session = sess('superadmin')
    const body = await (await GET(req())).json()
    expect(body.healthy).toBe(true)
    expect(body.auth).toMatchObject({ ok: true, mode: 'session-cookie' })
    expect(body.companies).toMatchObject({ ok: true, count: 2 })
    expect(JSON.stringify(body)).not.toContain('c1') // no company data leaks
    expect(body.config.baseUrl).toBe('https://paperclip.test')
  })

  it('reports api-key mode when session auth fell back to a Bearer key', async () => {
    state.session = sess('admin')
    state.authHeaders = async () => ({ Authorization: 'Bearer k' })
    const body = await (await GET(req())).json()
    expect(body.auth).toMatchObject({ ok: true, mode: 'api-key' })
  })

  it('classifies an auth failure and stays 200 (diagnosis, not an error page)', async () => {
    state.session = sess('superadmin')
    state.authHeaders = async () => { throw new Error('Paperclip sign-in failed (401): bad password') }
    state.companies = async () => { throw new Error('Paperclip API error 401: unauthorized') }
    const res = await GET(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.healthy).toBe(false)
    expect(body.auth).toMatchObject({ ok: false, errorClass: 'auth' })
    expect(body.companies).toMatchObject({ ok: false, errorClass: 'auth' })
  })

  it('classifies a network failure on the data probe', async () => {
    state.session = sess('superadmin')
    state.companies = async () => { throw new Error('fetch failed: ECONNREFUSED 10.0.0.1:443') }
    const body = await (await GET(req())).json()
    expect(body.companies).toMatchObject({ ok: false, errorClass: 'network' })
  })
})

describe('classifyPaperclipError', () => {
  const cases: Array<[string, string]> = [
    ['Circuit open for "rxfit:paperclip-auth"', 'circuit-open'],
    ['Paperclip response schema mismatch for /api/companies', 'schema'],
    ['No Paperclip auth available: set PAPERCLIP_AUTH_EMAIL + PAPERCLIP_AUTH_PASSWORD, or PAPERCLIP_API_KEY', 'no-credentials'],
    ['Paperclip sign-in failed (401): invalid credentials', 'auth'],
    ['Paperclip API error 403: forbidden', 'auth'],
    ['Paperclip API error 500: internal', 'http-500'],
    ['Paperclip API error 404: not found', 'http-404'],
    ['fetch failed', 'network'],
    ['getaddrinfo ENOTFOUND rxfit-paperclip.run.app', 'network'],
    ['The operation was aborted due to timeout', 'network'],
    ['something else entirely', 'unknown'],
  ]
  for (const [message, expected] of cases) {
    it(`"${message.slice(0, 50)}" → ${expected}`, () => {
      expect(classifyPaperclipError(new Error(message))).toBe(expected)
    })
  }
})
