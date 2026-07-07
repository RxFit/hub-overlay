// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useGmailInbox, parseInboxResponse } from './useGmailInbox'

// React 18 concurrent rendering requires an act environment flag.
;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/**
 * Minimal renderHook — @testing-library/react is not a dependency, so we drive
 * the hook through a throwaway component with react-dom/client + act. The hook
 * is now TanStack Query-backed (NS-6), so the probe is wrapped in a fresh
 * QueryClientProvider (retries off, no gc) per render.
 */
function renderHook<T>(useHook: () => T) {
  const result: { current: T } = { current: undefined as unknown as T }
  const container = document.createElement('div')
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  })
  let root: Root

  function Probe() {
    result.current = useHook()
    return null
  }

  act(() => {
    root = createRoot(container)
    root.render(createElement(QueryClientProvider, { client }, createElement(Probe)))
  })

  return {
    result,
    unmount: () => act(() => { root.unmount() }),
  }
}

// Let react-query's async queryFn + the derive-from-data effect settle.
const settle = () => act(async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve()
  await new Promise(r => setTimeout(r, 0))
})

function jsonResponse(body: unknown) {
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

describe('useGmailInbox (TanStack Query-backed)', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
  })

  it('a background refetch updates threads + unread WITHOUT resetting the compose draft (#28)', async () => {
    const t1 = { id: 't1', subject: 's1', from: 'a@x.com', date: 'd', snippet: '1', isUnread: true, messageCount: 1 }
    const t2 = { id: 't2', subject: 's2', from: 'b@x.com', date: 'd', snippet: '2', isUnread: false, messageCount: 1 }

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ threads: [t1], unreadCount: 3 }))
    global.fetch = fetchMock as unknown as typeof fetch

    const onUnreadCount = vi.fn()
    const { result, unmount } = renderHook(() => useGmailInbox({ onUnreadCount }))
    await settle()

    // Mount query landed the initial list + unread count.
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

    // A background refetch (the query's manual refresh path) returns a longer
    // list + new unread count.
    fetchMock.mockResolvedValue(jsonResponse({ threads: [t1, t2], unreadCount: 5 }))
    await act(async () => { await result.current.refreshInbox() })
    await settle()

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

  it('a background refetch does NOT disturb an open thread (#28)', async () => {
    const t1 = { id: 't1', subject: 's1', from: 'a@x.com', date: 'd', snippet: '1', isUnread: true, messageCount: 1 }
    const t2 = { id: 't2', subject: 's2', from: 'b@x.com', date: 'd', snippet: '2', isUnread: false, messageCount: 1 }
    const openThreadPayload = {
      thread: {
        id: 't1',
        messages: [
          { id: 'm1', from: 'a@x.com', to: 'me@x.com', subject: 's1', date: 'd', body: 'hi', isUnread: true, inReplyTo: '' },
        ],
      },
    }

    // Route by URL: threadId → the opened thread; otherwise → the inbox list.
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        String(url).includes('threadId=')
          ? jsonResponse(openThreadPayload)
          : jsonResponse({ threads: [t1], unreadCount: 3 }),
      ),
    )
    global.fetch = fetchMock as unknown as typeof fetch

    const onUnreadCount = vi.fn()
    const { result, unmount } = renderHook(() => useGmailInbox({ onUnreadCount }))
    await settle()

    // Open a thread — this is LOCAL state, never in the query cache.
    await act(async () => { await result.current.openThread('t1') })
    await settle()
    expect(result.current.selectedThread?.id).toBe('t1')
    expect(result.current.selectedThread?.messages).toHaveLength(1)

    // A background refetch returns a longer inbox list.
    fetchMock.mockImplementation((url: string) =>
      Promise.resolve(
        String(url).includes('threadId=')
          ? jsonResponse(openThreadPayload)
          : jsonResponse({ threads: [t1, t2], unreadCount: 5 }),
      ),
    )
    await act(async () => { await result.current.refreshInbox() })
    await settle()

    // List refreshed…
    expect(result.current.threads).toEqual([t1, t2])
    // …the open thread is still open and intact (the #28 guarantee).
    expect(result.current.selectedThread?.id).toBe('t1')
    expect(result.current.selectedThread?.messages).toHaveLength(1)

    unmount()
  })
})
