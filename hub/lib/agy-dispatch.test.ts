import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * lib/agy-dispatch.ts — Hub-side desktop dispatch (Phase 2.5).
 *
 * dispatch-store is mocked; these tests lock the never-stall ladder:
 *  - misconfiguration and a missing/dead worker throw typed errors instantly
 *    (never a hang), so tryAgyChat's existing catch falls through to metered,
 *  - a job the worker never claims dies at the claim window, not the budget,
 *  - a lapsed lease fails fast without waiting for the reaper,
 *  - every abandonment path cancels the job so the worker stands down,
 *  - the success path maps the store row back into the AgyResult contract.
 */

const store = vi.hoisted(() => ({
  workerFresh: vi.fn(),
  enqueueJob: vi.fn(),
  getJobView: vi.fn(),
  deliverResult: vi.fn(),
  cancelJob: vi.fn(),
}))

vi.mock('@/lib/dispatch-store', () => store)
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { agyErrorType } from './agy'
import { dispatchGenerateText, isDispatchConfigured, isDispatchEnabled } from './agy-dispatch'

beforeEach(() => {
  vi.unstubAllEnvs()
  vi.stubEnv('AGY_WORKER_SECRET', 'test-secret')
  // Fast ladder for tests: tiny claim window; budgets set per test.
  vi.stubEnv('AGY_DISPATCH_CLAIM_TIMEOUT_MS', '300')
  store.workerFresh.mockReset().mockResolvedValue(true)
  store.enqueueJob.mockReset().mockResolvedValue({ id: 'job-1' })
  store.getJobView.mockReset()
  store.deliverResult.mockReset()
  store.cancelJob.mockReset().mockResolvedValue(undefined)
})

describe('flag probes', () => {
  it('isDispatchEnabled reads AGY_DISPATCH_ENABLED true/1', () => {
    expect(isDispatchEnabled()).toBe(false)
    vi.stubEnv('AGY_DISPATCH_ENABLED', 'true')
    expect(isDispatchEnabled()).toBe(true)
    vi.stubEnv('AGY_DISPATCH_ENABLED', '1')
    expect(isDispatchEnabled()).toBe(true)
  })

  it('isDispatchConfigured requires the worker secret', () => {
    expect(isDispatchConfigured()).toBe(true)
    vi.stubEnv('AGY_WORKER_SECRET', '')
    expect(isDispatchConfigured()).toBe(false)
  })
})

describe('dispatchGenerateText — the never-stall ladder', () => {
  it('throws not_configured without a worker secret (before any DB read)', async () => {
    vi.stubEnv('AGY_WORKER_SECRET', '')
    await expect(dispatchGenerateText('p', { budgetMs: 5_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'not_configured',
    )
    expect(store.workerFresh).not.toHaveBeenCalled()
  })

  it('throws no_worker when no worker is fresh — one read, no enqueue', async () => {
    store.workerFresh.mockResolvedValue(false)
    await expect(dispatchGenerateText('p', { budgetMs: 5_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'no_worker',
    )
    expect(store.enqueueJob).not.toHaveBeenCalled()
  })

  it('treats a liveness read failure (e.g. missing table) as no_worker', async () => {
    store.workerFresh.mockRejectedValue(Object.assign(new Error('relation does not exist'), { code: '42P01' }))
    await expect(dispatchGenerateText('p', { budgetMs: 5_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'no_worker',
    )
  })

  it('throws queue_full when enqueue refuses (backpressure)', async () => {
    store.enqueueJob.mockResolvedValue({ refused: 'queue_full' })
    await expect(dispatchGenerateText('p', { budgetMs: 5_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'queue_full',
    )
  })

  it('dies at the claim window when the job is never claimed, and cancels it', async () => {
    store.getJobView.mockResolvedValue({ state: 'queued', leaseExpiresAt: null, errorClass: null, error: null })
    await expect(dispatchGenerateText('p', { budgetMs: 10_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'claim_timeout',
    )
    expect(store.cancelJob).toHaveBeenCalledWith('job-1')
  })

  it('maps a succeeded job back into the AgyResult contract', async () => {
    store.getJobView
      .mockResolvedValueOnce({ state: 'leased', leaseExpiresAt: new Date(Date.now() + 25_000), errorClass: null, error: null })
      .mockResolvedValue({ state: 'succeeded', leaseExpiresAt: null, errorClass: null, error: null })
    store.deliverResult.mockResolvedValue({
      text: 'hello from the desktop',
      resultMeta: { model: 'gemini-3-flash', usage: { cacheReadTokens: 12 }, workerId: 'danny-desktop', latencyMs: 900 },
    })
    const result = await dispatchGenerateText('p', { budgetMs: 10_000, requestId: 'req-9' })
    expect(result.text).toBe('hello from the desktop')
    expect(result.model).toBe('gemini-3-flash')
    expect(result.usage).toEqual({ cacheReadTokens: 12 })
    expect(result.raw).toMatchObject({ dispatch: true, jobId: 'job-1', workerId: 'danny-desktop' })
    expect(store.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'chat_turn', prompt: 'p', requestId: 'req-9' }),
    )
  })

  it('propagates a worker-reported failure with its typed class', async () => {
    store.getJobView.mockResolvedValue({ state: 'failed', leaseExpiresAt: null, errorClass: 'auth', error: 'token dead' })
    await expect(dispatchGenerateText('p', { budgetMs: 10_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'auth',
    )
  })

  it('fails fast on a lapsed lease — never waits for the reaper', async () => {
    store.getJobView.mockResolvedValue({
      state: 'leased',
      leaseExpiresAt: new Date(Date.now() - 1_000),
      errorClass: null,
      error: null,
    })
    await expect(dispatchGenerateText('p', { budgetMs: 30_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'lease_expired',
    )
    expect(store.cancelJob).toHaveBeenCalledWith('job-1')
  })

  it('exhausts the budget as timeout and cancels the job', async () => {
    store.getJobView.mockResolvedValue({
      state: 'leased',
      leaseExpiresAt: new Date(Date.now() + 60_000),
      errorClass: null,
      error: null,
    })
    await expect(dispatchGenerateText('p', { budgetMs: 600 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'timeout',
    )
    expect(store.cancelJob).toHaveBeenCalledWith('job-1')
  })

  it('a pre-aborted signal throws abort and cancels without polling', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(
      dispatchGenerateText('p', { budgetMs: 10_000, signal: controller.signal }),
    ).rejects.toSatisfy((e: unknown) => agyErrorType(e) === 'abort')
    expect(store.cancelJob).toHaveBeenCalledWith('job-1')
    expect(store.getJobView).not.toHaveBeenCalled()
  })

  it('wraps a mid-wait store failure as no_worker and cancels', async () => {
    store.getJobView.mockRejectedValue(new Error('db hiccup'))
    await expect(dispatchGenerateText('p', { budgetMs: 10_000 })).rejects.toSatisfy(
      (e: unknown) => agyErrorType(e) === 'no_worker',
    )
    expect(store.cancelJob).toHaveBeenCalledWith('job-1')
  })
})
