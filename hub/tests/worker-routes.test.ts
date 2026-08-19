import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * /api/worker/* — machine-auth contract of the Phase 2.5 dispatch routes.
 *
 * dispatch-store is mocked; what these tests lock:
 *  - 503 when AGY_WORKER_SECRET is unset (the kill switch), 401 on mismatch,
 *  - claim returns a job or 204, upserts liveness, reaps lazily,
 *  - result posting relays the CAS outcome verbatim and writes the discarded
 *    ledger row (spend visibility) but never a row for recorded/duplicate,
 *  - heartbeat relays cancelRequested (the pull-based cancel channel).
 */

const store = vi.hoisted(() => ({
  claimNext: vi.fn(),
  reapExpired: vi.fn(),
  upsertWorker: vi.fn(),
  heartbeatJob: vi.fn(),
  postResult: vi.fn(),
  isMissingTableError: (err: unknown) => (err as { code?: string } | null)?.code === '42P01',
}))
const ledger = vi.hoisted(() => ({ recordAiRun: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/dispatch-store', () => store)
vi.mock('@/lib/runs', () => ledger)

import { POST as claimPost } from '@/app/api/worker/claim/route'
import { POST as heartbeatPost } from '@/app/api/worker/jobs/[id]/heartbeat/route'
import { POST as resultPost } from '@/app/api/worker/jobs/[id]/result/route'

const SECRET = 'worker-secret-for-tests'

function request(path: string, body: unknown, secret: string | null = SECRET): NextRequest {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: secret === null ? {} : { 'x-worker-secret': secret },
  })
}

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('AGY_WORKER_SECRET', SECRET)
  store.claimNext.mockReset().mockResolvedValue(null)
  store.reapExpired.mockReset().mockResolvedValue(undefined)
  store.upsertWorker.mockReset().mockResolvedValue(undefined)
  store.heartbeatJob.mockReset()
  store.postResult.mockReset()
  ledger.recordAiRun.mockClear()
})

describe('machine auth (all three routes)', () => {
  it('503s when the secret is unconfigured — the kill switch', async () => {
    vi.stubEnv('AGY_WORKER_SECRET', '')
    const res = await claimPost(request('/api/worker/claim', { workerId: 'w1' }))
    expect(res.status).toBe(503)
  })

  it('401s on a wrong secret without touching the store', async () => {
    const res = await claimPost(request('/api/worker/claim', { workerId: 'w1' }, 'wrong'))
    expect(res.status).toBe(401)
    expect(store.upsertWorker).not.toHaveBeenCalled()
  })
})

describe('POST /api/worker/claim', () => {
  it('400s without a workerId', async () => {
    const res = await claimPost(request('/api/worker/claim', {}))
    expect(res.status).toBe(400)
  })

  it('claims: upserts liveness, reaps, returns the job with the hub SHA', async () => {
    vi.stubEnv('GIT_SHA', 'deadbeef')
    const job = { id: 'j1', kind: 'chat_turn', attempt: 1, payloadText: 'p', heartbeatMs: 10_000 }
    store.claimNext.mockResolvedValue(job)
    const res = await claimPost(
      request('/api/worker/claim', { workerId: 'w1', kinds: ['chat_turn'], version: 'abc' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.job.id).toBe('j1')
    expect(body.hubSha).toBe('deadbeef')
    expect(store.upsertWorker).toHaveBeenCalledWith('w1', { version: 'abc', agyVersion: undefined })
    expect(store.reapExpired).toHaveBeenCalled()
  })

  it('204s when the wait expires with nothing to claim', async () => {
    const res = await claimPost(request('/api/worker/claim', { workerId: 'w1', waitMs: 0 }))
    expect(res.status).toBe(204)
  })

  it('503s dispatch_unavailable when the tables are missing', async () => {
    store.upsertWorker.mockRejectedValue(Object.assign(new Error('no table'), { code: '42P01' }))
    const res = await claimPost(request('/api/worker/claim', { workerId: 'w1' }))
    expect(res.status).toBe(503)
  })
})

describe('POST /api/worker/jobs/[id]/heartbeat', () => {
  it('relays cancelRequested — the pull-based cancel channel', async () => {
    store.heartbeatJob.mockResolvedValue({ ok: true, cancelRequested: true })
    const res = await heartbeatPost(request('/api/worker/jobs/j1/heartbeat', { workerId: 'w1', attempt: 1 }), {
      params: { id: 'j1' },
    })
    expect(await res.json()).toEqual({ ok: true, cancelRequested: true })
    expect(store.heartbeatJob).toHaveBeenCalledWith('j1', 'w1', 1)
  })

  it('relays lease_lost so the worker aborts the run', async () => {
    store.heartbeatJob.mockResolvedValue({ ok: false, reason: 'lease_lost' })
    const res = await heartbeatPost(request('/api/worker/jobs/j1/heartbeat', { workerId: 'w1', attempt: 1 }), {
      params: { id: 'j1' },
    })
    expect(await res.json()).toEqual({ ok: false, reason: 'lease_lost' })
  })
})

describe('POST /api/worker/jobs/[id]/result', () => {
  const base = { workerId: 'w1', attempt: 1, status: 'ok', text: 'answer', latencyMs: 900 }

  it('recorded: relays the outcome and writes NO ledger row (the waiting request owns it)', async () => {
    store.postResult.mockResolvedValue({ outcome: 'recorded', prompt: 'p', requestId: 'r1' })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'recorded' })
    expect(ledger.recordAiRun).not.toHaveBeenCalled()
  })

  it('duplicate: byte-identical ack, no second ledger row', async () => {
    store.postResult.mockResolvedValue({ outcome: 'duplicate' })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'duplicate' })
    expect(ledger.recordAiRun).not.toHaveBeenCalled()
  })

  it('discarded_cancelled: the spend is ledgered with meta.discarded', async () => {
    store.postResult.mockResolvedValue({ outcome: 'discarded_cancelled', prompt: 'the prompt', requestId: 'r1' })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'discarded_cancelled' })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'agy',
        status: 'ok',
        prompt: 'the prompt',
        requestId: 'r1',
        meta: expect.objectContaining({ dispatch: true, discarded: true, jobId: 'j1', workerId: 'w1' }),
      }),
    )
  })

  it('404s for an unknown job', async () => {
    store.postResult.mockResolvedValue({ outcome: 'not_found' })
    const res = await resultPost(request('/api/worker/jobs/nope/result', base), { params: { id: 'nope' } })
    expect(res.status).toBe(404)
  })

  it('400s on a malformed body', async () => {
    const res = await resultPost(request('/api/worker/jobs/j1/result', { workerId: 'w1' }), { params: { id: 'j1' } })
    expect(res.status).toBe(400)
  })
})
