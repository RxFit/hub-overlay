'use client'

import useSWR, { useSWRConfig } from 'swr'
import { useState, useCallback } from 'react'

/* ── Shared fetcher (reuses the same error contract as useHubData) ── */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (res.status === 401) {
    const err = new Error('Unauthorized')
    ;(err as any).status = 401
    throw err
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: 'Unknown error' }))
    const err = new Error(body?.error ?? `API error ${res.status}`)
    ;(err as any).status = res.status
    ;(err as any).code = body?.code
    throw err
  }
  return res.json()
}

/* ══════════════════════════════════════════
   Types
   ══════════════════════════════════════════ */

export interface ChatSpace {
  name: string          // "spaces/XXXXXXXX"
  displayName: string
  type: string
  spaceType?: string
  singleUserBotDm?: boolean
  spaceDetails?: { description?: string }
}

export interface ChatMessage {
  name: string          // "spaces/xxx/messages/yyy"
  sender: {
    name: string
    displayName: string
    type?: string
  }
  createTime: string
  text: string
  formattedText?: string
  thread?: { name: string }
}

/* ══════════════════════════════════════════
   Pinned spaces — localStorage
   ══════════════════════════════════════════ */

const STORAGE_KEY = 'hub-chat-pinned-spaces'

export function getPinnedSpaces(): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function setPinnedSpaces(spaceNames: string[]): void {
  if (typeof window === 'undefined') return
  localStorage.setItem(STORAGE_KEY, JSON.stringify(spaceNames))
}

/* ══════════════════════════════════════════
   useSpaces — all spaces + pinned filter
   ══════════════════════════════════════════ */

interface SpacesResponse {
  spaces: ChatSpace[]
  error?: string
  code?: string
}

export function useSpaces() {
  const { data, error, isLoading, mutate } = useSWR<SpacesResponse>(
    '/api/google/chat/spaces',
    fetcher,
    { refreshInterval: 120_000, revalidateOnFocus: false }
  )

  const allSpaces = data?.spaces ?? []
  const pinnedNames = getPinnedSpaces()

  // If user has never configured pinned spaces → show all
  const visibleSpaces = pinnedNames === null
    ? allSpaces
    : allSpaces.filter(s => pinnedNames.includes(s.name))

  return {
    allSpaces,
    visibleSpaces,
    isLoading,
    error,
    missingScope: (error as any)?.code === 'MISSING_SCOPE',
    refetch: mutate,
  }
}

/* ══════════════════════════════════════════
   useMessages — messages for a space
   ══════════════════════════════════════════ */

interface MessagesResponse {
  messages: ChatMessage[]
}

export function useMessages(spaceId: string | null) {
  const key = spaceId
    ? `/api/google/chat/messages?spaceId=${encodeURIComponent(spaceId)}&pageSize=50`
    : null

  const { data, error, isLoading, mutate } = useSWR<MessagesResponse>(
    key,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: true }
  )

  return {
    messages: data?.messages ?? [],
    isLoading,
    error,
    refetch: mutate,
  }
}

/* ══════════════════════════════════════════
   useSendMessage — POST to a space
   ══════════════════════════════════════════ */

export function useSendMessage() {
  const { mutate } = useSWRConfig()
  const [isSending, setIsSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)

  const send = useCallback(async (
    spaceId: string,
    text: string,
    threadKey?: string
  ): Promise<boolean> => {
    if (!text.trim() || !spaceId) return false
    setIsSending(true)
    setSendError(null)

    try {
      const res = await fetch('/api/google/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId, text: text.trim(), threadKey }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Send failed (${res.status})`)
      }

      // Revalidate the messages SWR cache for this space
      const key = `/api/google/chat/messages?spaceId=${encodeURIComponent(spaceId)}&pageSize=50`
      await mutate(key)
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send'
      setSendError(msg)
      return false
    } finally {
      setIsSending(false)
    }
  }, [mutate])

  return { send, isSending, sendError, clearError: () => setSendError(null) }
}

/* ══════════════════════════════════════════
   useSpaceMembers — for @mention picker
   ══════════════════════════════════════════ */

export interface SpaceMember {
  name: string          // "users/123456"
  displayName: string
  email: string | null
  type: string
  role: string
}

interface MembersResponse {
  members: SpaceMember[]
}

export function useSpaceMembers(spaceId: string | null) {
  const key = spaceId
    ? `/api/google/chat/members?spaceId=${encodeURIComponent(spaceId)}`
    : null

  const { data, error, isLoading } = useSWR<MembersResponse>(
    key,
    fetcher,
    { refreshInterval: 300_000, revalidateOnFocus: false } // 5-min cache
  )

  return {
    members: data?.members ?? [],
    isLoading,
    error,
  }
}

/* ══════════════════════════════════════════
   useUnreadCounts — for badge computation
   ══════════════════════════════════════════ */

interface UnreadResponse {
  unread: Record<string, number>
  total: number
}

/**
 * Builds the single SWR key for the batched unread endpoint from a space set.
 * Exported for unit testing — asserts the hook derives all of its data from one
 * stable, deduped key (Plan 05 / Change 5) instead of a per-space fan-out.
 * Returns `null` (SWR's "skip" sentinel) when there are no spaces.
 */
export function buildUnreadKey(spaces: ChatSpace[]): string | null {
  const spaceIds = spaces.map(s => s.name).sort()
  return spaceIds.length
    ? `/api/google/chat/unread?spaceIds=${encodeURIComponent(spaceIds.join(','))}`
    : null
}

/**
 * Computes unread counts via a single batched SWR subscription against
 * `/api/google/chat/unread`. The server compares each space's lastReadTime
 * against its latest messages. Polls every 60s (slower than messages, deduped
 * within 30s) and reuses SWR's cache — no raw setInterval, no duplicate
 * message fetches, and no stale-closure footgun on the spaces array.
 */
export function useUnreadCounts(spaces: ChatSpace[]) {
  const key = buildUnreadKey(spaces)

  const { data } = useSWR<UnreadResponse>(
    key,
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false, dedupingInterval: 30_000 }
  )

  const unreadMap = new Map<string, number>(Object.entries(data?.unread ?? {}))
  const totalUnread = data?.total ?? 0

  return { unreadMap, totalUnread }
}
