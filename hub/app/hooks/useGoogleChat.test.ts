// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { renderQueryHook, settleQueries as settle, jsonResponse } from './query-test-utils'
import {
  useSpaces,
  useMessages,
  useSendMessage,
  useSpaceMembers,
  useUnreadCounts,
  type ChatSpace,
} from './useGoogleChat'

describe('useGoogleChat hooks (TanStack Query-backed)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    localStorage.clear()
  })

  it('useSpaces maps spaces and keeps the visible/pinned filtering', async () => {
    const s1 = { name: 'spaces/1', displayName: 'Ops', type: 'ROOM' }
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ spaces: [s1] }),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useSpaces())
    await settle()

    // Same return shape: allSpaces / visibleSpaces / isLoading / error /
    // missingScope / refetch.
    expect(result.current.allSpaces).toEqual([s1])
    expect(result.current.visibleSpaces).toEqual([s1])
    expect(result.current.isLoading).toBe(false)
    expect(result.current.missingScope).toBe(false)
    expect(typeof result.current.refetch).toBe('function')

    unmount()
  })

  it('useSpaces surfaces a status-tagged 401 (auth branch preserved)', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'Unauthorized' }, 401),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useSpaces())
    await settle()

    expect((result.current.error as any)?.status).toBe(401)
    expect(result.current.allSpaces).toEqual([])

    unmount()
  })

  it('useSpaces flags MISSING_SCOPE from the error code', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ error: 'scope', code: 'MISSING_SCOPE' }, 403),
    ) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useSpaces())
    await settle()

    expect(result.current.missingScope).toBe(true)

    unmount()
  })

  it('useMessages skips fetching without a spaceId (null-key sentinel preserved)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ messages: [] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useMessages(null))
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.messages).toEqual([])
    expect(result.current.isLoading).toBe(false)

    unmount()
  })

  it('useSendMessage POSTs then revalidates the messages cache for that space', async () => {
    const m1 = { name: 'spaces/1/messages/a', sender: { name: 'u', displayName: 'U' }, createTime: 't', text: 'hi' }
    const m2 = { name: 'spaces/1/messages/b', sender: { name: 'u', displayName: 'U' }, createTime: 't', text: 'sent' }
    let messages = [m1]

    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        messages = [m1, m2]
        return Promise.resolve(jsonResponse({ ok: true }))
      }
      return Promise.resolve(jsonResponse({ messages }))
    })
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => ({
      inbox: useMessages('spaces/1'),
      sender: useSendMessage(),
    }))
    await settle()
    expect(result.current.inbox.messages).toEqual([m1])

    let sent = false
    await act(async () => { sent = await result.current.sender.send('spaces/1', 'sent') })
    await settle()

    expect(sent).toBe(true)
    // The post-send invalidation refetched this space's messages.
    expect(result.current.inbox.messages).toEqual([m1, m2])
    expect(result.current.sender.sendError).toBeNull()

    unmount()
  })

  it('useSpaceMembers skips without a spaceId and maps members with one', async () => {
    const member = { name: 'users/1', displayName: 'Dana', email: 'd@x.com', type: 'HUMAN', role: 'MEMBER' }
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ members: [member] }))
    global.fetch = fetchMock as unknown as typeof fetch

    const skipped = renderQueryHook(() => useSpaceMembers(null))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(skipped.result.current.members).toEqual([])
    skipped.unmount()

    const active = renderQueryHook(() => useSpaceMembers('spaces/1'))
    await settle()
    expect(active.result.current.members).toEqual([member])
    active.unmount()
  })

  it('useUnreadCounts derives the map and total from the single batched endpoint', async () => {
    const spaces: ChatSpace[] = [
      { name: 'spaces/b', displayName: 'B', type: 'ROOM' },
      { name: 'spaces/a', displayName: 'A', type: 'ROOM' },
    ]
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ unread: { 'spaces/a': 2, 'spaces/b': 0 }, total: 2 }),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useUnreadCounts(spaces))
    await settle()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/google/chat/unread?spaceIds=')
    expect(result.current.unreadMap.get('spaces/a')).toBe(2)
    expect(result.current.totalUnread).toBe(2)

    unmount()
  })

  it('useUnreadCounts skips fetching when there are no spaces', async () => {
    const fetchMock = vi.fn()
    global.fetch = fetchMock as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useUnreadCounts([]))
    await settle()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.current.totalUnread).toBe(0)

    unmount()
  })
})
