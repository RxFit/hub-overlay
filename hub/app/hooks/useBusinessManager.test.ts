// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderQueryHook, settleQueries as settle, jsonResponse } from './query-test-utils'
import { useBusinessManager } from './useBusinessManager'

describe('useBusinessManager (TanStack Query-backed)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('maps the CEO pulse record and derives health/org fields', async () => {
    const pulse = { org: 'RxFit', globalHealthPct: 87 }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(pulse))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useBusinessManager('org-1'))
    await settle()

    // Same return shape as the SWR hook: pulse / globalHealthPct / orgName /
    // isLoading / error / mutate.
    expect(result.current.pulse).toEqual(pulse)
    expect(result.current.globalHealthPct).toBe(87)
    expect(result.current.orgName).toBe('RxFit')
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledWith('/api/paperclip/ceo-pulse?orgId=org-1')

    // Bare mutate() = revalidate.
    const pulse2 = { org: 'RxFit', globalHealthPct: 91 }
    fetchMock.mockResolvedValue(jsonResponse(pulse2))
    await act(async () => { await result.current.mutate() })
    await settle()
    expect(result.current.globalHealthPct).toBe(91)

    unmount()
  })

  it('defaults to safe values while data is missing', async () => {
    global.fetch = vi.fn(() => new Promise<Response>(() => { /* never resolves */ })) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useBusinessManager())
    expect(result.current.pulse).toBeNull()
    expect(result.current.globalHealthPct).toBe(0)
    expect(result.current.orgName).toBe('')
    expect(result.current.isLoading).toBe(true)

    unmount()
  })
})
