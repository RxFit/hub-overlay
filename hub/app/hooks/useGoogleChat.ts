'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback, useRef } from 'react'

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
  const { data, error, isLoading, refetch } = useQuery<SpacesResponse>({
    queryKey: ['chat', 'spaces'],
    queryFn: () => fetcher<SpacesResponse>('/api/google/chat/spaces'),
    refetchInterval: 120_000,
    refetchOnWindowFocus: false,
  })

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
    error: error ?? undefined,
    missingScope: (error as any)?.code === 'MISSING_SCOPE',
    refetch,
  }
}

/* ══════════════════════════════════════════
   useMessages — messages for a space
   ══════════════════════════════════════════ */

interface MessagesResponse {
  messages: ChatMessage[]
}

/** Cache key for a space's message list — shared with useSendMessage's post-send invalidation. */
export function messagesQueryKey(spaceId: string) {
  return ['chat', 'messages', spaceId] as const
}

export function useMessages(spaceId: string | null) {
  const { data, error, isLoading, refetch } = useQuery<MessagesResponse>({
    queryKey: messagesQueryKey(spaceId ?? ''),
    queryFn: () =>
      fetcher<MessagesResponse>(
        `/api/google/chat/messages?spaceId=${encodeURIComponent(spaceId!)}&pageSize=50`
      ),
    enabled: !!spaceId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Messages are the most latency-sensitive chat read — keep a short focus
    // dedupe window (mirrors the previous focus-throttle) instead of the
    // provider-wide 30s staleTime.
    staleTime: 5_000,
  })

  return {
    messages: data?.messages ?? [],
    isLoading,
    error: error ?? undefined,
    refetch,
  }
}

/* ══════════════════════════════════════════
   useSendMessage — POST to a space
   ══════════════════════════════════════════ */

export function useSendMessage() {
  const queryClient = useQueryClient()
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

      // Revalidate the cached messages for this space
      await queryClient.invalidateQueries({ queryKey: messagesQueryKey(spaceId) })
      return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send'
      setSendError(msg)
      return false
    } finally {
      setIsSending(false)
    }
  }, [queryClient])

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
  const { data, error, isLoading } = useQuery<MembersResponse>({
    queryKey: ['chat', 'members', spaceId ?? ''],
    queryFn: () =>
      fetcher<MembersResponse>(
        `/api/google/chat/members?spaceId=${encodeURIComponent(spaceId!)}`
      ),
    enabled: !!spaceId,
    refetchInterval: 300_000, // 5-min cache
    refetchOnWindowFocus: false,
  })

  return {
    members: data?.members ?? [],
    isLoading,
    error: error ?? undefined,
  }
}

/* ══════════════════════════════════════════
   useMarkSpaceRead — clear a space's unread badge on open
   ══════════════════════════════════════════ */

/**
 * Marks a space read (server-side, via the Chat readstate API) and
 * optimistically zeroes its count in every cached unread entry so the badge
 * clears immediately instead of on the next 60s poll. Fire-and-forget: a
 * failed write (e.g. pre-upgrade token without the write scope) just leaves
 * the badge to the next poll's truth.
 */
export function useMarkSpaceRead() {
  const queryClient = useQueryClient()
  // One mark per (space, open) — the caller's effect can re-run on poll
  // refetches; only re-mark when new messages actually arrived.
  const lastMarkedRef = useRef<string>('')

  const markRead = useCallback(async (spaceId: string, latestMessageName?: string) => {
    const markKey = `${spaceId}|${latestMessageName ?? ''}`
    if (lastMarkedRef.current === markKey) return
    lastMarkedRef.current = markKey

    queryClient.setQueriesData<UnreadResponse>(
      { queryKey: ['chat', 'unread'] },
      old => {
        if (!old || !(spaceId in old.unread)) return old
        const cleared = old.unread[spaceId] ?? 0
        return {
          unread: { ...old.unread, [spaceId]: 0 },
          total: Math.max(0, old.total - cleared),
        }
      }
    )
    try {
      await fetch('/api/google/chat/readstate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spaceId }),
      })
    } catch {
      // Non-fatal — the 60s unread poll remains the source of truth.
    }
  }, [queryClient])

  return { markRead }
}

/* ══════════════════════════════════════════
   useUnreadCounts — for badge computation
   ══════════════════════════════════════════ */

interface UnreadResponse {
  unread: Record<string, number>
  total: number
}

/**
 * Builds the single URL (and cache-key discriminator) for the batched unread
 * endpoint from a space set. Exported for unit testing — asserts the hook
 * derives all of its data from one stable, deduped key (Plan 05 / Change 5)
 * instead of a per-space fan-out. Returns `null` (the "skip" sentinel that
 * disables the query) when there are no spaces.
 */
export function buildUnreadKey(spaces: ChatSpace[]): string | null {
  const spaceIds = spaces.map(s => s.name).sort()
  return spaceIds.length
    ? `/api/google/chat/unread?spaceIds=${encodeURIComponent(spaceIds.join(','))}`
    : null
}

/**
 * Computes unread counts via a single batched query subscription against
 * `/api/google/chat/unread`. The server compares each space's lastReadTime
 * against its latest messages. Polls every 60s (slower than messages, deduped
 * within 30s) and reuses the query cache — no raw setInterval, no duplicate
 * message fetches, and no stale-closure footgun on the spaces array.
 */
export function useUnreadCounts(spaces: ChatSpace[]) {
  const key = buildUnreadKey(spaces)

  const { data } = useQuery<UnreadResponse>({
    queryKey: ['chat', 'unread', key ?? ''],
    queryFn: () => fetcher<UnreadResponse>(key!),
    enabled: !!key,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  const unreadMap = new Map<string, number>(Object.entries(data?.unread ?? {}))
  const totalUnread = data?.total ?? 0

  return { unreadMap, totalUnread }
}
