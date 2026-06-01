/**
 * Google Workspace REST API client.
 *
 * Uses raw fetch() — no npm packages needed.
 * Every function accepts an OAuth access_token obtained from the JWT.
 */

/* ── Base helpers ── */

async function googleFetch<T>(
  url: string,
  accessToken: string,
  opts?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    ...opts,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...opts?.headers,
    },
  })

  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    throw new Error(`Google API error ${res.status}: ${body}`)
  }

  return res.json()
}

/* ══════════════════════════════════════════
   Google Tasks  —  https://tasks.googleapis.com/tasks/v1
   ══════════════════════════════════════════ */

const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1'

export interface GoogleTaskList {
  id: string
  title: string
  updated: string
}

export interface GoogleTask {
  id: string
  title: string
  notes?: string
  status: 'needsAction' | 'completed'
  due?: string
  updated: string
  parent?: string
  position: string
}

/** List all task lists for the authenticated user */
export async function listTaskLists(accessToken: string): Promise<GoogleTaskList[]> {
  const data = await googleFetch<{ items?: GoogleTaskList[] }>(
    `${TASKS_BASE}/users/@me/lists`,
    accessToken
  )
  return data.items ?? []
}

/** List tasks within a specific task list */
export async function listTasks(
  accessToken: string,
  taskListId: string,
  opts?: { showCompleted?: boolean; maxResults?: number }
): Promise<GoogleTask[]> {
  const params = new URLSearchParams()
  if (opts?.showCompleted !== undefined) params.set('showCompleted', String(opts.showCompleted))
  if (opts?.maxResults) params.set('maxResults', String(opts.maxResults))
  const qs = params.toString() ? `?${params}` : ''

  const data = await googleFetch<{ items?: GoogleTask[] }>(
    `${TASKS_BASE}/lists/${taskListId}/tasks${qs}`,
    accessToken
  )
  return data.items ?? []
}

/** Create a new task in a task list */
export async function createTask(
  accessToken: string,
  taskListId: string,
  task: { title: string; notes?: string; due?: string }
): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(
    `${TASKS_BASE}/lists/${taskListId}/tasks`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(task),
    }
  )
}

