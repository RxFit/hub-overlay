// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderQueryHook, settleQueries } from './query-test-utils'
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
})
