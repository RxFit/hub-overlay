'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { refreshSessionCookie } from '@/app/hooks/useHubData'
import {
  EMPTY_CHAT_SPACE_PREFERENCES,
  LEGACY_PINNED_SPACES_KEY,
  migrateLegacyPinnedSpaces,
  normalizeChatSpacePreferences,
  resolveVisibleSpaces,
  type ChatSpaceKind,
  type ChatSpacePreferences,
} from '@/lib/chat-spaces'
import type { AttachmentLike } from '@/lib/chat-attachments'

/* ── Shared fetcher (reuses the same error contract as useHubData) ── */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)
  if (res.status === 401) {
    const body = await res.json().catch(() => ({} as Record<string, unknown>))
    // A merely-stale access token is repairable: rotate the session cookie so
    // the query's retry succeeds, rather than surfacing an auth error that
    // ends in a forced sign-in. See refreshSessionCookie.
    if (body?.refresh === true) await refreshSessionCookie()
    const err = new Error(typeof body?.error === 'string' ? body.error : 'Unauthorized')
    ;(err as any).status = 401
    ;(err as any).reauth = body?.reauth
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
  /** THREADED_MESSAGES | GROUPED_MESSAGES | UNTHREADED_MESSAGES — gates the reply-in-thread UI. */
  spaceThreadingState?: string
  /** Server-annotated classification (see lib/chat-spaces.ts). */
  kind?: ChatSpaceKind
  /** Whether the default rule shows this space with no override. */
  defaultVisible?: boolean
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
  /** Output-only Chat API flag: true when the message is a reply inside a thread. */
  threadReply?: boolean
  /** Files dropped into the message (see lib/chat-attachments.ts). */
  attachment?: AttachmentLike[]
  /** Present on card-only app messages (no text body to render). */
  cardsV2?: unknown[]
}

/** Thread target for a send — reply into an existing thread by resource name. */
export interface ChatThreadTarget {
  threadName?: string   // "spaces/xxx/threads/yyy"
  threadKey?: string
}

/* ══════════════════════════════════════════
   Legacy pinned spaces — localStorage (read-only, migration source)
   ══════════════════════════════════════════ */

/**
 * Read the pre-server pinned-space list.
 *
 * Kept ONLY as a migration source. Space visibility now lives in Postgres
 * (`/api/google/chat/spaces/preferences`) because a browser-local list is lost
 * on every sign-out, new browser, new device and cleared profile — which is
 * exactly why these settings appeared to "reset on every login".
 */
export function getLegacyPinnedSpaces(): string[] | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEGACY_PINNED_SPACES_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((n): n is string => typeof n === 'string') : null
  } catch {
    return null
  }
}

function clearLegacyPinnedSpaces(): void {
  if (typeof window === 'undefined') return
  try { localStorage.removeItem(LEGACY_PINNED_SPACES_KEY) } catch {}
}

/* ══════════════════════════════════════════
   useSpaces — all spaces + server-side visibility preferences
   ══════════════════════════════════════════ */

export const spacesQueryKey = ['chat', 'spaces'] as const

interface SpacesResponse {
  spaces: ChatSpace[]
  preferences?: ChatSpacePreferences
  error?: string
  code?: string
}

/**
 * All spaces, the user's saved overrides, and the resolved visible set.
 *
 * `visibleSpaces` is now derived from the default rule in lib/chat-spaces.ts
 * (named spaces on; DMs, Meet/ad-hoc group chats and bot DMs off) with the
 * user's explicit per-space overrides applied on top — NOT from a stored
 * snapshot of names. That is what keeps a Meet chat created five minutes ago
 * out of the panel without the user touching Settings again.
 */
export function useSpaces() {
  const { data, error, isLoading, refetch } = useQuery<SpacesResponse>({
    queryKey: spacesQueryKey,
    queryFn: () => fetcher<SpacesResponse>('/api/google/chat/spaces'),
    refetchInterval: 120_000,
    refetchOnWindowFocus: false,
  })

  // Memoized on the query result (which react-query keeps referentially stable)
  // so `preferences` / `visibleSpaces` don't get a new identity every render
  // and churn the effects and memos downstream of them.
  const { allSpaces, preferences, visibleSpaces } = useMemo(() => {
    const spaces = data?.spaces ?? []
    const prefs = normalizeChatSpacePreferences(data?.preferences ?? EMPTY_CHAT_SPACE_PREFERENCES)
    return { allSpaces: spaces, preferences: prefs, visibleSpaces: resolveVisibleSpaces(spaces, prefs) }
  }, [data])

  return {
    allSpaces,
    visibleSpaces,
    preferences,
    isLoading,
    error: error ?? undefined,
    missingScope: (error as any)?.code === 'MISSING_SCOPE',
    refetch,
  }
}

/* ══════════════════════════════════════════
   useSaveChatSpacePreferences — persist visibility choices
   ══════════════════════════════════════════ */

/**
 * Persist the user's space visibility overrides and reflect the server-
 * normalized result into the spaces cache, so the panel and the Settings list
 * update together without a refetch.
 */
