// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderQueryHook, settleQueries as settle, jsonResponse } from './query-test-utils'

const signInMock = vi.fn()
vi.mock('next-auth/react', () => ({
  signIn: (...args: unknown[]) => signInMock(...args),
}))

import {
  useTasks,
  useCalendar,
  useDrive,
  useFeed,
  useAuthErrorRecovery,
} from './useHubData'

describe('useHubData hooks (TanStack Query-backed)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    signInMock.mockClear()
    global.fetch = originalFetch
  })

  it('useCalendar maps events, and mutate() revalidates (bare-mutate contract)', async () => {
    const e1 = { id: 'e1', start: {}, end: {}, htmlLink: '', status: 'confirmed' }
    const e2 = { id: 'e2', start: {}, end: {}, htmlLink: '', status: 'confirmed' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ events: [e1] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useCalendar())
    await settle()

    // Same return shape as the SWR hook: events / isLoading / error / mutate.
    expect(result.current.events).toEqual([e1])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()

    // Bare mutate() = revalidate: the query refetches and lands new data.
    fetchMock.mockResolvedValue(jsonResponse({ events: [e1, e2] }))
    await act(async () => { await result.current.mutate?.() })
    await settle()
    expect(result.current.events).toEqual([e1, e2])

    unmount()
  })

  it('useCalendar surfaces a status-tagged 401 error (auth branch preserved)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'nope' }, 401),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useCalendar())
    await settle()

    expect(result.current.events).toEqual([])
    expect((result.current.error as any)?.status).toBe(401)

    unmount()
  })

  it('useTasks fans out from lists to per-list tasks and keeps the same shape', async () => {
    const lists = [{ id: 'l1', title: 'Inbox', updated: 'u' }]
    const task = { id: 't1', title: 'Do it', status: 'needsAction', updated: 'u', position: '0' }
    const fetchMock = vi.fn((url: string) => {
      const u = String(url)
      if (u.includes('taskListId=')) return Promise.resolve(jsonResponse({ tasks: [task] }))
      return Promise.resolve(jsonResponse({ taskLists: lists }))
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useTasks())
    await settle()
    await settle() // second hop: byList aggregate query fires after lists land

    expect(result.current.taskLists).toEqual(lists)
    expect(result.current.tasksByList).toEqual({ l1: [task] })
    expect(result.current.isLoading).toBe(false)
    expect(result.current.error).toBeUndefined()
    expect(typeof result.current.mutate).toBe('function')

    unmount()
  })

  it('useDrive with enabled=false never fetches (Artifacts-tab gating)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ files: [] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useDrive('recent', false))
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.files).toEqual([])
    expect(result.current.isLoading).toBe(false)

    unmount()
  })

  it('useFeed maps the feed payload to items', async () => {
    const item = { id: 'f1', source: 's', type: 'info', title: 't', description: 'd', timestamp: 'now' }
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ feed: [item] }),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useFeed())
    await settle()

    expect(result.current.items).toEqual([item])
    expect(result.current.isLoading).toBe(false)

    unmount()
  })

  it('useAuthErrorRecovery routes a 401 error into signIn(google) (reauth contract)', async () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 })

    const { result, unmount } = renderQueryHook(() => useAuthErrorRecovery(err))
    expect(result.current).toBe(true)

    // The redirect fires after the 2s banner delay.
    await act(async () => {
      await new Promise(r => setTimeout(r, 2100))
    })
    expect(signInMock).toHaveBeenCalledWith('google')

    unmount()
  })

  it('useAuthErrorRecovery ignores non-401 errors', () => {
    const err = Object.assign(new Error('boom'), { status: 500 })
    const { result, unmount } = renderQueryHook(() => useAuthErrorRecovery(err))
    expect(result.current).toBe(false)
    expect(signInMock).not.toHaveBeenCalled()
    unmount()
  })
})
