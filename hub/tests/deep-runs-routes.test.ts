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
    workerFresh: vi.fn(),
    isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
  },
  dispatchMock: {
    dispatchFreshMs: () => 45_000,
    isDispatchConfigured: vi.fn(),
    isDispatchEnabled: vi.fn(),
  },
  toolRunsMock: {
    createToolRun: vi.fn(),
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
  storeMock.workerFresh.mockReset().mockResolvedValue(true)
  dispatchMock.isDispatchConfigured.mockReset().mockReturnValue(true)
  dispatchMock.isDispatchEnabled.mockReset().mockReturnValue(true)
  toolRunsMock.createToolRun.mockReset().mockResolvedValue(undefined)
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
    expect(storeMock.workerFresh).not.toHaveBeenCalled()
  })

  it('fails honest when dispatch is disabled — never a silent metered fallback', async () => {
    dispatchMock.isDispatchEnabled.mockReturnValue(false)
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(503)
    expect((await res.json()).reason).toBe('dispatch_disabled')
  })

  it('fails honest when the desktop worker is stale', async () => {
    storeMock.workerFresh.mockResolvedValue(false)
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

  it('enqueues the work_item with toolRunId + userEmail (+ effort for deep-think) and creates the durable row', async () => {
    const res = await createPost(post({ tool: 'deep-think', brief: 'should we expand', chatId: 'chat-1' }))
    expect(res.status).toBe(200)
    const { run } = await res.json()
    expect(run.tool).toBe('deep-think')
    expect(run.status).toBe('queued')

    const enq = storeMock.enqueueJob.mock.calls[0][0]
    expect(enq.kind).toBe('work_item')
    expect(enq.meta).toMatchObject({ toolRunId: run.id, tool: 'deep-think', userEmail: 'staff@rxfitatx.com', effort: 'high' })
    expect(enq.prompt).toContain('should we expand')

    expect(toolRunsMock.createToolRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: run.id, tool: 'deep-think', jobId: 'j1', chatId: 'chat-1' }),
    )
  })

  it('deep-research carries no effort pin (agy defaults, tools live)', async () => {
    await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(storeMock.enqueueJob.mock.calls[0][0].meta.effort).toBeUndefined()
  })

  it('503s queue_full on backpressure refusal', async () => {
    storeMock.enqueueJob.mockResolvedValue({ refused: 'queue_full' })
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(503)
    expect((await res.json()).reason).toBe('queue_full')
  })

  it('stands the job down when the durable row cannot be created — no unwatchable runs', async () => {
    toolRunsMock.createToolRun.mockRejectedValue(new Error('insert failed'))
    const res = await createPost(post({ tool: 'deep-research', brief: 'why is churn rising' }))
    expect(res.status).toBe(500)
    expect(storeMock.cancelJob).toHaveBeenCalledWith('j1')
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

  it('a cancel that lost the race (already terminal) still returns the current view', async () => {
    toolRunsMock.cancelToolRun.mockResolvedValue(null)
    toolRunsMock.getToolRunOwned.mockResolvedValue({ ...QUEUED_RUN, status: 'succeeded', resultMd: '# done' })
    const body = await (await detailPost(cancelReq(), { params: { id: 'r1' } })).json()
    expect(storeMock.cancelJob).not.toHaveBeenCalled()
    expect(body.run.liveStatus).toBe('succeeded')
  })
})
