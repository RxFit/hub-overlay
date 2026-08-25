import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * GET /api/runs — route contract (Phase 3 PR 2).
 *
 * The middleware does not role-guard this path, so the handler's session +
 * admin check is the ONLY gate — locked here exactly like
 * dispatch-health-route.test.ts. Also locks: the clamped limit, the
 * runs + caller-AI-actions merge sorted newest-first, and that an actions
 * read failure never blanks the runs feed.
 */

const { sessionMock, runsMock, actionsMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  runsMock: vi.fn(),
  actionsMock: vi.fn(),
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/runs', () => ({ listAiRuns: runsMock }))
vi.mock('@/lib/ai-audit', () => ({ listAiActions: actionsMock }))
vi.mock('@/lib/ai-action-feed', () => ({
  aiActionToFeedItem: (row: { id: string; createdAt: string }) => ({
    id: `ai-${row.id}`,
    source: 'ai_action',
    type: 'completed',
    title: 'ai action',
    description: '',
    timestamp: row.createdAt,
  }),
}))

import { GET } from '@/app/api/runs/route'

function request(path = '/api/runs'): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`)
}

function run(id: string, createdAt: string) {
  return {
    id,
    createdAt,
    engine: 'agy',
    model: null,
    source: 'chat',
    status: 'ok',
    errorClass: null,
    error: null,
    latencyMs: 1000,
    inputTokens: null,
    outputTokens: null,
    cacheReadTokens: null,
    totalTokens: null,
    promptChars: null,
    promptSha256: null,
    requestId: null,
    userEmail: null,
    meta: null,
  }
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'danny@rxfitatx.com', role: 'superadmin' } })
  runsMock.mockReset().mockResolvedValue([])
  actionsMock.mockReset().mockResolvedValue([])
})

describe('GET /api/runs', () => {
  it('401s without a session', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await GET(request())).status).toBe(401)
    expect(runsMock).not.toHaveBeenCalled()
  })

  it('403s for staff without touching the ledger (admin-gated per §3.4)', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
    expect((await GET(request())).status).toBe(403)
    expect(runsMock).not.toHaveBeenCalled()
  })

  it('403s for onboarding', async () => {
    sessionMock.mockResolvedValue({ user: { email: 'new@rxfitatx.com', role: 'onboarding' } })
    expect((await GET(request())).status).toBe(403)
  })

  it('defaults the limit to 40 and clamps it to 100', async () => {
    await GET(request())
    expect(runsMock).toHaveBeenCalledWith({ limit: 40 })

    await GET(request('/api/runs?limit=999'))
    expect(runsMock).toHaveBeenCalledWith({ limit: 100 })

    await GET(request('/api/runs?limit=abc'))
    expect(runsMock).toHaveBeenCalledWith({ limit: 40 })

    await GET(request('/api/runs?limit=-5'))
    expect(runsMock).toHaveBeenCalledWith({ limit: 1 })
  })

  it('merges mapped runs with the caller AI actions, newest first', async () => {
    runsMock.mockResolvedValue([run('r1', '2026-08-24T01:00:00Z')])
    actionsMock.mockResolvedValue([{ id: 'a1', createdAt: '2026-08-24T02:00:00Z' }])
    const body = await (await GET(request())).json()
    expect(actionsMock).toHaveBeenCalledWith({ userEmail: 'danny@rxfitatx.com', limit: 15 })
    expect(body.feed.map((f: { id: string }) => f.id)).toEqual(['ai-a1', 'run-r1'])
    expect(body.feed[1].source).toBe('run')
  })

  it('an AI-actions read failure never blanks the runs feed', async () => {
    runsMock.mockResolvedValue([run('r1', '2026-08-24T01:00:00Z')])
    actionsMock.mockRejectedValue(new Error('db down'))
    const res = await GET(request())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.feed).toHaveLength(1)
    expect(body.feed[0].id).toBe('run-r1')
  })

  it('a ledger read failure is a 500, not a fake-empty 200', async () => {
    runsMock.mockRejectedValue(new Error('db down'))
    expect((await GET(request())).status).toBe(500)
  })
})
