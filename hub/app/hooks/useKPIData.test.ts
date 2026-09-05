// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderQueryHook, settleQueries, jsonResponse } from './query-test-utils'
import { useKPIData, fetcher } from './useKPIData'

/* ════════════════════════════════════════════════════════════════════════════
   useKPIData + its exported fetcher (NS-11). The load-bearing contract is the
   401 → signIn('google') reauth flow inherited from useWriteFetch (an explicit
   `{ reauth: false }` must NOT bounce the user to Google), plus the
   companyId → query-key/url mapping and the safe [] defaults.
   ════════════════════════════════════════════════════════════════════════════ */

const { signInMock } = vi.hoisted(() => ({ signInMock: vi.fn() }))
vi.mock('next-auth/react', () => ({ signIn: signInMock }))

afterEach(() => {
  vi.unstubAllGlobals()
  signInMock.mockReset()
})

describe('fetcher — 401 reauth contract', () => {
  it('triggers signIn(google) and throws a 401-tagged error on a default 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'expired' }, 401)))
    await expect(fetcher('/api/kpis')).rejects.toMatchObject({ message: 'expired', status: 401 })
    expect(signInMock).toHaveBeenCalledWith('google')
  })

  it('honors an explicit { reauth: false } 401 — throws WITHOUT bouncing to Google', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'nope', reauth: false }, 401)))
    await expect(fetcher('/api/kpis')).rejects.toMatchObject({ status: 401 })
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('tags non-401 failures with their status and surfaces the server error message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ error: 'kpi backend down' }, 503)))
    await expect(fetcher('/api/kpis')).rejects.toMatchObject({ message: 'kpi backend down', status: 503 })
    expect(signInMock).not.toHaveBeenCalled()
  })

  it('falls back to a generic status message when the error body is not JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, json: async () => { throw new Error('not json') },
    }) as unknown as Response))
    await expect(fetcher('/api/kpis')).rejects.toMatchObject({ message: 'API error 500', status: 500 })
  })

  it('returns the parsed JSON on success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ kpis: [1] })))
    await expect(fetcher('/api/kpis')).resolves.toEqual({ kpis: [1] })
  })
})

describe('useKPIData — url mapping + defaults', () => {
  it('queries /api/kpis for the "all" sentinel and undefined, scoping only real company ids', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url))
      return jsonResponse({ kpis: [], projects: [] })
    }))

    const all = renderQueryHook(() => useKPIData('all'))
    await settleQueries()
    all.unmount()

    const scoped = renderQueryHook(() => useKPIData('acme co'))
    await settleQueries()
    scoped.unmount()

    expect(urls[0]).toBe('/api/kpis')
    expect(urls[1]).toBe('/api/kpis?companyId=acme%20co') // encoded
  })

  it('returns the fetched kpis/projects, and safe [] defaults while loading', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      kpis: [{ id: 'mrr' }],
      projects: [{ id: 'p1', score: 82 }],
    })))
    const { result, unmount } = renderQueryHook(() => useKPIData())
    // Before settle: never undefined.
    expect(result.current.kpis).toEqual([])
    expect(result.current.projects).toEqual([])

    await settleQueries()
    expect(result.current.kpis).toEqual([{ id: 'mrr' }])
    expect(result.current.projects).toEqual([{ id: 'p1', score: 82 }])
    expect(result.current.error).toBeUndefined()
    unmount()
  })

  it('surfaces an in-band error field from a 200 payload (degraded KPI sources)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      kpis: [], projects: [], error: 'stripe source failed',
    })))
    const { result, unmount } = renderQueryHook(() => useKPIData())
    await settleQueries()
    expect(result.current.error).toBe('stripe source failed')
    unmount()
  })

  it('preserves the degraded flag from a partial-success response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      kpis: [{ id: 'mrr' }], projects: [], degraded: true,
    })))
    const { result, unmount } = renderQueryHook(() => useKPIData())
    await settleQueries()
    expect(result.current.degraded).toBe(true)
    expect(result.current.kpis).toEqual([{ id: 'mrr' }])
    expect(result.current.error).toBeUndefined()
    unmount()
  })
})