/** Mark a task as completed */
export async function completeTask(
  accessToken: string,
  taskListId: string,
  taskId: string
): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(
    `${TASKS_BASE}/lists/${taskListId}/tasks/${taskId}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'completed' }),
    }
  )
}

/* ══════════════════════════════════════════
   Google Calendar  —  https://www.googleapis.com/calendar/v3
   ══════════════════════════════════════════ */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

export interface GoogleCalendarEvent {
  id: string
  summary: string
  description?: string
  start: { dateTime?: string; date?: string }
  end: { dateTime?: string; date?: string }
  htmlLink: string
  status: string
  organizer?: { email: string; displayName?: string }
  attendees?: { email: string; responseStatus: string }[]
}

/** List upcoming events from the user's primary calendar */
export async function listUpcomingEvents(
  accessToken: string,
  opts?: { maxResults?: number; calendarId?: string }
): Promise<GoogleCalendarEvent[]> {
  const calendarId = encodeURIComponent(opts?.calendarId ?? 'primary')
  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    orderBy: 'startTime',
    singleEvents: 'true',
    maxResults: String(opts?.maxResults ?? 10),
  })

  const data = await googleFetch<{ items?: GoogleCalendarEvent[] }>(
    `${CALENDAR_BASE}/calendars/${calendarId}/events?${params}`,
    accessToken
  )
  return data.items ?? []
}

/** Create a new calendar event */
export async function createCalendarEvent(
  accessToken: string,
  event: {
    summary: string
    description?: string
    start: string   // ISO datetime or date
    end: string     // ISO datetime or date
    attendees?: string[]  // email addresses
    calendarId?: string
  }
): Promise<GoogleCalendarEvent> {
  const calId = encodeURIComponent(event.calendarId ?? 'primary')
  const isAllDay = event.start.length === 10  // "2026-05-30" vs "2026-05-30T10:00:00"

  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: isAllDay ? { date: event.start } : { dateTime: event.start },
    end: isAllDay ? { date: event.end } : { dateTime: event.end },
  }

  if (event.attendees?.length) {
    body.attendees = event.attendees.map(email => ({ email }))
  }

  return googleFetch<GoogleCalendarEvent>(
    `${CALENDAR_BASE}/calendars/${calId}/events`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

/* ══════════════════════════════════════════
   Google Drive  —  https://www.googleapis.com/drive/v3
   ══════════════════════════════════════════ */

const DRIVE_BASE = 'https://www.googleapis.com/drive/v3'

export interface GoogleDriveFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  webViewLink?: string
  iconLink?: string
  owners?: { displayName: string; emailAddress: string }[]
  size?: string
}

/** List recent files from Google Drive */
export async function listRecentFiles(
  accessToken: string,
  opts?: { maxResults?: number; query?: string }
): Promise<GoogleDriveFile[]> {
  const params = new URLSearchParams({
    orderBy: 'modifiedTime desc',
    pageSize: String(opts?.maxResults ?? 10),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,iconLink,owners,size)',
  })
  if (opts?.query) params.set('q', opts.query)

  const data = await googleFetch<{ files?: GoogleDriveFile[] }>(
    `${DRIVE_BASE}/files?${params}`,
    accessToken
  )
  return data.files ?? []
}

/* ══════════════════════════════════════════
   Google Sheets  —  https://sheets.googleapis.com/v4
   ══════════════════════════════════════════ */

const SHEETS_BASE = 'https://sheets.googleapis.com/v4'

export interface GoogleSheetValues {
  range: string
  majorDimension: string
  values: string[][]
}

/** Read values from a Google Sheet range (e.g. "Sheet1!A1:D10") */
export async function readSheetValues(
  accessToken: string,
  spreadsheetId: string,
  range: string
): Promise<GoogleSheetValues> {
  const encodedRange = encodeURIComponent(range)
  return googleFetch<GoogleSheetValues>(
    `${SHEETS_BASE}/spreadsheets/${spreadsheetId}/values/${encodedRange}`,
    accessToken
  )
}

/* ══════════════════════════════════════════
   Google Chat  —  https://chat.googleapis.com/v1
   ══════════════════════════════════════════ */

const CHAT_BASE = 'https://chat.googleapis.com/v1'

export interface ChatSpace {
  name: string                    // "spaces/XXXXXXXX"
  displayName: string
  type: 'ROOM' | 'DM' | 'GROUP_CHAT' | 'SPACE'
  spaceType?: string
  singleUserBotDm?: boolean
  spaceDetails?: { description?: string }
  adminInstalled?: boolean
}

export interface ChatMessage {
  name: string                    // "spaces/xxx/messages/yyy"
  sender: {
    name: string
    displayName: string
    domainId?: string
    type?: string
    isAnonymous?: boolean
  }
  createTime: string              // ISO timestamp
  text: string
  formattedText?: string
  thread?: { name: string }
  space?: { name: string }
  clientAssignedMessageId?: string
  annotations?: unknown[]
}

export interface ChatSpacesResponse {
  spaces: ChatSpace[]
  nextPageToken?: string
}

export interface ChatMessagesResponse {
  messages: ChatMessage[]
  nextPageToken?: string
}

/** List all Google Chat spaces the authenticated user is a member of */
export async function listChatSpaces(
  accessToken: string,
  pageSize = 100
): Promise<ChatSpace[]> {
  const params = new URLSearchParams({
    pageSize: String(pageSize),
  })
  const data = await googleFetch<ChatSpacesResponse>(
    `${CHAT_BASE}/spaces?${params}`,
    accessToken
  )
  // Filter out bot DMs for cleaner UX
  return (data.spaces ?? []).filter(s => !s.singleUserBotDm)
}

/** List recent messages from a Google Chat space */
export async function listChatMessages(
  accessToken: string,
  spaceId: string,
  pageSize = 50
): Promise<ChatMessage[]> {
  // spaceId can be "spaces/XXXXXXXX" or just "XXXXXXXX"
  const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    orderBy: 'createTime desc',
  })
  const data = await googleFetch<ChatMessagesResponse>(
    `${CHAT_BASE}/${spaceName}/messages?${params}`,
    accessToken
  )
  // Return in chronological order (oldest first for chat display)
  return (data.messages ?? []).reverse()
}

/** Send a new message or reply to a Google Chat space */
export async function sendChatMessage(
  accessToken: string,
  spaceId: string,
  text: string,
  threadKey?: string
): Promise<ChatMessage> {
  const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`

  const body: Record<string, unknown> = { text }
  if (threadKey) {
    body.thread = { threadKey }
  }

  return googleFetch<ChatMessage>(
    `${CHAT_BASE}/${spaceName}/messages`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify(body),
    }
  )
}

