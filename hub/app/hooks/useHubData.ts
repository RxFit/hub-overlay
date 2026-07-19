'use client'

import { useQuery } from '@tanstack/react-query'
import { signIn } from 'next-auth/react'
import { useEffect, useRef } from 'react'

/* ── Auth error recovery ── */

/**
 * Detects 401 errors from data hooks and auto-redirects to sign-in.
 * Returns true if an auth error was detected (for UI display).
 */
export function useAuthErrorRecovery(error: Error | undefined | null): boolean {
  const redirected = useRef(false)

  useEffect(() => {
    if (error && (error as any).status === 401 && !redirected.current) {
      redirected.current = true
      // Brief delay to show the error banner before redirecting
      const timer = setTimeout(() => {
        signIn('google')
      }, 2000)
      return () => clearTimeout(timer)
    }
  }, [error])

  return !!(error && (error as any).status === 401)
}

/* ── Generic JSON fetcher ── */

async function fetcher<T>(url: string): Promise<T> {
  const res = await fetch(url)

  if (res.status === 401) {
    const err = new Error('Unauthorized — Google token may have expired')
    ;(err as any).status = 401
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

/**
 * Fetch the aggregated activity feed from Paperclip.
 * Refreshes every 30 seconds.
 */
export function useFeed() {
  const { data, error, isLoading, refetch } = useQuery<FeedResponse>({
    queryKey: ['feed'],
    queryFn: () => fetcher<FeedResponse>('/api/feed'),
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  })

  return {
    items: data?.feed ?? [],
    isLoading,
    error: error ?? undefined,
    // Exposed so the Retry affordance can revalidate this one query instead of
    // reloading the whole app (which would discard chat/compose/thread state).
    refetch,
  }
}

/* ══════════════════════════════════════════
   Execution Dashboard (Paperclip)
   ══════════════════════════════════════════ */

import type { ExecutionDashboard } from '@/lib/execution-dashboard'

/**
 * Fetch the Paperclip company health snapshot behind the right panel's Pulse
 * header and Attention strip. Polls every 60s; keeps rendering stale data
 * through transient failures (retry: 2).
 */
export function useExecutionDashboard(orgId?: string) {
  const url = orgId
    ? `/api/paperclip/dashboard?orgId=${encodeURIComponent(orgId)}`
    : '/api/paperclip/dashboard'

  const { data, error, isLoading, refetch } = useQuery<ExecutionDashboard>({
    queryKey: ['execution-dashboard', orgId ?? 'default'],
    queryFn: () => fetcher<ExecutionDashboard>(url),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
    retry: 2,
  })

  return {
    dashboard: data ?? null,
    isLoading,
    error: error ?? undefined,
    refetch,
  }
}

/* ── Re-export types for convenience ── */
export type { TaskItem, TaskListItem, CalendarEvent, DriveFile, FeedItem }
