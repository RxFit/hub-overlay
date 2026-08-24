import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/admin/work-probe — the deep lane's PR-A gate
 * (docs/architecture/DEEP_LANE_2026-08-23.md §8).
 *
 * Locks: the admin gate; POST enqueues a marker work_item (never any other
 * kind); GET refuses non-probe jobs (deliverResult is read-once — delivering
 * a chat job here would steal its waiting reader's answer); the verdict is
 * marker round-trip AND timestamp freshness, so a hallucinated "fetch"
 * cannot PASS; and the freshness matcher itself.
 */

const { sessionMock, adminMock, storeMock, dispatchMock } = vi.hoisted(() => ({
  sessionMock: vi.fn(),
  adminMock: vi.fn(),
  storeMock: {
    enqueueJob: vi.fn(),
    getJobDetail: vi.fn(),
    deliverResult: vi.fn(),
    workerFresh: vi.fn(),
    isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
  },
  dispatchMock: {
    dispatchFreshMs: () => 45_000,
    isDispatchConfigured: () => true,
    isDispatchEnabled: () => true,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: sessionMock }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/roles', () => ({ canAccessAdminRoute: adminMock }))
vi.mock('@/lib/dispatch-store', () => storeMock)
vi.mock('@/lib/agy-dispatch', () => dispatchMock)
vi.mock('@/lib/observability', () => ({ emit: vi.fn() }))

import { POST, GET, containsFreshTimestamp } from '@/app/api/admin/work-probe/route'

function post(body: unknown = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/admin/work-probe', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

function get(jobId?: string): NextRequest {
  const qs = jobId ? `?jobId=${jobId}` : ''
  return new NextRequest(`http://localhost:3000/api/admin/work-probe${qs}`)
}

beforeEach(() => {
  sessionMock.mockReset().mockResolvedValue({ user: { email: 'admin@rxfitatx.com', role: 'admin' } })
  adminMock.mockReset().mockReturnValue(true)
  storeMock.enqueueJob.mockReset().mockResolvedValue({ id: 'job-1' })
  storeMock.getJobDetail.mockReset()
  storeMock.deliverResult.mockReset()
  storeMock.workerFresh.mockReset().mockResolvedValue(true)
})

describe('admin gate', () => {
  it('401s without a session, 403s for non-admins, on both verbs', async () => {
    sessionMock.mockResolvedValue(null)
    expect((await POST(post())).status).toBe(401)
    expect((await GET(get('j'))).status).toBe(401)
    sessionMock.mockResolvedValue({ user: { email: 'staff@rxfitatx.com', role: 'staff' } })
    adminMock.mockReturnValue(false)
    expect((await POST(post())).status).toBe(403)
    expect((await GET(get('j'))).status).toBe(403)
    expect(storeMock.enqueueJob).not.toHaveBeenCalled()
  })
})

describe('POST /api/admin/work-probe', () => {
  it('enqueues a work_item carrying probe meta and a random marker', async () => {
    const res = await POST(post())
    const body = await res.json()
    expect(body.jobId).toBe('job-1')
    expect(body.marker).toMatch(/^AGY_WORK_PROBE_/)
    expect(storeMock.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'work_item',
        meta: expect.objectContaining({ probe: true, marker: body.marker }),
      }),
    )
    // The prompt demands a live fetch and round-trips the marker.
    const input = storeMock.enqueueJob.mock.calls[0][0]
    expect(input.prompt).toContain(body.marker)
    expect(input.prompt).toContain('fetch')
  })

  it('reports worker freshness as advisory context, never as a gate', async () => {
    storeMock.workerFresh.mockResolvedValue(false)
    const res = await POST(post())
    expect(res.status).toBe(200) // still enqueued — proving deadline expiry is legitimate
    const body = await res.json()
    expect(body.workerFresh).toBe(false)
  })

  it('503s when the work queue refuses (backpressure)', async () => {
    storeMock.enqueueJob.mockResolvedValue({ refused: 'queue_full' })
    expect((await POST(post())).status).toBe(503)
  })

  it('400s a non-http(s) url override', async () => {
    expect((await POST(post({ url: 'file:///etc/passwd' }))).status).toBe(400)
    expect(storeMock.enqueueJob).not.toHaveBeenCalled()
  })
})

describe('GET /api/admin/work-probe', () => {
  const probeJob = {
    state: 'succeeded',
    kind: 'work_item',
    attempt: 1,
    maxAttempts: 3,
    errorClass: null,
    error: null,
    latencyMs: 60_000,
    leaseExpiresAt: null,
    deadlineAt: new Date(Date.now() + 60_000),
    finishedAt: new Date(),
    payloadMeta: { probe: true, marker: 'AGY_WORK_PROBE_abc' },
    resultMeta: { model: 'gemini-3', latencyMs: 58_000 },
  }

  it('400s without jobId and 404s an unknown job', async () => {
    expect((await GET(get())).status).toBe(400)
    storeMock.getJobDetail.mockResolvedValue(null)
    expect((await GET(get('nope'))).status).toBe(404)
  })

  it('refuses to deliver a non-probe job — read-once delivery belongs to its waiting reader', async () => {
    storeMock.getJobDetail.mockResolvedValue({ ...probeJob, payloadMeta: { toolRunId: 'tr-1' } })
    const res = await GET(get('job-1'))
    expect(res.status).toBe(400)
    expect(storeMock.deliverResult).not.toHaveBeenCalled()
  })

  it('PASS: marker round-trips AND the reply carries a fresh timestamp', async () => {
    storeMock.getJobDetail.mockResolvedValue(probeJob)
    storeMock.deliverResult.mockResolvedValue({
      text: `AGY_WORK_PROBE_abc\n${new Date().toISOString()}`,
      resultMeta: probeJob.resultMeta,
    })
    const body = await (await GET(get('job-1'))).json()
    expect(body.verdict).toBe('PASS')
    expect(body.markerVerified).toBe(true)
    expect(body.freshnessVerified).toBe(true)
    expect(body.model).toBe('gemini-3')
  })

  it('FAIL: a marker without live-fetch evidence cannot pass (hallucination guard)', async () => {
    storeMock.getJobDetail.mockResolvedValue(probeJob)
    storeMock.deliverResult.mockResolvedValue({
      text: 'AGY_WORK_PROBE_abc\n2024-01-01T00:00:00Z', // stale timestamp — no wall clock
      resultMeta: null,
    })
    const body = await (await GET(get('job-1'))).json()
    expect(body.verdict).toBe('FAIL')
    expect(body.markerVerified).toBe(true)
    expect(body.freshnessVerified).toBe(false)
  })

  it('FAIL: an honest NO_TOOLS self-report fails even with marker and a lucky timestamp', async () => {
    storeMock.getJobDetail.mockResolvedValue(probeJob)
    storeMock.deliverResult.mockResolvedValue({
      text: `AGY_WORK_PROBE_abc\nNO_TOOLS: web tools unavailable ${new Date().toISOString()}`,
      resultMeta: null,
    })
    const body = await (await GET(get('job-1'))).json()
    expect(body.verdict).toBe('FAIL')
    expect(body.noToolsReported).toBe(true)
  })

  it('terminal failures carry the typed class as the verdict', async () => {
    storeMock.getJobDetail.mockResolvedValue({ ...probeJob, state: 'expired', errorClass: 'deadline' })
    const body = await (await GET(get('job-1'))).json()
    expect(body.verdict).toBe('FAIL')
    expect(body.errorClass).toBe('deadline')
    expect(storeMock.deliverResult).not.toHaveBeenCalled()
  })

  it('a leased probe reports running with lease freshness', async () => {
    storeMock.getJobDetail.mockResolvedValue({
      ...probeJob,
      state: 'leased',
      leaseExpiresAt: new Date(Date.now() + 100_000),
    })
    const body = await (await GET(get('job-1'))).json()
    expect(body.state).toBe('running')
    expect(body.leaseFresh).toBe(true)
  })

  it('a delivered probe re-poll reports the fact instead of a verdict', async () => {
    storeMock.getJobDetail.mockResolvedValue(probeJob)
    storeMock.deliverResult.mockResolvedValue(null) // already read once
    const body = await (await GET(get('job-1'))).json()
    expect(body.delivered).toBe(true)
    expect(body.verdict).toBeUndefined()
  })
})

describe('containsFreshTimestamp', () => {
  const now = Date.parse('2026-08-23T18:00:00Z')

  it('accepts ISO timestamps inside the window, in several shapes', () => {
    expect(containsFreshTimestamp('at 2026-08-23T17:55:00Z ok', now, 20 * 60_000)).toBe(true)
    // worldtimeapi's own shape: fractional seconds + numeric offset.
    expect(containsFreshTimestamp('"datetime":"2026-08-23T12:59:30.123456-05:00"', now, 20 * 60_000)).toBe(true)
  })

  it('rejects stale, future-far, and absent timestamps', () => {
    expect(containsFreshTimestamp('2026-08-23T16:00:00Z', now, 20 * 60_000)).toBe(false)
    expect(containsFreshTimestamp('2027-01-01T00:00:00Z', now, 20 * 60_000)).toBe(false)
    expect(containsFreshTimestamp('no timestamps here', now, 20 * 60_000)).toBe(false)
  })
})
