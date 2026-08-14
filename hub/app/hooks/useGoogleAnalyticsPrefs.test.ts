/** @vitest-environment jsdom */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderQueryHook, settleQueries, settleUntil } from './query-test-utils'
import {
  useGooglePrefs,
  useGA4Properties,
  useGSCSites,
  useSaveGooglePrefs,
} from './useGoogleAnalyticsPrefs'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('useGooglePrefs', () => {
  it('returns the effective configuration', async () => {
    stubFetch(() => json({ prefs: { ga4PropertyId: '123', gscSiteUrl: 'https://x.test/' } }))

    const { result, unmount } = renderQueryHook(() => useGooglePrefs())
    await settleUntil(() => !!result.current.prefs.ga4PropertyId)

    expect(result.current.prefs).toMatchObject({ ga4PropertyId: '123', gscSiteUrl: 'https://x.test/' })
    unmount()
  })

  it('flags a 403 as forbidden rather than a failure', async () => {
    // Staff hitting the admin-gated settings API is a normal state, not an error.
    stubFetch(() => json({ error: 'Forbidden' }, 403))

    const { result, unmount } = renderQueryHook(() => useGooglePrefs())
    await settleUntil(() => result.current.forbidden)

    expect(result.current.forbidden).toBe(true)
    expect(result.current.prefs).toEqual({})
    unmount()
  })
})

describe('useGA4Properties', () => {
  it('does not fetch until enabled', async () => {
    // The pickers cost extra Google round trips most Settings visits don't need.
    const fetchMock = stubFetch(() => json({ properties: [] }))

    const { unmount } = renderQueryHook(() => useGA4Properties(false))
    await settleQueries()

    expect(fetchMock).not.toHaveBeenCalled()
    unmount()
  })

  it('fetches properties once enabled', async () => {
    const fetchMock = stubFetch(() =>
      json({ properties: [{ propertyId: '1', displayName: 'Site', accountName: 'Acct' }] }),
    )

    const { result, unmount } = renderQueryHook(() => useGA4Properties(true))
    // An `enabled` query only starts after the first commit, so wait on the
    // observable condition rather than a fixed tick budget.
    await settleUntil(() => result.current.properties.length > 0)

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(result.current.properties).toHaveLength(1)
    unmount()
  })

  it('surfaces MISSING_SCOPE so the UI can offer re-consent', async () => {
    stubFetch(() => json({ error: 'not granted', code: 'MISSING_SCOPE' }, 403))

    const { result, unmount } = renderQueryHook(() => useGA4Properties(true))
    await settleUntil(() => result.current.missingScope)

    expect(result.current.missingScope).toBe(true)
    expect(result.current.apiNotEnabled).toBe(false)
    unmount()
  })

  it('surfaces API_NOT_ENABLED distinctly, with the console activation link', async () => {
    // A disabled Cloud API must NOT read as a consent problem — offering
    // re-consent for it is the Settings → Authorize → consent → Authorize loop.
    stubFetch(() =>
      json(
        {
          error: 'Google Analytics is unavailable: a Google API this feature needs is not enabled…',
          code: 'API_NOT_ENABLED',
          activationUrl: 'https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=1',
        },
        403,
      ),
    )

    const { result, unmount } = renderQueryHook(() => useGA4Properties(true))
    await settleUntil(() => result.current.apiNotEnabled)

    expect(result.current.apiNotEnabled).toBe(true)
    expect(result.current.missingScope).toBe(false)
    expect(result.current.activationUrl).toBe(
      'https://console.developers.google.com/apis/api/analyticsadmin.googleapis.com/overview?project=1',
    )
    unmount()
  })
})

describe('useGSCSites', () => {
  it('fetches sites when enabled', async () => {
    stubFetch(() => json({ sites: [{ siteUrl: 'https://x.test/', permissionLevel: 'siteOwner' }] }))

    const { result, unmount } = renderQueryHook(() => useGSCSites(true))
    await settleUntil(() => result.current.sites.length > 0)

    expect(result.current.sites).toEqual([{ siteUrl: 'https://x.test/', permissionLevel: 'siteOwner' }])
    unmount()
  })

  it('surfaces API_NOT_ENABLED distinctly (same contract as the GA4 hook)', async () => {
    stubFetch(() => json({ error: 'API disabled', code: 'API_NOT_ENABLED' }, 403))

    const { result, unmount } = renderQueryHook(() => useGSCSites(true))
    await settleUntil(() => result.current.apiNotEnabled)

    expect(result.current.apiNotEnabled).toBe(true)
    expect(result.current.missingScope).toBe(false)
    unmount()
  })
})

describe('useSaveGooglePrefs', () => {
  it('PUTs the values and reports success', async () => {
    const fetchMock = stubFetch(() => json({ prefs: { ga4PropertyId: '123' } }))

    const { result, unmount } = renderQueryHook(() => useSaveGooglePrefs())
    const ok = await result.current.save({ ga4PropertyId: '123' })

    expect(ok).toBe(true)
    const init = fetchMock.mock.calls[0][1]
    expect(init?.method).toBe('PUT')
    expect(JSON.parse(init?.body as string)).toMatchObject({ ga4PropertyId: '123' })
    unmount()
  })

  it('returns false with an error message instead of throwing', async () => {
    // The component shows this inline; an unhandled throw would blank the section.
    stubFetch(() => json({ error: 'database unavailable' }, 500))

    const { result, unmount } = renderQueryHook(() => useSaveGooglePrefs())
    const ok = await result.current.save({ ga4PropertyId: '123' })

    expect(ok).toBe(false)
    unmount()
  })
})
