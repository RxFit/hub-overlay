'use client'

import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSession, signIn } from 'next-auth/react'
import { useEffect, useRef } from 'react'
import type { ExecutionSnapshot } from '@/lib/execution-context'
import type { NeedsYouQueue } from '@/lib/needs-you'

/* ── Auth error recovery ── */

/**
 * Process-wide single-flight latch for the automatic re-auth redirect.
 *
 * A Hub page mounts many data hooks at once (tasks, calendar, KPIs, Gmail,
 * Chat…). When a session really does die they ALL 401 at the same instant, and
 * each one used to arm its own `signIn()` timer — a pile of competing redirects
 * for one underlying cause. Latching at module scope means the first one wins
 * and the rest are no-ops.
 */
let reauthRedirectArmed = false

/** Test-only: clear the module-level latch between cases. */
export function __resetAuthErrorRecovery(): void {
  reauthRedirectArmed = false
}

/**
 * Force NextAuth to re-issue the session cookie with a fresh Google access
 * token.
 *
 * `getSession()` calls `/api/auth/session`, which is the ONLY request in the
 * app that runs the `jwt` callback with a response object able to write
 * Set-Cookie — route handlers using `getServerSession()` compute the rotated
 * token and drop it (no-op setCookie in next-auth's App Router path). So this
 * is the repair mechanism for a stale token, and it costs one same-origin call.
 *
 * In-flight calls are shared: a page full of hooks that all 401 at once must
 * trigger exactly one refresh, not a dozen.
 */
let sessionRefreshInFlight: Promise<unknown> | null = null

export async function refreshSessionCookie(): Promise<void> {
  if (!sessionRefreshInFlight) {
    sessionRefreshInFlight = getSession().finally(() => { sessionRefreshInFlight = null })
  }
  try {
    await sessionRefreshInFlight
  } catch {
    // Best-effort — the caller still throws, and the query retries.
  }
}

/**
 * Decide whether a failed request should bounce the user to Google sign-in.
 *
 * Only a 401 qualifies, and only when the route did not explicitly opt out with
 * `reauth: false`. That opt-out matters: a transient Google outage no longer
 * arrives as a 401 at all (routes answer 503 `{ retryable: true }` — see
 * lib/google-session.ts), but any route that does return a non-credential 401
 * can now say so instead of getting the user logged out for it.
 *
 * Pure and exported so the policy is unit-testable without a DOM.
 */
export function shouldTriggerReauth(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const e = error as { status?: unknown; reauth?: unknown }
  if (e.status !== 401) return false
  return e.reauth !== false
}

/**
 * Detects genuine auth failures from data hooks and re-authenticates.
 *
 * Returns true if an auth error was detected (for UI display).
 */
