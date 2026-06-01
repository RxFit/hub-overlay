'use client'

import useSWR, { useSWRConfig } from 'swr'
import { useState, useCallback, useEffect } from 'react'

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

interface ReadStateResponse {
  spaceId: string
  lastReadTime: string | null
  code?: string
}

/**
 * Computes unread counts by comparing SpaceReadState.lastReadTime
 * against the latest messages for each visible space.
 * Polls every 60s (slower than messages to stay under rate limits).
 */
export function useUnreadCounts(spaces: ChatSpace[]) {
  // Fetch read states for all visible spaces in a single SWR key
  // We batch by serializing space IDs into the key
  const spaceIds = spaces.map(s => s.name).sort().join(',')
  const key = spaceIds ? `/api/google/chat/readstate/batch?ids=${encodeURIComponent(spaceIds)}` : null

  // Since we don't have a batch endpoint, we fetch individual read states
  // and aggregate client-side using individual SWR hooks per space.
  // For simplicity, we'll use a single effect-based approach.

  const [unreadMap, setUnreadMap] = useState<Map<string, number>>(new Map())
  const [totalUnread, setTotalUnread] = useState(0)

  // Poll for unread counts
  useEffect(() => {
    if (spaces.length === 0) return

    let cancelled = false

    async function computeUnreads() {
      const map = new Map<string, number>()
      let total = 0

      await Promise.all(
        spaces.map(async (space) => {
          try {
            // Fetch read state
            const rsRes = await fetch(
              `/api/google/chat/readstate?spaceId=${encodeURIComponent(space.name)}`
            )
            if (!rsRes.ok) return
            const rs: ReadStateResponse = await rsRes.json()

            if (!rs.lastReadTime) return // Scope not granted yet

            // Fetch latest messages
            const msgRes = await fetch(
              `/api/google/chat/messages?spaceId=${encodeURIComponent(space.name)}&pageSize=50`
            )
            if (!msgRes.ok) return
            const msgData: { messages: ChatMessage[] } = await msgRes.json()

            // Count messages newer than lastReadTime
            const lastRead = new Date(rs.lastReadTime).getTime()
            const unread = (msgData.messages ?? []).filter(
              m => new Date(m.createTime).getTime() > lastRead
            ).length

            map.set(space.name, unread)
            total += unread
          } catch {
            // Individual space failure — skip silently
          }
        })
      )

      if (!cancelled) {
        setUnreadMap(map)
        setTotalUnread(total)
      }
    }

    computeUnreads()
    const interval = setInterval(computeUnreads, 60_000) // 60s poll

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [spaceIds]) // Re-run when visible spaces change

  return { unreadMap, totalUnread }
}
