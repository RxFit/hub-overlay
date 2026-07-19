import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { issueGateToken } from '@/lib/gateToken'

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    createGoogleDoc: vi.fn(),
    createGoogleSheet: vi.fn(),
    createGooglePresentation: vi.fn(),
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/google', () => ({
  createGoogleDoc: (...a: unknown[]) => state.createGoogleDoc(...a),
  createGoogleSheet: (...a: unknown[]) => state.createGoogleSheet(...a),
  createGooglePresentation: (...a: unknown[]) => state.createGooglePresentation(...a),
}))

import { POST as POSTDoc } from '@/app/api/google/doc/route'
import { POST as POSTSheet } from '@/app/api/google/sheet/route'
import { POST as POSTPresentation } from '@/app/api/google/presentation/route'

process.env.GATE_TOKEN_SECRET = 'unit-test-secret'
process.env.NEXTAUTH_SECRET = 'test-gate-secret'

function bodyReq(body: unknown, headers: Record<string, string> = {}) {
  const reqHeaders: Record<string, string> = { 'content-type': 'application/json', ...headers }
  return new NextRequest('http://localhost/api/google/doc', {
    method: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: reqHeaders,
  })
}

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.createGoogleDoc.mockReset()
  state.createGoogleSheet.mockReset()
  state.createGooglePresentation.mockReset()
})

describe('Google Docs/Sheets/Slides API routes', () => {
  it('401s without next-auth session', async () => {
    state.session = null
    const res = await POSTDoc(bodyReq({ title: 'Doc' }))
    expect(res.status).toBe(401)
  })

  it('403s on AI intent with missing gate token', async () => {
    const res = await POSTDoc(bodyReq({ title: 'Doc' }, { 'x-ai-intent': 'create_google_doc' }))
    expect(res.status).toBe(403)
    expect((await res.json()).error).toContain('Quality gate not satisfied')
  })

  it('passes on valid gate token for doc route', async () => {
    state.createGoogleDoc.mockResolvedValue({ id: 'doc-1', url: 'https://doc-url' })
    const gateToken = issueGateToken('create_google_doc', 90)
    const res = await POSTDoc(bodyReq(
      { title: 'My Doc', content: 'hello' },
      { 'x-ai-intent': 'create_google_doc', 'x-gate-token': gateToken }
    ))
    expect(res.status).toBe(200)
    expect(state.createGoogleDoc).toHaveBeenCalledWith('goog-token', 'My Doc', 'hello')
  })

  it('passes on valid gate token for sheet route', async () => {
    state.createGoogleSheet.mockResolvedValue({ id: 'sheet-1', url: 'https://sheet-url' })
    const gateToken = issueGateToken('create_google_sheet', 90)
    const res = await POSTSheet(bodyReq(
      { title: 'My Sheet', values: [['a', 'b']] },
      { 'x-ai-intent': 'create_google_sheet', 'x-gate-token': gateToken }
    ))
    expect(res.status).toBe(200)
    expect(state.createGoogleSheet).toHaveBeenCalledWith('goog-token', 'My Sheet', [['a', 'b']])
  })

  it('passes on valid gate token for presentation route', async () => {
    state.createGooglePresentation.mockResolvedValue({ id: 'pres-1', url: 'https://pres-url' })
    const gateToken = issueGateToken('create_google_presentation', 90)
    const res = await POSTPresentation(bodyReq(
      { title: 'My Slides' },
      { 'x-ai-intent': 'create_google_presentation', 'x-gate-token': gateToken }
    ))
    expect(res.status).toBe(200)
    expect(state.createGooglePresentation).toHaveBeenCalledWith('goog-token', 'My Slides', [])
  })
})