export function useSaveChatSpacePreferences() {
  const queryClient = useQueryClient()
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const save = useCallback(async (prefs: ChatSpacePreferences): Promise<boolean> => {
    setIsSaving(true)
    setSaveError(null)
    try {
      const res = await fetch('/api/google/chat/spaces/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(prefs),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Save failed (${res.status})`)
      }
      const saved: ChatSpacePreferences = await res.json()
      queryClient.setQueryData<SpacesResponse>(spacesQueryKey, old =>
        old ? { ...old, preferences: saved } : old
      )
      return true
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save')
      return false
    } finally {
      setIsSaving(false)
    }
  }, [queryClient])

  return { save, isSaving, saveError, clearError: () => setSaveError(null) }
}

/* ══════════════════════════════════════════
   useLegacyPinnedSpaceMigration — one-time localStorage → DB lift
   ══════════════════════════════════════════ */

/** Once per page load; the migration is idempotent but need only run once. */
let legacyMigrationAttempted = false

/** Test-only: reset the once-per-load latch. */
export function __resetLegacyMigration(): void {
  legacyMigrationAttempted = false
}

/**
 * Lift a surviving browser-local pinned list into the server-side preferences,
 * exactly once, then delete it.
 *
 * Runs only when the user has NO server-side overrides yet, so it can never
 * clobber a real saved choice. A legacy list that covered every space is
 * discarded rather than imported (see migrateLegacyPinnedSpaces) — that was the
 * old "Show all" default, and importing it would re-admit precisely the Meet/DM
 * clutter this change removes.
 */
export function useLegacyPinnedSpaceMigration(
  allSpaces: ChatSpace[],
  preferences: ChatSpacePreferences,
  isLoading: boolean,
): void {
  const { save } = useSaveChatSpacePreferences()
  const hasOverrides = preferences.shown.length > 0 || preferences.hidden.length > 0

  useEffect(() => {
    if (legacyMigrationAttempted || isLoading || allSpaces.length === 0 || hasOverrides) return
    const legacy = getLegacyPinnedSpaces()
    if (legacy === null) return

    legacyMigrationAttempted = true
    const migrated = migrateLegacyPinnedSpaces(legacy, allSpaces)
    if (!migrated) {
      clearLegacyPinnedSpaces()
      return
    }
    // Only drop the local copy once the server has actually accepted it.
    void save(migrated).then(ok => { if (ok) clearLegacyPinnedSpaces() })
  }, [allSpaces, hasOverrides, isLoading, save])
}

/* ══════════════════════════════════════════
   useMessages — messages for a space
   ══════════════════════════════════════════ */

interface MessagesResponse {
  messages: ChatMessage[]
  /** Continuation into OLDER history (the wire lists newest-first). */
  nextPageToken?: string
}

/**
 * Cache key for a space's message list — shared with useSendMessage's
 * post-send invalidation. Thread reads extend the space key, so invalidating
 * the space PREFIX refreshes the main view and every open thread together.
 */
export function messagesQueryKey(spaceId: string, threadName?: string) {
  return threadName
    ? (['chat', 'messages', spaceId, threadName] as const)
    : (['chat', 'messages', spaceId] as const)
}

/**
 * Messages for a space — or, given `threadName`, ONE thread's complete
 * history (the server filters by thread.name, so replies older than the
 * space view's 50-message window still appear in the thread panel).
 *
 * Scrollback: the polled query always holds the NEWEST window; `loadOlder`
 * walks the server's continuation token backward and the hook merges the
 * accumulated older pages in front of the live window. Older pages sit
 * outside the react-query cache on purpose — an infinite query would refetch
 * every loaded page on each 30s poll, which is exactly the cost this panel
 * keeps avoiding.
 */
