import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/deep-runs — route contract (PR B).
 *
 * Locks: the staff gate (onboarding stays out), input validation, the
 * fail-honest availability ladder (dispatch disabled → no_worker →
 * queue_full — never a silent metered fallback), the per-user cap, the
 * enqueue wire shape (toolRunId + userEmail + effort in payload_meta), the
 * created-row-or-stand-down invariant, and the [id] read/cancel flows.
 */

const { sessionMock, staffMock, storeMock, dispatchMock, toolRunsMock, skillsMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  staffMock: vi.fn(),
  storeMock: {
    enqueueJob: vi.fn(),
    cancelJob: vi.fn(),
    getJobDetail: vi.fn(),
    workCapableWorkerFresh: vi.fn(),
    isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
  },
  dispatchMock: {
    dispatchFreshMs: () => 45_000,
    isDispatchConfigured: vi.fn(),
    isDispatchEnabled: vi.fn(),
  },
  toolRunsMock: {
    createToolRun: vi.fn(),
    attachToolRunJob: vi.fn(),
    expireStaleToolRuns: vi.fn(),
    finishToolRun: vi.fn(),
    isActiveRunConflict: (err: unknown) =>
      (err as { code?: string } | null)?.code === '23505' ||
      (err as { cause?: { code?: string } } | null)?.cause?.code === '23505',
    listToolRuns: vi.fn(),
    countActiveToolRuns: vi.fn(),
    getToolRunOwned: vi.fn(),
    cancelToolRun: vi.fn(),
  },
  skillsMock: { loadSkillContent: vi.fn() },
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessStaffRoute: staffMock }))
vi.mock('@/lib/dispatch-store', () => storeMock)
vi.mock('@/lib/agy-dispatch', () => dispatchMock)
vi.mock('@/lib/tool-runs', () => toolRunsMock)
vi.mock('@/lib/skills-loader', () => skillsMock)
vi.mock('@/lib/observability', () => ({ emit: vi.fn() }))
vi.mock('@/lib/db', () => ({ db: {} }))

import { POST as createPost, GET as listGet } from '@/app/api/deep-runs/route'
import { GET as detailGet, POST as detailPost } from '@/app/api/deep-runs/[id]/route'

function post(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/deep-runs', { method: 'POST', body: JSON.stringify(body) })
}

const QUEUED_RUN = {
  id: 'r1', tool: 'deep-research', status: 'queued', brief: 'b', resultMd: null,
  errorClass: null, error: null, userEmail: 'staff@rxfitatx.com', chatId: null,
  jobId: 'j1', attempt: 0, model: null, latencyMs: null, usage: null,
  createdAt: new Date().toISOString(), finishedAt: null,
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
  staffMock.mockReset().mockReturnValue(true)
  storeMock.enqueueJob.mockReset().mockResolvedValue({ id: 'j1' })
  storeMock.cancelJob.mockReset().mockResolvedValue(undefined)
  storeMock.getJobDetail.mockReset().mockResolvedValue(null)
  storeMock.workCapableWorkerFresh.mockReset().mockResolvedValue(true)
  dispatchMock.isDispatchConfigured.mockReset().mockReturnValue(true)
  dispatchMock.isDispatchEnabled.mockReset().mockReturnValue(true)
  toolRunsMock.createToolRun.mockReset().mockResolvedValue(undefined)
  toolRunsMock.attachToolRunJob.mockReset().mockResolvedValue(undefined)
  toolRunsMock.expireStaleToolRuns.mockReset().mockResolvedValue(0)
  toolRunsMock.finishToolRun.mockReset().mockResolvedValue(null)
  toolRunsMock.listToolRuns.mockReset().mockResolvedValue([])
  toolRunsMock.countActiveToolRuns.mockReset().mockResolvedValue(0)
  toolRunsMock.getToolRunOwned.mockReset()
  toolRunsMock.cancelToolRun.mockReset()
  skillsMock.loadSkillContent.mockReset().mockResolvedValue(null)
})

describe('auth', () => {
  it('401s without a session; 403s below staff (onboarding stays out)', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await createPost(post({ tool: 'deep-research', brief: 'why' }))).status).toBe(401)
    sessionMock.mockResolvedValue({ user: { email: 'new@rxfitatx.com', role: 'onboarding' } })
    staffMock.mockReturnValue(false)
    expect((await createPost(post({ tool: 'deep-research', brief: 'why' }))).status).toBe(403)
    expect((await listGet(new NextRequest('http://localhost:3000/api/deep-runs'))).status).toBe(403)
    expect(storeMock.enqueueJob).not.toHaveBeenCalled()
  })
})