export function useAuthErrorRecovery(error: Error | undefined | null): boolean {
  const redirected = useRef(false)

  useEffect(() => {
    if (shouldTriggerReauth(error) && !redirected.current && !reauthRedirectArmed) {
      redirected.current = true
      reauthRedirectArmed = true
      // Brief delay to show the error banner before redirecting
      const timer = setTimeout(() => {
        // No `prompt` — with the grant already on file Google completes this
        // silently, so a recoverable expiry costs the user nothing. Only a
        // genuinely revoked grant surfaces the consent screen.
        signIn('google')
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [error])

  return shouldTriggerReauth(error)
}

/* ── Generic JSON fetcher ── */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)

  if (res.status === 401) {
    // Read the route's reauth signal so `{ reauth: false }` can suppress the
    // automatic sign-in redirect (see shouldTriggerReauth).
    const body = await res.json().catch(() => ({} as Record<string, unknown>))
    // `refresh: true` means the cookie's access token is merely stale, not
    // dead. Rotate it first (see refreshSessionCookie) so the retry TanStack
    // Query is about to make lands on a live token — instead of the old
    // behavior, where a stale token became a logout.
    if (body?.refresh === true) await refreshSessionCookie()
    const err = new Error(
      (typeof body?.error === 'string' && body.error) || 'Unauthorized — Google token may have expired',
    )
    ;(err as any).status = 401
    ;(err as any).reauth = body?.reauth
    throw err
  }

  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    const err = new Error(`API error ${res.status}: ${body}`)
    ;(err as any).status = res.status
    throw err
  }

  return res.json()
}

/* ══════════════════════════════════════════
   Google Tasks
   ══════════════════════════════════════════ */

/**
 * Aggregate fetcher for the per-list tasks step.
 * A 401 on any list rejects the whole fetcher with a status-tagged error so the
 * Tasks section can route into its auth branch. Non-auth per-list failures are
 * skipped so one bad list does not blank the entire section.
 */
export async function fetchTasksByList(listIds: string[]): Promise<Record<string, TaskItem[]>> {
  const results = await Promise.all(
    listIds.map(async (id) => {
      const res = await fetch(
        `/api/google/tasks?taskListId=${encodeURIComponent(id)}&showCompleted=false&maxResults=20`
      )
      if (res.status === 401) {
        const err = new Error('Unauthorized — Google token may have expired')
        ;(err as any).status = 401
        throw err
      }
      // Non-auth failures: skip this list rather than failing the whole panel.
      if (!res.ok) return { id, tasks: [] }
      const data: TasksResponse = await res.json()
      return { id, tasks: data.tasks ?? [] }
    })
  )
  const map: Record<string, TaskItem[]> = {}
  for (const { id, tasks } of results) map[id] = tasks
  return map
}

interface TaskItem {
  id: string
  title: string
  notes?: string
  status: 'needsAction' | 'completed'
  due?: string
  updated: string
  parent?: string
  position: string
}

interface TaskListItem {
  id: string
  title: string
  updated: string
}

interface TasksResponse {
  taskLists?: TaskListItem[]
  tasks?: TaskItem[]
}

/**
 * Fetch all tasks from the user's default task list.
 * First fetches task lists, then fetches tasks from the first list.
 *
 * Task lists change rarely, so the list set is polled slowly (5 min); the
 * per-list aggregate fan-out polls at 60s. Both are gated on `isOpen` so a
 * collapsed section stops polling entirely (the query key stays stable, so
 * cached data renders instantly on re-open).
 */
export function useTasks(isOpen: boolean = true) {
  // Step 1: fetch all task lists
  const {
    data: listData,
    error: listError,
    isLoading: isLoadingLists,
  } = useQuery<TasksResponse>({
    queryKey: ['hub', 'tasks', 'lists'],
    queryFn: () => fetcher<TasksResponse>('/api/google/tasks'),
    refetchInterval: isOpen ? 300_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  const taskLists = listData?.taskLists ?? []

  // Step 2: fetch tasks for EVERY list in parallel via a single aggregate query
  // keyed on the joined list-id set, so cache identity follows the list set.
  const listIds = taskLists.map(l => l.id)

  const {
    data: allTasksData,
    error: tasksError,
    isLoading: isLoadingTasks,
    refetch: refetchTasks,
  } = useQuery<Record<string, TaskItem[]>>({
    queryKey: ['hub', 'tasks', 'byList', listIds.join(',')],
    queryFn: () => fetchTasksByList(listIds),
    enabled: listIds.length > 0,
    refetchInterval: isOpen ? 60_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  const error = listError || tasksError

  return {
    taskLists,
    tasksByList: allTasksData ?? {},
    isLoading: isLoadingLists || isLoadingTasks,
    error: error ?? undefined,
    mutate: refetchTasks,
  }
}

/* ══════════════════════════════════════════
   Google Calendar
   ══════════════════════════════════════════ */

interface CalendarEvent {
  id: string
  summary?: string
  description?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  htmlLink: string
  status: string
  location?: string
  organizer?: { email: string; displayName?: string }
  attendees?: { email?: string; displayName?: string; responseStatus?: string }[]
  /** Source calendar (tagged by the API route) — needed to delete from the right calendar. */
  calendarId?: string
}

interface CalendarResponse {
  events: CalendarEvent[]
}

/**
 * Fetch upcoming calendar events. Refreshes every 60 seconds while open;
 * gated to 0 (no polling) when the section is collapsed.
 */
export function useCalendar(isOpen: boolean = true) {
  // Request up to 100 events covering 30 days from today (server sets timeMin=today, timeMax=+30d)
  const { data, error, isLoading, refetch } = useQuery<CalendarResponse>({
    queryKey: ['hub', 'calendar'],
    queryFn: () => fetcher<CalendarResponse>('/api/google/calendar?maxResults=100'),
    refetchInterval: isOpen ? 60_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  return {
    events: data?.events ?? [],
    isLoading,
    error: error ?? undefined,
    mutate: refetch,
  }
}

/* ══════════════════════════════════════════
   Google Drive
   ══════════════════════════════════════════ */

interface DriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  webViewLink?: string
  iconLink?: string
  owners?: { displayName: string; emailAddress: string }[]
  size?: string
}

interface DriveResponse {
  files: DriveFile[]
}

/**
 * Fetch files from Google Drive with optional filter.
 * Filters: 'recent' (default), 'shared', 'transcripts'.
 * Refreshes every 120 seconds.
 */
export function useDrive(filter?: string, enabled: boolean = true, isOpen: boolean = true) {
  const filterParam = filter || 'recent'
  const { data, error, isLoading, refetch } = useQuery<DriveResponse>({
    queryKey: ['hub', 'drive', filterParam],
    queryFn: () => fetcher<DriveResponse>(`/api/google/drive?filter=${filterParam}`),
    enabled,
    refetchInterval: isOpen ? 120_000 : false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  })

  return {
    files: data?.files ?? [],
    isLoading,
    error: error ?? undefined,
    mutate: refetch,
  }
}


/* ══════════════════════════════════════════
   Activity Feed (Paperclip)
   ══════════════════════════════════════════ */

interface FeedItem {
  id: string
  source: string
  type: 'completed' | 'in_progress' | 'needs_you' | 'info'
  title: string
  description: string
  timestamp: string
  icon?: string
  actionUrl?: string
  metadata?: Record<string, unknown>
}

interface FeedResponse {
  feed: FeedItem[]
}

/* ══════════════════════════════════════════
   Runs Feed (ai_runs ledger — Phase 3 PR 2)
   ══════════════════════════════════════════ */

/**
 * Fetch the execution feed from the Hub's own runs ledger (/api/runs).
 * Admin-gated server-side; pass `enabled: false` for non-admin sessions so
 * the panel renders its quiet admin-only state without ever calling.
 */
export function useRuns(enabled: boolean) {
  const { data, error, isLoading, refetch } = useQuery<FeedResponse>({
    queryKey: ['runs-feed'],
    queryFn: () => fetcher<FeedResponse>('/api/runs'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled,
  })

  return {
    items: data?.feed ?? [],
    isLoading: enabled ? isLoading : false,
    error: error ?? undefined,
    refetch,
  }
}

/* ══════════════════════════════════════════
   Execution Pulse (the Hub's own ledgers — Phase 4 PR 1)
   ══════════════════════════════════════════ */

/**
 * Fetch the execution snapshot behind the right panel's Pulse tab
 * (/api/execution/pulse). Same reader the chat route injects each turn, so
 * the tiles and the assistant describe identical facts. Admin planes come
 * back null for staff; the component renders those tiles as locked.
 */
export function useExecutionPulse(enabled: boolean = true) {
  const { data, error, isLoading, refetch } = useQuery<{ snapshot: ExecutionSnapshot }>({
    queryKey: ['execution-pulse'],
    queryFn: () => fetcher<{ snapshot: ExecutionSnapshot }>('/api/execution/pulse'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled,
  })

  return {
    snapshot: data?.snapshot ?? null,
    isLoading: enabled ? isLoading : false,
    error: error ?? undefined,
    refetch,
  }
}

/* ══════════════════════════════════════════
   Needs-you queue (Phase 4 PR 2)
   ══════════════════════════════════════════ */

/**
 * The "Needs you" queue at the top of the Runs tab (/api/execution/queue):
 * failed runs, failed actions, orphaned deep runs, dispatch alerts — derived
 * from the same ledgers the assistant reads, scoped the same way. Any
 * signed-in user has a queue (their own actions + deep runs), so this is
 * not admin-gated. `dismiss`/`retry` return the server's answer and
 * invalidate the queue (and the runs feed, which shares the ledgers).
 */
export function useNeedsYou(enabled: boolean = true) {
  const qc = useQueryClient()
  const { data, error, isLoading, refetch } = useQuery<NeedsYouQueue>({
    queryKey: ['needs-you'],
    queryFn: () => fetcher<NeedsYouQueue>('/api/execution/queue'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled,
  })

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['needs-you'] })
    void qc.invalidateQueries({ queryKey: ['runs-feed'] })
  }

  async function dismiss(key: string, undo = false): Promise<boolean> {
    // Optimistic: drop the card now; the refetch below is the truth.
    if (!undo) {
      qc.setQueryData<NeedsYouQueue>(['needs-you'], (cur) =>
        cur ? { ...cur, items: cur.items.filter((i) => i.key !== key), dismissedCount: cur.dismissedCount + 1 } : cur,
      )
    }
    const res = await fetch('/api/execution/queue/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, undo }),
    })
    invalidate()
    return res.ok
  }

  async function retryDeepRun(runId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const res = await fetch(`/api/deep-runs/${encodeURIComponent(runId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'retry' }),
    })
    const body = await res.json().catch(() => ({} as { error?: string }))
    invalidate()
    if (res.ok) return { ok: true }
    return { ok: false, error: typeof body?.error === 'string' ? body.error : `Retry failed (${res.status})` }
  }

  return {
    items: data?.items ?? [],
    dismissedCount: data?.dismissedCount ?? 0,
    notices: data?.notices ?? [],
    isLoading: enabled ? isLoading : false,
    error: error ?? undefined,
    refetch,
    dismiss,
    retryDeepRun,
  }
}

/* ── Re-export types for convenience ── */
export type { TaskItem, TaskListItem, CalendarEvent, DriveFile, FeedItem }
