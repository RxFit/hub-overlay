// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderQueryHook, settleQueries as settle, jsonResponse } from './query-test-utils'
import { useCompanies } from './useCompanies'
import { useProjects } from './useProjects'

describe('useCompanies / useProjects (TanStack Query-backed)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('useCompanies maps the payload and refetch() revalidates', async () => {
    const c1 = { id: 'c1', name: 'Acme' }
    const c2 = { id: 'c2', name: 'Globex' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ companies: [c1] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useCompanies())
    await settle()

    // Same return shape as before: companies / isLoading / error / refetch.
    expect(result.current.companies).toEqual([c1])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()

    fetchMock.mockResolvedValue(jsonResponse({ companies: [c1, c2] }))
    await act(async () => { await result.current.refetch() })
    await settle()
    expect(result.current.companies).toEqual([c1, c2])

    unmount()
  })

  it('useCompanies surfaces the server error message and falls back to []', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Paperclip down' }, 502),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useCompanies())
    await settle()

    expect(result.current.companies).toEqual([])
    expect((result.current.error as Error)?.message).toBe('Paperclip down')

    unmount()
  })

  it('useProjects maps the payload with the same return shape', async () => {
    const p1 = { id: 'p1', name: 'Website', companyName: 'Acme' }
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ projects: [p1] }),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useProjects())
    await settle()

    expect(result.current.projects).toEqual([p1])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(typeof result.current.refetch).toBe('function')

    unmount()
  })
})