describe('POST /api/deep-runs', () => {
  it('rejects unknown tools and bad briefs before touching the engine', async () => {
    expect((await createPost(post({ tool: 'issue-tree', brief: 'x'.repeat(10) }))).status).toBe(400)
    expect((await createPost(post({ tool: 'deep-research', brief: ' ' }))).status).toBe(400)
    expect(storeMock.workCapableWorkerFresh).not.toHaveBeenCalled()
  })

  it('fails honest when dispatch is disabled — never a silent metered fallback', async () => {
    dispatchMock.isDispatchEnabled.mockReturnValue(false)
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(503)
    expect((await res.json()).reason).toBe('dispatch_disabled')
  })

  it('fails honest when the desktop worker is stale', async () => {
    storeMock.workCapableWorkerFresh.mockResolvedValue(false)
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(503)
    expect((await res.json()).reason).toBe('no_worker')
    expect(storeMock.enqueueJob).not.toHaveBeenCalled()
  })

  it('caps one active run per user', async () => {
    toolRunsMock.countActiveToolRuns.mockResolvedValue(1)
    const res = await createPost(post({ tool: 'deep-think', brief: 'should we expand' }))
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('active_run_exists')
  })

  it('creates the durable row FIRST, then enqueues with toolRunId + userEmail (+ effort for deep-think), then attaches the job', async () => {
    const res = await createPost(post({ tool: 'deep-think', brief: 'should we expand', chatId: 'chat-1' }))
    expect(res.status).toBe(200)
    const { run } = await res.json()
    expect(run.tool).toBe('deep-think')
    expect(run.status).toBe('queued')

    // Row-first ordering: a fast worker must always find the row at landing.
    expect(toolRunsMock.createToolRun.mock.invocationCallOrder[0])
      .toBeLessThan(storeMock.enqueueJob.mock.invocationCallOrder[0])
    expect(toolRunsMock.createToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id, tool: 'deep-think', chatId: 'chat-1' }),
    )

    const enq = storeMock.enqueueJob.mock.calls[0][0]
    expect(enq.kind).toBe('work_item')
    expect(enq.meta).toMatchObject({ toolRunId: run.id, tool: 'deep-think', userEmail: 'staff@rxfitatx.com', effort: 'high' })
    expect(enq.prompt).toContain('should we expand')

    expect(toolRunsMock.attachToolRunJob).toHaveBeenCalledWith(run.id, 'j1')
    expect(toolRunsMock.expireStaleToolRuns).toHaveBeenCalledWith('staff@rxfitatx.com')
  })

  it('the unique-index conflict is the atomic cap: 409 without enqueueing', async () => {
    toolRunsMock.createToolRun.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }))
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(409)
    expect((await res.json()).reason).toBe('active_run_exists')
    expect(storeMock.enqueueJob).not.toHaveBeenCalled()
  })

  it('deep-research carries no effort pin (agy defaults, tools live)', async () => {
    await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(storeMock.enqueueJob.mock.calls[0][0].meta.effort).toBeUndefined()
  })

  it('503s queue_full on backpressure refusal — and the row does not sit holding the cap', async () => {
    storeMock.enqueueJob.mockResolvedValue({ refused: 'queue_full' })
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(503)
    expect((await res.json()).reason).toBe('queue_full')
    expect(toolRunsMock.finishToolRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ status: 'failed', errorClass: 'queue_full' }),
    )
  })

  it('an enqueue failure fails the row too — no jobless run left holding the cap', async () => {
    storeMock.enqueueJob.mockRejectedValue(new Error('db down'))
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(500)
    expect(toolRunsMock.finishToolRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ status: 'failed', errorClass: 'no_worker' }),
    )
  })
})

describe('GET /api/deep-runs', () => {
  it('defaults to 10 when no limit is given — Number(null) must not clamp to 1', async () => {
    await listGet(new NextRequest('http://localhost:3000/api/deep-runs'))
    expect(toolRunsMock.listToolRuns).toHaveBeenCalledWith('staff@rxfitatx.com', { tool: undefined, limit: 10 })
  })

  it('clamps an explicit limit into 1..20', async () => {
    await listGet(new NextRequest('http://localhost:3000/api/deep-runs?limit=999'))
    expect(toolRunsMock.listToolRuns).toHaveBeenCalledWith('staff@rxfitatx.com', { tool: undefined, limit: 20 })
  })
})

