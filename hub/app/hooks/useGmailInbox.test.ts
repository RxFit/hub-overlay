// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useGmailInbox, parseInboxResponse } from './useGmailInbox'

// React 18 concurrent rendering requires an act environment flag.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Minimal renderHook — @testing-library/react is not a dependency, so we drive
 * the hook through a throwaway component with react-dom/client + act. Enough to
 * assert the refresh path and the poll/visibility effect cleanup without pulling
 * in a new test dep.
 */
function renderHook<T>(useHook: () => T) {
  const result: { current: T } = { current: undefined as unknown as T }
  const container = document.createElement('div')
  let root: Root

  function Probe() {
    result.current = useHook()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(Probe))
  })

  return {
    result,
    unmount: () => act(() => { root.unmount() }),
  }
}

const flush = () => act(async () => { await Promise.resolve() })

function inboxResponse(body: unknown) {
  return { ok: true, json: async () => body } as unknown as Response
}

describe('parseInboxResponse (unread mapping)', () => {
  it('maps threads and unread count from the inbox payload', () => {
    const threads = [
      { id: 'a', subject: 's', from: 'f', date: 'd', snippet: 'x', isUnread: true, messageCount: 1 },
    ]
    expect(parseInboxResponse({ threads, unreadCount: 4 })).toEqual({ threads, unreadCount: 4 })
  })

  it('defaults to empty list and zero unread when fields are missing or null', () => {
    expect(parseInboxResponse({})).toEqual({ threads: [], unreadCount: 0 })
    expect(parseInboxResponse(null)).toEqual({ threads: [], unreadCount: 0 })
    expect(parseInboxResponse(undefined)).toEqual({ threads: [], unreadCount: 0 })
    expect(parseInboxResponse({ threads: null, unreadCount: null })).toEqual({ threads: [], unreadCount: 0 })
  })
})

describe('useGmailInbox', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
    global.fetch = originalFetch
  })

  it('refreshInbox updates threads + unread WITHOUT resetting selectedThread/isComposing/compose (#28)', async () => {
    const t1 = { id: 't1', subject: 's1', from: 'a@x.com', date: 'd', snippet: '1', isUnread: true, messageCount: 1 }
    const t2 = { id: 't2', subject: 's2', from: 'b@x.com', date: 'd', snippet: '2', isUnread: false, messageCount: 1 }

    const fetchMock = vi.fn().mockResolvedValue(inboxResponse({ threads: [t1], unreadCount: 3 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const onUnreadCount = vi.fn()
    const { result, unmount } = renderHook(() => useGmailInbox({ onUnreadCount }))
    await flush()

    // Mount refresh landed the initial list + unread count.
    expect(result.current.threads).toEqual([t1])
    expect(onUnreadCount).toHaveBeenLastCalledWith(3)
    expect(result.current.loading).toBe(false)

    // Put the view into a "composing" state with in-progress draft fields.
    act(() => { result.current.handleComposeNew() })
    act(() => {
      result.current.setComposeTo('friend@x.com')
      result.current.setComposeSubject('Hello')
      result.current.setReply('draft body')
    })
    expect(result.current.isComposing).toBe(true)

    // A background refresh returns a longer list + new unread count.
    fetchMock.mockResolvedValue(inboxResponse({ threads: [t1, t2], unreadCount: 5 }))
    await act(async () => { await result.current.refreshInbox() })

    // List + unread updated…
    expect(result.current.threads).toEqual([t1, t2])
    expect(onUnreadCount).toHaveBeenLastCalledWith(5)
    // …but the open compose draft is untouched (the #28 guarantee).
    expect(result.current.isComposing).toBe(true)
    expect(result.current.composeTo).toBe('friend@x.com')
    expect(result.current.composeSubject).toBe('Hello')
    expect(result.current.reply).toBe('draft body')

    unmount()
  })

  it('polls every 60s while visible and cleans up interval + visibility listener on unmount', async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn().mockResolvedValue(inboxResponse({ threads: [], unreadCount: 0 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const removeSpy = vi.spyOn(document, 'removeEventListener')
    const onUnreadCount = vi.fn()

    const { unmount } = renderHook(() => useGmailInbox({ onUnreadCount }))
    // Mount refresh.
    await act(async () => { await Promise.resolve() })
    const afterMount = fetchMock.mock.calls.length
    expect(afterMount).toBeGreaterThanOrEqual(1)

    // One poll tick fires exactly one refresh while the tab is visible.
    await act(async () => { vi.advanceTimersByTime(60_000) })
    expect(fetchMock.mock.calls.length).toBe(afterMount + 1)

    // Unmount tears down the interval and the visibilitychange listener…
    unmount()
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function))

    // …so further timer advances trigger no more fetches (no leak).
    const afterUnmount = fetchMock.mock.calls.length
    await act(async () => { vi.advanceTimersByTime(180_000) })
    expect(fetchMock.mock.calls.length).toBe(afterUnmount)
  })
})
