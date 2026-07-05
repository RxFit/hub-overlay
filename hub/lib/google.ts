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
    // Bound every Google call (10s) so a hung upstream can't block the route to
    // its maxDuration; callers may override via opts.signal.
    signal: AbortSignal.timeout(10_000),
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

/** Mark a task as needing action (uncomplete/restore) */
export async function uncompleteTask(
  accessToken: string,
  taskListId: string,
  taskId: string
): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(
    `${TASKS_BASE}/lists/${taskListId}/tasks/${taskId}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify({ status: 'needsAction', completed: null }),
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
  /** Source calendar this event was fetched from — required to delete it from the
   *  correct calendar (events.list doesn't include it; the route tags it). */
  calendarId?: string
}

export interface GoogleCalendarListEntry {
  id: string
  summary: string
  selected?: boolean
  primary?: boolean
}

export async function listCalendars(accessToken: string): Promise<GoogleCalendarListEntry[]> {
  const data = await googleFetch<{ items?: GoogleCalendarListEntry[] }>(
    `${CALENDAR_BASE}/users/me/calendarList`,
    accessToken
  )
  return data.items ?? []
}

/** List calendar events within a time window.
 * Defaults: timeMin = start of today (not NOW — so past events from today remain visible)
 *           timeMax = 30 days from now
 *           maxResults = 50
 */
export async function listUpcomingEvents(
  accessToken: string,
  opts?: { maxResults?: number; calendarId?: string; timeMin?: string; timeMax?: string }
): Promise<GoogleCalendarEvent[]> {
  const calendarId = encodeURIComponent(opts?.calendarId ?? 'primary')

  // Default timeMin = 7 days ago so past week is navigable in the week strip
  const sevenDaysAgo = new Date()
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)
  sevenDaysAgo.setHours(0, 0, 0, 0)

  // Default timeMax = 60 days from now for 2-month forward coverage
  const sixtyDaysOut = new Date()
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60)

  const params = new URLSearchParams({
    timeMin: opts?.timeMin ?? sevenDaysAgo.toISOString(),
    timeMax: opts?.timeMax ?? sixtyDaysOut.toISOString(),
    orderBy: 'startTime',
    singleEvents: 'true',
    maxResults: String(opts?.maxResults ?? 50),
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
    location?: string
    timeZone?: string  // IANA tz, e.g. "America/Chicago"; required for correct timed events
    calendarId?: string
  }
): Promise<GoogleCalendarEvent> {
  const calId = encodeURIComponent(event.calendarId ?? 'primary')
  const isAllDay = event.start.length === 10  // "2026-05-30" vs "2026-05-30T10:00:00"

  // For timed events, attach the caller's IANA time zone so Google anchors the
  // naive local datetime to the right offset instead of the calendar default.
  const startField = isAllDay
    ? { date: event.start }
    : { dateTime: event.start, ...(event.timeZone ? { timeZone: event.timeZone } : {}) }
  const endField = isAllDay
    ? { date: event.end }
    : { dateTime: event.end, ...(event.timeZone ? { timeZone: event.timeZone } : {}) }

  const body: Record<string, unknown> = {
    summary: event.summary,
    description: event.description,
    start: startField,
    end: endField,
  }

  if (event.location) body.location = event.location

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

/** Delete a calendar event by ID */
export async function deleteCalendarEvent(
  accessToken: string,
  eventId: string,
  calendarId = 'primary'
): Promise<void> {
  const calId = encodeURIComponent(calendarId)
  const res = await fetch(
    `${CALENDAR_BASE}/calendars/${calId}/events/${encodeURIComponent(eventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(10_000),
    }
  )
  if (!res.ok && res.status !== 204 && res.status !== 410) {
    const msg = await res.text().catch(() => 'Unknown error')
    throw new Error(`deleteCalendarEvent ${res.status}: ${msg}`)
  }
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
   Gmail  —  https://gmail.googleapis.com/gmail/v1
   ══════════════════════════════════════════ */

const GMAIL_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  payload?: {
    headers?: { name: string; value: string }[]
    body?: { data?: string }
    parts?: { mimeType: string; body?: { data?: string } }[]
  }
  internalDate?: string
}

