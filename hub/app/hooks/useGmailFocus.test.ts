// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderQueryHook, settleQueries, settleUntil } from './query-test-utils'
import {
  __resetPartialResponseNoticeForTests,
  getPartialResponseNotice,
} from '@/lib/partial-response-client'
import { useGmailFocus } from './useGmailFocus'

describe('useGmailFocus', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    vi.restoreAllMocks()
    global.fetch = originalFetch
    __resetPartialResponseNoticeForTests()
  })

  it('surfaces the partial-response header from the focus route', async () => {
    global.fetch = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ items: [], degraded: false }),
      {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'x-hub-partial': '1',
        },
      },
    )) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useGmailFocus())
    await settleQueries()

    expect(result.current.focusItems).toEqual([])
    expect(result.current.focusDegraded).toBe(false)
    expect(getPartialResponseNotice()).toBe(true)

    unmount()
  })

  it('a 2xx whose body does not parse arms the notice and reads degraded', async () => {
    // No x-hub-partial header: the server believed it answered in full. The
    // client-side emptyOn fallback cannot reach the notice store (its marker is
    // server-injected), so the hook must arm it explicitly.
    global.fetch = vi.fn().mockResolvedValue(new Response(
      '{"items": [{"id": "t1"',
      { status: 200, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch

    const { result, unmount } = renderQueryHook(() => useGmailFocus())
    // Two observable conditions, waited on in the order they happen. The
    // notice is armed synchronously inside the queryFn, before it returns —
    // so if this first wait times out the queryFn never reached the
    // parse-failure branch. The hook's render lands later and outside act
    // (react-query notifies on its own timer), so it gets a wide budget.
    await settleUntil(() => getPartialResponseNotice())
    expect(getPartialResponseNotice()).toBe(true)
    await settleUntil(() => result.current.focusDegraded === true, 100)

    expect(result.current.focusItems).toEqual([])
    expect(result.current.focusDegraded).toBe(true)

    unmount()
  })
})
