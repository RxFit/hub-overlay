import { describe, it, expect, vi } from 'vitest'
import { describeUpstreamError, fetchWithRetry, mapLimit } from './http'

const noSleep = async () => {}

describe('fetchWithRetry', () => {
  it('retries 429 and 5xx, then returns the success', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }))
    const res = await fetchWithRetry(f, 'https://x', {}, noSleep)
    expect(res.status).toBe(200)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('returns a deterministic 4xx on the first attempt — even when the URL contains "500"', async () => {
    const f = vi.fn().mockResolvedValue(new Response('', { status: 403 }))
    const res = await fetchWithRetry(f, 'https://x/o/gmail-500.html', {}, noSleep)
    expect(res.status).toBe(403)
    expect(f).toHaveBeenCalledOnce()
  })

  it('hands back the last 5xx after exhausting retries', async () => {
    const f = vi.fn().mockImplementation(async () => new Response('', { status: 502 }))
    const res = await fetchWithRetry(f, 'https://x', {}, noSleep)
    expect(res.status).toBe(502)
    expect(f).toHaveBeenCalledTimes(3)
  })

  it('retries a socket error but never an abort', async () => {
    const flaky = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(new Response(''))
    expect((await fetchWithRetry(flaky, 'https://x', {}, noSleep)).status).toBe(200)

    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const aborted = vi.fn().mockRejectedValue(abort)
    await expect(fetchWithRetry(aborted, 'https://x', {}, noSleep)).rejects.toBe(abort)
    expect(aborted).toHaveBeenCalledOnce()
  })
})

describe('describeUpstreamError', () => {
  it('reads Google and Stripe error shapes', () => {
    expect(describeUpstreamError('{"error":{"status":"PERMISSION_DENIED","message":"nope"}}')).toBe('PERMISSION_DENIED: nope')
    expect(describeUpstreamError('{"error":{"message":"No such customer"}}')).toBe('No such customer')
    expect(describeUpstreamError('')).toBe('(empty error body)')
  })
})

describe('mapLimit', () => {
  it('preserves order and bounds concurrency', async () => {
    let inFlight = 0
    let peak = 0
    const out = await mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([10, 20, 30, 40, 50, 60])
    expect(peak).toBe(2)
  })

  it('rejects when any item fails', async () => {
    await expect(mapLimit([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })).rejects.toThrow('boom')
  })
})