describe('GET /api/deep-runs/[id]', () => {
  it('404s a run the caller does not own (scoping lives in the store)', async () => {
    toolRunsMock.getToolRunOwned.mockResolvedValue(null)
    const res = await detailGet(new NextRequest('http://localhost:3000/api/deep-runs/r1'), { params: { id: 'r1' } })
    expect(res.status).toBe(404)
  })

  it('derives the live view from the dispatch job for a queued run', async () => {
    toolRunsMock.getToolRunOwned.mockResolvedValue(QUEUED_RUN)
    storeMock.getJobDetail.mockResolvedValue({
      state: 'leased', kind: 'work_item', attempt: 2, maxAttempts: 3,
      errorClass: null, error: null, latencyMs: null,
      leaseExpiresAt: new Date(Date.now() + 100_000), deadlineAt: new Date(Date.now() + 600_000),
      finishedAt: null, payloadMeta: null, resultMeta: null,
    })
    const body = await (await detailGet(new NextRequest('http://localhost:3000/api/deep-runs/r1'), { params: { id: 'r1' } })).json()
    expect(body.run.liveStatus).toBe('running')
    expect(body.run.liveAttempt).toBe(2)
  })

  it('a terminal run never reads the job', async () => {
    toolRunsMock.getToolRunOwned.mockResolvedValue({ ...QUEUED_RUN, status: 'succeeded', resultMd: '# Report' })
    const body = await (await detailGet(new NextRequest('http://localhost:3000/api/deep-runs/r1'), { params: { id: 'r1' } })).json()
    expect(body.run.liveStatus).toBe('succeeded')
    expect(body.run.resultMd).toBe('# Report')
    expect(storeMock.getJobDetail).not.toHaveBeenCalled()
  })
})

describe('POST /api/deep-runs/[id] (cancel)', () => {
  function cancelReq(action: unknown = 'cancel'): NextRequest {
    return new NextRequest('http://localhost:3000/api/deep-runs/r1', { method: 'POST', body: JSON.stringify({ action }) })
  }

  it("400s any action other than 'cancel'", async () => {
    expect((await detailPost(cancelReq('retry'), { params: { id: 'r1' } })).status).toBe(400)
  })

  it('cancels the run first, then stands the queue job down', async () => {
    toolRunsMock.cancelToolRun.mockResolvedValue('j1')
    toolRunsMock.getToolRunOwned.mockResolvedValue({ ...QUEUED_RUN, status: 'cancelled', errorClass: 'abort' })
    const body = await (await detailPost(cancelReq(), { params: { id: 'r1' } })).json()
    expect(toolRunsMock.cancelToolRun).toHaveBeenCalledWith('r1', 'staff@rxfitatx.com')
    expect(storeMock.cancelJob).toHaveBeenCalledWith('j1')
    expect(body.run.liveStatus).toBe('cancelled')
  })

  it('a failed queue cancel is awaited, logged, and never breaks the response — the CAS discards the late result', async () => {
    toolRunsMock.cancelToolRun.mockResolvedValue('j1')
    storeMock.cancelJob.mockRejectedValue(new Error('db blip'))
    toolRunsMock.getToolRunOwned.mockResolvedValue({ ...QUEUED_RUN, status: 'cancelled', errorClass: 'abort' })
    const res = await detailPost(cancelReq(), { params: { id: 'r1' } })
    expect(res.status).toBe(200)
    expect((await res.json()).run.liveStatus).toBe('cancelled')
  })

  it('a cancel that lost the race (already terminal) still returns the current view', async () => {
    toolRunsMock.cancelToolRun.mockResolvedValue(null)
    toolRunsMock.getToolRunOwned.mockResolvedValue({ ...QUEUED_RUN, status: 'succeeded', resultMd: '# done' })
    const body = await (await detailPost(cancelReq(), { params: { id: 'r1' } })).json()
    expect(storeMock.cancelJob).not.toHaveBeenCalled()
    expect(body.run.liveStatus).toBe('succeeded')
  })
})
