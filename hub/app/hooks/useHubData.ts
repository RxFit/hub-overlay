'use client'

import useSWR from 'swr'
import { signIn } from 'next-auth/react'
import { useEffect, useRef } from 'react'

/* ── Auth error recovery ── */

/**
 * Detects 401 errors from SWR hooks and auto-redirects to sign-in.
 * Returns true if an auth error was detected (for UI display).
 */
export function useAuthErrorRecovery(error: Error | undefined): boolean {
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
 * Refreshes every 30 seconds.
 */
export function useTasks() {
  // Step 1: fetch all task lists
  const {
    data: listData,
    error: listError,
  } = useSWR<TasksResponse>(
    '/api/google/tasks',
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false }
  )

  const taskLists = listData?.taskLists ?? []

  // Step 2: fetch tasks for EVERY list in parallel
  // SWR can't do dynamic-length hooks, so we cap at 10 lists and use a join key
  const listIds = taskLists.map(l => l.id)
  const allListsKey = listIds.length > 0
    ? `/api/google/tasks?allLists=${listIds.map(id => encodeURIComponent(id)).join(',')}`
    : null

  const {
    data: allTasksData,
    error: tasksError,
    isLoading: isLoadingTasks,
    mutate: mutateTasks,
  } = useSWR<Record<string, TaskItem[]>>(
    allListsKey,
    async () => {
      const results = await Promise.all(
        listIds.map(async (id) => {
          const res = await fetch(
            `/api/google/tasks?taskListId=${encodeURIComponent(id)}&showCompleted=false&maxResults=20`
          )
          if (!res.ok) return { id, tasks: [] }
          const data: TasksResponse = await res.json()
          return { id, tasks: data.tasks ?? [] }
        })
      )
      const map: Record<string, TaskItem[]> = {}
      for (const { id, tasks } of results) map[id] = tasks
      return map
    },
    { refreshInterval: 30_000, revalidateOnFocus: false }
  )

  const isLoading = !listData && !listError
  const error = listError || tasksError

  return {
    taskLists,
    tasksByList: allTasksData ?? {},
    isLoading: isLoading || isLoadingTasks,
    error,
    mutate: mutateTasks,
  }
}

/* ══════════════════════════════════════════
   Google Calendar
   ══════════════════════════════════════════ */

interface CalendarEvent {
  id: string
  summary: string
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
 * Fetch upcoming calendar events. Refreshes every 60 seconds.
 */
export function useCalendar() {
  // Request up to 100 events covering 30 days from today (server sets timeMin=today, timeMax=+30d)
  const { data, error, isLoading, mutate } = useSWR<CalendarResponse>(
    '/api/google/calendar?maxResults=100',
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false }
  )

  return {
    events: data?.events ?? [],
    isLoading,
    error,
    mutate,
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
export function useDrive(filter?: string) {
  const filterParam = filter || 'recent'
  const { data, error, isLoading } = useSWR<DriveResponse>(
    `/api/google/drive?filter=${filterParam}`,
    fetcher,
    { refreshInterval: 120_000, revalidateOnFocus: false }
  )

  return {
    files: data?.files ?? [],
    isLoading,
    error,
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
  const { data, error, isLoading } = useSWR<FeedResponse>(
    '/api/feed',
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false }
  )

  return {
    items: data?.feed ?? [],
    isLoading,
    error,
  }
}

/* ── Re-export types for convenience ── */
export type { TaskItem, TaskListItem, CalendarEvent, DriveFile, FeedItem }
