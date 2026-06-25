import { describe, it, expect } from 'vitest'
import { buildUnreadKey } from '@/app/hooks/useGoogleChat'
import type { ChatSpace } from '@/app/hooks/useGoogleChat'

/**
 * Plan 05 / Change 5 — `useUnreadCounts` must derive from a SINGLE batched SWR
 * key against `/api/google/chat/unread`, replacing the old per-space
 * setInterval fan-out. These tests pin the key-derivation contract: one stable,
 * order-independent key for a given space set, and the SWR "skip" sentinel when
 * empty.
 */

function space(name: string): ChatSpace {
  return { name, displayName: name, type: 'ROOM' }
}

describe('buildUnreadKey (Plan 05 Change 5)', () => {
  it('returns null (SWR skip) when there are no spaces', () => {
    expect(buildUnreadKey([])).toBeNull()
  })

  it('builds a single /api/google/chat/unread key for all spaces', () => {
    const key = buildUnreadKey([space('spaces/A'), space('spaces/B')])
    expect(key).toBe(
      `/api/google/chat/unread?spaceIds=${encodeURIComponent('spaces/A,spaces/B')}`
    )
    // One endpoint, one request — no per-space /messages or /readstate fan-out.
    expect(key).not.toContain('/messages')
    expect(key).not.toContain('/readstate')
  })

  it('is order-independent (sorted) so reordering spaces does not refetch', () => {
    const a = buildUnreadKey([space('spaces/B'), space('spaces/A')])
    const b = buildUnreadKey([space('spaces/A'), space('spaces/B')])
    expect(a).toBe(b)
  })
})
