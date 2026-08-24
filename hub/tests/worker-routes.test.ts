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
  // Real derivation logic, inlined (incl. the uuid-shape guard): the route's
  // source labels are asserted against it below, so drift would fail loudly.
  toolRunIdFrom: (meta: Record<string, unknown> | null | undefined) =>
    meta && typeof meta.toolRunId === 'string' && /^[0-9a-f-]{36}$/i.test(meta.toolRunId) ? meta.toolRunId : null,
  workItemRunSource: (meta: Record<string, unknown> | null | undefined) =>
    meta && typeof meta.toolRunId === 'string' && /^[0-9a-f-]{36}$/i.test(meta.toolRunId)
      ? 'tool'
      : meta && meta.probe === true ? 'work_probe' : 'work',
}))
const ledger = vi.hoisted(() => ({ recordAiRun: vi.fn().mockResolvedValue(undefined) }))
const chatStore = vi.hoisted(() => ({ persistAssistantTurn: vi.fn().mockResolvedValue(undefined) }))

vi.mock('@/lib/dispatch-store', () => store)
vi.mock('@/lib/runs', () => ledger)
vi.mock('@/lib/chat-store', () => chatStore)
vi.mock('@/lib/observability', () => ({ emit: vi.fn() }))

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
  store.reapExpired.mockReset().mockResolvedValue({ cancelled: 0, requeued: 0, leaseExpired: 0, deadlineExpired: 0 })
  store.upsertWorker.mockReset().mockResolvedValue(undefined)
  store.heartbeatJob.mockReset()
  store.postResult.mockReset()
  ledger.recordAiRun.mockClear()
  chatStore.persistAssistantTurn.mockClear()
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
    const job = { id: 'j1', kind: 'chat_turn', attempt: 1, payloadText: 'p', heartbeatMs: 10_000, createdAt: new Date() }
    store.claimNext.mockResolvedValue(job)
    const res = await claimPost(
      request('/api/worker/claim', { workerId: 'w1', kinds: ['chat_turn'], version: 'abc' }),
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.job.id).toBe('j1')
    expect(body.hubSha).toBe('deadbeef')
    // kinds ride into the worker row as capability stamps (deep lane §6.3).
    expect(store.upsertWorker).toHaveBeenCalledWith('w1', { version: 'abc', agyVersion: undefined, kinds: ['chat_turn'] })
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

  it('recorded chat_turn: relays the outcome and writes NO ledger row (the waiting request owns it)', async () => {
    store.postResult.mockResolvedValue({ outcome: 'recorded', prompt: 'p', requestId: 'r1', kind: 'chat_turn', payloadMeta: null })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'recorded' })
    expect(ledger.recordAiRun).not.toHaveBeenCalled()
  })

  it('recorded work_item: THIS route ledgers the run — work items have no waiting reader', async () => {
    store.postResult.mockResolvedValue({ outcome: 'recorded', prompt: 'p', requestId: 'r1', kind: 'work_item', payloadMeta: null })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'recorded' })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'agy',
        source: 'work',
        status: 'ok',
        prompt: 'p',
        requestId: 'r1',
        meta: expect.objectContaining({ dispatch: true, jobId: 'j1', workerId: 'w1', outcome: 'recorded' }),
      }),
    )
    // recorded is a served result, not a discarded one.
    expect(ledger.recordAiRun.mock.calls[0][0].meta.discarded).toBeUndefined()
  })

  it('recorded work_item carries the probe / toolRunId identity into source and meta', async () => {
    store.postResult.mockResolvedValue({
      outcome: 'recorded', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: { probe: true, marker: 'AGY_WORK_PROBE_x' },
    })
    await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'work_probe', meta: expect.objectContaining({ probe: true }) }),
    )

    ledger.recordAiRun.mockClear()
    store.postResult.mockResolvedValue({
      outcome: 'recorded', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: { toolRunId: '11111111-1111-4111-8111-111111111111', userEmail: 'staff@rxfitatx.com' },
    })
    await resultPost(request('/api/worker/jobs/j2/result', base), { params: { id: 'j2' } })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'tool',
        userEmail: 'staff@rxfitatx.com',
        meta: expect.objectContaining({ toolRunId: '11111111-1111-4111-8111-111111111111' }),
      }),
    )
  })

  it('duplicate: byte-identical ack, no second ledger row', async () => {
    store.postResult.mockResolvedValue({ outcome: 'duplicate' })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'duplicate' })
    expect(ledger.recordAiRun).not.toHaveBeenCalled()
  })

  it('discarded_cancelled: the spend is ledgered with meta.discarded', async () => {
    store.postResult.mockResolvedValue({ outcome: 'discarded_cancelled', prompt: 'the prompt', requestId: 'r1', kind: 'chat_turn', payloadMeta: null })
    const res = await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(await res.json()).toEqual({ outcome: 'discarded_cancelled' })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({
        engine: 'agy',
        source: 'chat',
        status: 'ok',
        prompt: 'the prompt',
        requestId: 'r1',
        meta: expect.objectContaining({ dispatch: true, discarded: true, jobId: 'j1', workerId: 'w1' }),
      }),
    )
  })

  it('a landed deep run posts the completion pointer into its originating chat (PR D)', async () => {
    const report = '# Report\nbody\n```json\n{"title":"Churn is price-driven","summary":"s"}\n```'
    store.postResult.mockResolvedValue({
      outcome: 'recorded', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: { toolRunId: '11111111-1111-4111-8111-111111111111' },
      toolRun: { id: 'r1', tool: 'deep-research', userEmail: 'staff@rxfitatx.com', chatId: 'chat-7' },
    })
    await resultPost(request('/api/worker/jobs/j1/result', { ...base, text: report, model: 'gemini-3' }), { params: { id: 'j1' } })
    expect(chatStore.persistAssistantTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-7',
        userEmail: 'staff@rxfitatx.com',
        content: expect.stringContaining('Deep Research finished: Churn is price-driven'),
        model: 'gemini-3',
      }),
    )
  })

  it('no pointer without a chat, on failure, or for discarded results', async () => {
    // Run started outside any conversation → nothing to point into.
    store.postResult.mockResolvedValue({
      outcome: 'recorded', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: {}, toolRun: { id: 'r1', tool: 'deep-think', userEmail: 'staff@rxfitatx.com', chatId: null },
    })
    await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    // Worker error → the panel carries the failure; the chat gets no ghost note.
    store.postResult.mockResolvedValue({
      outcome: 'recorded', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: {}, toolRun: { id: 'r2', tool: 'deep-think', userEmail: 'staff@rxfitatx.com', chatId: 'chat-1' },
    })
    await resultPost(
      request('/api/worker/jobs/j2/result', { workerId: 'w1', attempt: 1, status: 'error', errorClass: 'timeout' }),
      { params: { id: 'j2' } },
    )
    // Cancelled mid-run → the user already knows; nothing lands.
    store.postResult.mockResolvedValue({
      outcome: 'discarded_cancelled', prompt: 'p', requestId: null, kind: 'work_item',
      payloadMeta: {}, toolRun: null,
    })
    await resultPost(request('/api/worker/jobs/j3/result', base), { params: { id: 'j3' } })
    expect(chatStore.persistAssistantTurn).not.toHaveBeenCalled()
  })

  it('discarded work_item is ledgered under its own source, never chat — the §7 hardcode fix', async () => {
    store.postResult.mockResolvedValue({ outcome: 'discarded_cancelled', prompt: 'p', requestId: null, kind: 'work_item', payloadMeta: { toolRunId: '99999999-9999-4999-8999-999999999999' } })
    await resultPost(request('/api/worker/jobs/j1/result', base), { params: { id: 'j1' } })
    expect(ledger.recordAiRun).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'tool', meta: expect.objectContaining({ discarded: true, toolRunId: '99999999-9999-4999-8999-999999999999' }) }),
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

  it('400s status:ok without non-empty text — empty output is never success, even at the wire', async () => {
    const res = await resultPost(
      request('/api/worker/jobs/j1/result', { workerId: 'w1', attempt: 1, status: 'ok', text: '   ' }),
      { params: { id: 'j1' } },
    )
    expect(res.status).toBe(400)
    expect(store.postResult).not.toHaveBeenCalled()
  })

  it('413s an oversized body via content-length before parsing', async () => {
    const req = new NextRequest('http://localhost:3000/api/worker/jobs/j1/result', {
      method: 'POST',
      body: '{}',
      headers: { 'x-worker-secret': SECRET, 'content-length': String(5_000_000) },
    })
    const res = await resultPost(req, { params: { id: 'j1' } })
    expect(res.status).toBe(413)
  })

  it('flattens and truncates worker-supplied error to the ≤300-char column contract', async () => {
    store.postResult.mockResolvedValue({ outcome: 'recorded', prompt: 'p', requestId: 'r1', kind: 'chat_turn', payloadMeta: null })
    await resultPost(
      request('/api/worker/jobs/j1/result', {
        workerId: 'w1',
        attempt: 1,
        status: 'error',
        errorClass: 'unknown',
        error: `line1\nline2   line3${'x'.repeat(500)}`,
      }),
      { params: { id: 'j1' } },
    )
    const stored = store.postResult.mock.calls[0][1].error as string
    expect(stored).not.toContain('\n')
    expect(stored.length).toBeLessThanOrEqual(301)
  })

  it('reduces worker-supplied usage to the four numeric counters — no content smuggling into result_meta', async () => {
    store.postResult.mockResolvedValue({ outcome: 'recorded', prompt: 'p', requestId: 'r1' })
    await resultPost(
      request('/api/worker/jobs/j1/result', {
        ...base,
        usage: { inputTokens: 120.6, echo: 'smuggled prompt text', nested: { deep: true }, outputTokens: 'NaN' },
      }),
      { params: { id: 'j1' } },
    )
    expect(store.postResult.mock.calls[0][1].usage).toEqual({ inputTokens: 121 })
  })
})