export function useMessages(spaceId: string | null, threadName?: string) {
  const { data, error, isLoading, refetch } = useQuery<MessagesResponse>({
    queryKey: messagesQueryKey(spaceId ?? '', threadName),
    queryFn: () =>
      fetcher<MessagesResponse>(
        `/api/google/chat/messages?spaceId=${encodeURIComponent(spaceId!)}` +
        (threadName ? `&pageSize=100&threadName=${encodeURIComponent(threadName)}` : '&pageSize=50')
      ),
    enabled: !!spaceId,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    // Messages are the most latency-sensitive chat read — keep a short focus
    // dedupe window (mirrors the previous focus-throttle) instead of the
    // provider-wide 30s staleTime.
    staleTime: 5_000,
  })

  const [older, setOlder] = useState<ChatMessage[]>([])
  const [isLoadingOlder, setIsLoadingOlder] = useState(false)
  const [olderExhausted, setOlderExhausted] = useState(false)
  // undefined = no older page loaded yet (continue from the live window's
  // token); a string = continue the anchored chain; null = history exhausted.
  const olderTokenRef = useRef<string | null | undefined>(undefined)
  // Freshest live-window token, for the FIRST older load only.
  const mainTokenRef = useRef<string | undefined>(undefined)
  useEffect(() => { mainTokenRef.current = data?.nextPageToken }, [data])

  // Space/thread switch resets the scrollback chain — it belongs to the old scope.
  const scopeKey = `${spaceId ?? ''}|${threadName ?? ''}`
  useEffect(() => {
    setOlder([])
    setIsLoadingOlder(false)
    setOlderExhausted(false)
    olderTokenRef.current = undefined
  }, [scopeKey])

  const loadOlder = useCallback(async (): Promise<void> => {
    if (!spaceId || isLoadingOlder) return
    const token = olderTokenRef.current === undefined ? mainTokenRef.current : olderTokenRef.current
    if (!token) return
    setIsLoadingOlder(true)
    try {
      const page = await fetcher<MessagesResponse>(
        `/api/google/chat/messages?spaceId=${encodeURIComponent(spaceId)}&pageSize=50` +
        `&pageToken=${encodeURIComponent(token)}` +
        (threadName ? `&threadName=${encodeURIComponent(threadName)}` : '')
      )
      setOlder(prev => [...(page.messages ?? []), ...prev])
      olderTokenRef.current = page.nextPageToken ?? null
      if (!page.nextPageToken) setOlderExhausted(true)
    } catch {
      // Leave the chain untouched — the button simply allows a retry.
    } finally {
      setIsLoadingOlder(false)
    }
  }, [spaceId, threadName, isLoadingOlder])

  // Older pages are strictly older than the live window at capture time; the
  // name-dedupe is cheap insurance against boundary drift. Known tradeoff: if
  // 50+ messages arrive AFTER older pages were loaded, the span that slid out
  // of the live window is not re-stitched — reopening the space resets cleanly.
  const messages = useMemo(() => {
    const main = data?.messages ?? []
    if (older.length === 0) return main
    const inMain = new Set(main.map(m => m.name))
    return [...older.filter(m => !inMain.has(m.name)), ...main]
  }, [data, older])

  return {
    messages,
    isLoading,
    error: error ?? undefined,
    refetch,
    loadOlder,
    isLoadingOlder,
    /** True while there is (or may be) more history behind the merged view. */
    hasOlder: !olderExhausted && (older.length > 0 || !!data?.nextPageToken),
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
    thread?: ChatThreadTarget
  ): Promise<boolean> => {
    if (!text.trim() || !spaceId) return false
    setIsSending(true)
    setSendError(null)

    try {
      const res = await fetch('/api/google/chat/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          spaceId,
          text: text.trim(),
          threadName: thread?.threadName,
          threadKey: thread?.threadKey,
        }),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Send failed (${res.status})`)
      }

      // Revalidate the cached messages for this space. Prefix match also
      // covers every thread query under the space, so a reply shows up in
      // both the thread panel and the main view's reply count.
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
   useChatSelf — who am I in Chat? (gates the edit/delete affordances)
   ══════════════════════════════════════════ */

/**
 * The caller's own Chat user name ("users/<id>") — message senders carry only
 * this opaque id, so ownership can't be derived from the session email. null
 * (lookup unavailable) simply hides the edit/delete affordances.
 */
export function useChatSelf() {
  const { data } = useQuery<{ name: string | null }>({
    queryKey: ['chat', 'self'],
    queryFn: () => fetcher<{ name: string | null }>('/api/google/chat/me'),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: 1,
  })
  return { selfName: data?.name ?? null }
}

/* ══════════════════════════════════════════
   useOwnMessageActions — edit/delete the caller's own messages
   ══════════════════════════════════════════ */

export function useOwnMessageActions() {
  const queryClient = useQueryClient()
  const [busyName, setBusyName] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  // The space is the prefix of the message name; invalidating its key prefix
  // refreshes the live window and any open thread. (A message deleted from
  // loaded SCROLLBACK pages lingers until the space is reopened — the older
  // pages live outside the query cache by design.)
  const invalidateSpaceOf = useCallback(async (messageName: string) => {
    const spaceId = messageName.split('/messages/')[0]
    await queryClient.invalidateQueries({ queryKey: messagesQueryKey(spaceId) })
  }, [queryClient])

  const editMessage = useCallback(async (messageName: string, text: string): Promise<boolean> => {
    if (!text.trim() || busyName) return false
    setBusyName(messageName)
    setActionError(null)
    try {
      const res = await fetch('/api/google/chat/messages', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageName, text: text.trim() }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Edit failed (${res.status})`)
      }
      await invalidateSpaceOf(messageName)
      return true
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to edit message')
      return false
    } finally {
      setBusyName(null)
    }
  }, [busyName, invalidateSpaceOf])

  const deleteMessage = useCallback(async (messageName: string): Promise<boolean> => {
    if (busyName) return false
    setBusyName(messageName)
    setActionError(null)
    try {
      const res = await fetch(
        `/api/google/chat/messages?messageName=${encodeURIComponent(messageName)}`,
        { method: 'DELETE' }
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `Delete failed (${res.status})`)
      }
      await invalidateSpaceOf(messageName)
      return true
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete message')
      return false
    } finally {
      setBusyName(null)
    }
  }, [busyName, invalidateSpaceOf])

  return {
    editMessage,
    deleteMessage,
    busyName,
    actionError,
    clearActionError: () => setActionError(null),
  }
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