export interface GmailThread {
  id: string
  messages?: GmailMessage[]
  snippet?: string
}

export interface GmailThreadSummary {
  id: string
  subject: string
  from: string
  date: string
  snippet: string
  isUnread: boolean
  messageCount: number
}

/** Read a named RFC-2822 header off a Gmail message (case-insensitive). */
export function getGmailHeader(msg: GmailMessage, name: string): string {
  return msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

/** Collapse a metadata-format Gmail thread into a one-line summary.
 *  Shared by the Gmail route and the AI context builder — keep it the single
 *  implementation of thread-summary parsing. */
export function parseGmailThreadMeta(thread: GmailThread): GmailThreadSummary | null {
  const lastMsg = thread.messages?.[thread.messages.length - 1]
  if (!lastMsg) return null
  const isUnread = lastMsg.labelIds?.includes('UNREAD') ?? false
  return {
    id: thread.id,
    subject: getGmailHeader(lastMsg, 'Subject') || '(no subject)',
    from: getGmailHeader(lastMsg, 'From') || '',
    date: getGmailHeader(lastMsg, 'Date') || '',
    snippet: thread.messages?.[0]?.snippet ?? '',
    isUnread,
    messageCount: thread.messages?.length ?? 1,
  }
}

/** List the most recent inbox threads with From/Subject/Date metadata. */
export async function listRecentGmailThreads(
  accessToken: string,
  opts?: { maxResults?: number }
): Promise<GmailThreadSummary[]> {
  const maxResults = opts?.maxResults ?? 10
  const list = await googleFetch<{ threads?: { id: string; snippet?: string }[] }>(
    `${GMAIL_BASE}/threads?labelIds=INBOX&maxResults=${maxResults}`,
    accessToken
  )
  if (!list.threads?.length) return []

  // Fetch metadata for each thread in parallel; a single bad thread is dropped
  // rather than failing the whole list.
  const threads = await Promise.all(
    list.threads.map(t =>
      googleFetch<GmailThread>(
        `${GMAIL_BASE}/threads/${t.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        accessToken
      )
        .then(parseGmailThreadMeta)
        .catch(() => null)
    )
  )
  return threads.filter((t): t is GmailThreadSummary => t !== null)
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

/* ── Space Members (for @mentions) ── */

export interface SpaceMember {
  name: string               // "spaces/xxx/members/yyy"
  member: {
    name: string             // "users/123456"
    displayName: string
    domainId?: string
    type: 'HUMAN' | 'BOT'
    email?: string
  }
  role: 'ROLE_MEMBER' | 'ROLE_MANAGER' | 'ROLE_UNSPECIFIED'
  state: 'MEMBER_JOINED' | 'MEMBER_INVITED' | 'MEMBER_NOT_A_MEMBER'
  createTime?: string
}

interface SpaceMembersResponse {
  memberships: SpaceMember[]
  nextPageToken?: string
}

/** List members of a Google Chat space (for @mention picker) */
export async function listSpaceMembers(
  accessToken: string,
  spaceId: string,
  pageSize = 100
): Promise<SpaceMember[]> {
  const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`
  const params = new URLSearchParams({
    pageSize: String(pageSize),
    filter: 'member.type = "HUMAN"',
  })
  const data = await googleFetch<SpaceMembersResponse>(
    `${CHAT_BASE}/${spaceName}/members?${params}`,
    accessToken
  )
  return (data.memberships ?? []).filter(m => m.state === 'MEMBER_JOINED')
}

/* ── Space Read State (for unread badges) ── */

export interface SpaceReadState {
  name: string               // "users/me/spaces/xxx/spaceReadState"
  lastReadTime: string       // ISO timestamp
}

/** Get the authenticated user's read state for a space */
export async function getSpaceReadState(
  accessToken: string,
  spaceId: string
): Promise<SpaceReadState> {
  const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`
  return googleFetch<SpaceReadState>(
    `${CHAT_BASE}/users/me/${spaceName}/spaceReadState`,
    accessToken
  )
}
