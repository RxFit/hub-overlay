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
  // Step 1: get task lists
  const {
    data: listData,
    error: listError,
  } = useSWR<TasksResponse>(
    '/api/google/tasks',
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false }
  )

  const firstListId = listData?.taskLists?.[0]?.id

  // Step 2: get tasks from the first list
  const {
    data: taskData,
    error: taskError,
    isLoading: isLoadingTasks,
  } = useSWR<TasksResponse>(
    firstListId ? `/api/google/tasks?taskListId=${encodeURIComponent(firstListId)}&showCompleted=false&maxResults=15` : null,
    fetcher,
    { refreshInterval: 30_000, revalidateOnFocus: false }
  )

  const isLoading = !listData && !listError
  const error = listError || taskError

  return {
    tasks: taskData?.tasks ?? [],
    taskListId: firstListId ?? null,
    isLoading: isLoading || isLoadingTasks,
    error,
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
}

interface CalendarResponse {
  events: CalendarEvent[]
}

/**
 * Fetch upcoming calendar events. Refreshes every 60 seconds.
 */
export function useCalendar() {
  const { data, error, isLoading } = useSWR<CalendarResponse>(
    '/api/google/calendar?maxResults=8',
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false }
  )

  return {
    events: data?.events ?? [],
    isLoading,
    error,
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
   Google Sheets — KPI Dashboard
   ══════════════════════════════════════════ */

interface SheetsResponse {
  values: {
    range: string
    majorDimension: string
    values: string[][]
  }
}

export interface KPIRow {
  label: string
  value: string
  trend: string
  up: boolean
}

/**
 * Fetch KPI data from a Google Sheet.
 * Expects rows in format: [label, value, trend, up/down].
 * Refreshes every 60 seconds.
 */
export function useKPIs(sheetId?: string, range?: string) {
  const params = new URLSearchParams()
  if (sheetId) params.set('spreadsheetId', sheetId)
  if (range) params.set('range', range)

  // Only fetch if we have a sheetId
  const url = sheetId
    ? `/api/google/sheets?${params.toString()}`
    : null

  const { data, error, isLoading } = useSWR<SheetsResponse>(
    url,
    fetcher,
    { refreshInterval: 60_000, revalidateOnFocus: false }
  )

  // Parse rows into KPI format
  const kpis: KPIRow[] = (data?.values?.values ?? []).map((row) => ({
    label: row[0] ?? '',
    value: row[1] ?? '0',
    trend: row[2] ?? '',
    up: (row[3] ?? 'true').toLowerCase() !== 'false',
  }))

  return {
    kpis,
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
