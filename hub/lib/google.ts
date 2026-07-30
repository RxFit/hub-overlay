/**
 * Google Workspace REST API client.
 *
 * Uses raw fetch() — no npm packages needed.
 * Every function accepts an OAuth access_token obtained from the JWT.
 */

import { GOOGLE_API_TIMEOUT_MS } from './timeout-config'

/* ── Base helpers ── */

async function googleFetch<T>(
  url: string,
  accessToken: string,
  opts?: RequestInit
): Promise<T> {
  const res = await fetch(url, {
    // Bound every Google call (GOOGLE_API_TIMEOUT_MS) so a hung upstream can't
    // block the route to its maxDuration; callers may override via opts.signal.
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
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

/** Update a task's title, notes, and/or due date (only provided fields change) */
export async function updateTask(
  accessToken: string,
  taskListId: string,
  taskId: string,
  patch: { title?: string; notes?: string; due?: string }
): Promise<GoogleTask> {
  return googleFetch<GoogleTask>(
    `${TASKS_BASE}/lists/${taskListId}/tasks/${taskId}`,
    accessToken,
    {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }
  )
}

/** Permanently delete a task. Google returns 204 with an empty body, so this
 *  bypasses googleFetch's res.json() and checks the status directly. */
export async function deleteTask(
  accessToken: string,
  taskListId: string,
  taskId: string
): Promise<void> {
  const res = await fetch(`${TASKS_BASE}/lists/${taskListId}/tasks/${taskId}`, {
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => 'Unknown error')
    throw new Error(`Google API error ${res.status}: ${body}`)
  }
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
  /** Google Meet (Hangout) URL when the event was created with addMeetLink. */
  hangoutLink?: string
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] }
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
    addMeetLink?: boolean  // when true, mint + attach a Google Meet link
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

  // Google Meet link: requesting conferenceData.createRequest with a unique
  // requestId (and conferenceDataVersion=1 on the call) makes Google mint a
  // Meet link and attach it to the event. No new scope needed — the existing
  // full `calendar` scope covers this. requestId dedupes retries; we derive a
  // stable one from the event summary + start so a retried insert coalesces.
  const params = new URLSearchParams()
  if (event.addMeetLink) {
    const requestId = `hub-${event.start}-${event.summary}`.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 64) || 'hub-meet'
    body.conferenceData = {
      createRequest: {
        requestId,
        conferenceSolutionKey: { type: 'hangoutsMeet' },
      },
    }
    params.set('conferenceDataVersion', '1')
  }

  const qs = params.toString()
  return googleFetch<GoogleCalendarEvent>(
    `${CALENDAR_BASE}/calendars/${calId}/events${qs ? `?${qs}` : ''}`,
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
      signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
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

/**
 * Escape a user-supplied term for a Drive `q` query string.
 *
 * Drive query literals are single-quoted, so an unescaped apostrophe ends the
 * literal and the rest of the term is parsed as query syntax — which at best
 * 400s and at worst changes what the query means. Backslashes must be escaped
 * first or they would escape the escapes we add.
 */
export function escapeDriveQueryTerm(term: string): string {
  return term.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/**
 * Search Drive for files matching a term, by CONTENT and by filename.
 *
 * `fullText contains` searches indexed document body text, not just titles —
 * this is what makes "find the Nuvita partnership agreement" work when the
 * filename says nothing about partnerships. The name clause is OR'd in because
 * full-text indexing lags for freshly-uploaded files, and a filename match is
 * exactly what a user means when they name a document.
 *
 * Trashed files are always excluded: surfacing a deleted document as a live
 * source is worse than returning nothing.
 */
export async function searchDriveFiles(
  accessToken: string,
  term: string,
  opts?: { maxResults?: number }
): Promise<GoogleDriveFile[]> {
  const safe = escapeDriveQueryTerm(term.trim())
  if (!safe) return []

  const params = new URLSearchParams({
    q: `(fullText contains '${safe}' or name contains '${safe}') and trashed = false`,
    orderBy: 'modifiedTime desc',
    pageSize: String(opts?.maxResults ?? 8),
    fields: 'files(id,name,mimeType,modifiedTime,webViewLink,owners,size)',
  })

  const data = await googleFetch<{ files?: GoogleDriveFile[] }>(
    `${DRIVE_BASE}/files?${params}`,
    accessToken
  )
  return data.files ?? []
}

/**
 * Google Workspace mime types that must be EXPORTED rather than downloaded,
 * mapped to the export format that best preserves their text.
 *
 * A native Google Doc has no bytes to download — `alt=media` returns 403 for
 * these — so the export endpoint is the only way to read one.
 */
const WORKSPACE_EXPORT_FORMATS: Record<string, string> = {
  'application/vnd.google-apps.document': 'text/plain',
  'application/vnd.google-apps.presentation': 'text/plain',
  // CSV exports only the FIRST sheet; that is a real limitation of the export
  // endpoint, and it is still far more useful than refusing to read the file.
  'application/vnd.google-apps.spreadsheet': 'text/csv',
}

/** Non-Workspace types whose bytes are already text and can be read directly. */
const DIRECTLY_READABLE = /^(text\/|application\/(json|xml|x-ndjson|javascript|typescript))/

export interface DriveFileContent {
  id: string
  name: string
  mimeType: string
  text: string
  /** True when the body was cut at maxChars. */
  truncated: boolean
  webViewLink?: string
}

/**
 * Read a Drive file's text.
 *
 * Handles the two distinct cases the Drive API draws a hard line between:
 * native Workspace files are EXPORTED to a text format, everything else is
 * downloaded with `alt=media`. Binary formats we cannot turn into text (PDF,
 * images, video, zip) are reported as such rather than returning mojibake —
 * a model handed garbled bytes will confidently invent content from them.
 *
 * `maxChars` bounds the result because this text goes into a prompt: a 200-page
 * document would blow the context window and evict everything else.
 */
export async function readDriveFileText(
  accessToken: string,
  fileId: string,
  opts?: { maxChars?: number }
): Promise<DriveFileContent> {
  const maxChars = opts?.maxChars ?? 12_000

  const meta = await googleFetch<GoogleDriveFile>(
    `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink`,
    accessToken
  )

  const exportFormat = WORKSPACE_EXPORT_FORMATS[meta.mimeType]
  const isDirect = DIRECTLY_READABLE.test(meta.mimeType)

  if (!exportFormat && !isDirect) {
    return {
      id: meta.id,
      name: meta.name,
      mimeType: meta.mimeType,
      text: `[This file is ${meta.mimeType}, which has no text representation the Hub can extract. Open it directly: ${meta.webViewLink ?? '(no link)'}]`,
      truncated: false,
      webViewLink: meta.webViewLink,
    }
  }

  const url = exportFormat
    ? `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportFormat)}`
    : `${DRIVE_BASE}/files/${encodeURIComponent(fileId)}?alt=media`

  // Not googleFetch: that helper parses JSON, and these endpoints return raw
  // text/CSV bodies.
  const res = await fetch(url, {
    signal: AbortSignal.timeout(GOOGLE_API_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Google API error ${res.status}: ${body.slice(0, 200)}`)
  }

  const raw = await res.text()
  const text = raw.length > maxChars ? raw.slice(0, maxChars) : raw

  return {
    id: meta.id,
    name: meta.name,
    mimeType: meta.mimeType,
    text,
    truncated: raw.length > maxChars,
    webViewLink: meta.webViewLink,
  }
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
    mimeType?: string
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
    // Snippet from the LAST message (like subject/from/date/unread), so a
    // multi-message thread previews its latest reply — matching Gmail's own
    // list — instead of the oldest message the thread opened with.
    snippet: lastMsg.snippet ?? '',
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

/**
 * Mark a space read up to `lastReadTime` (defaults to now). Requires the
 * chat.users.readstate WRITE scope — with only the readonly scope Google
 * returns 403, which callers surface as MISSING_SCOPE.
 */
export async function updateSpaceReadState(
  accessToken: string,
  spaceId: string,
  lastReadTime: string = new Date().toISOString()
): Promise<SpaceReadState> {
  const spaceName = spaceId.startsWith('spaces/') ? spaceId : `spaces/${spaceId}`
  return googleFetch<SpaceReadState>(
    `${CHAT_BASE}/users/me/${spaceName}/spaceReadState?updateMask=lastReadTime`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify({ lastReadTime }) }
  )
}

/* ══════════════════════════════════════════
   Google Docs  —  https://docs.googleapis.com/v1
   Scopes: documents (create/edit) + drive.file (file lands in the user's Drive)
   ══════════════════════════════════════════ */

const DOCS_BASE = 'https://docs.googleapis.com/v1'

export interface GoogleDoc {
  documentId: string
  title: string
  /** Convenience URL (not returned by the API — we synthesize it). */
  documentUrl?: string
}

/**
 * Create a Google Doc with a title and optional body text. Two calls: create
 * the (empty) doc, then batchUpdate to insert the body at index 1. Returns the
 * doc id + a synthesized editor URL.
 */
export async function createGoogleDoc(
  accessToken: string,
  input: { title: string; body?: string }
): Promise<GoogleDoc> {
  const created = await googleFetch<{ documentId: string; title: string }>(
    `${DOCS_BASE}/documents`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ title: input.title }) }
  )

  if (input.body && input.body.trim()) {
    await googleFetch<unknown>(
      `${DOCS_BASE}/documents/${created.documentId}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [{ insertText: { location: { index: 1 }, text: input.body } }],
        }),
      }
    )
  }

  return {
    documentId: created.documentId,
    title: created.title,
    documentUrl: `https://docs.google.com/document/d/${created.documentId}/edit`,
  }
}

/* ══════════════════════════════════════════
   Google Sheets  —  https://sheets.googleapis.com/v4
   Scopes: spreadsheets (create/edit) + drive.file
   ══════════════════════════════════════════ */

const SHEETS_BASE = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface GoogleSheet {
  spreadsheetId: string
  title: string
  spreadsheetUrl: string
}

/**
 * Create a Google Sheet with a title and optional seed rows (array of rows,
 * each a string[] of cell values) written starting at A1.
 */
export async function createGoogleSheet(
  accessToken: string,
  input: { title: string; rows?: string[][] }
): Promise<GoogleSheet> {
  const created = await googleFetch<{ spreadsheetId: string; spreadsheetUrl: string; properties?: { title?: string } }>(
    SHEETS_BASE,
    accessToken,
    { method: 'POST', body: JSON.stringify({ properties: { title: input.title } }) }
  )

  if (input.rows?.length) {
    await googleFetch<unknown>(
      `${SHEETS_BASE}/${created.spreadsheetId}/values/A1?valueInputOption=USER_ENTERED`,
      accessToken,
      { method: 'PUT', body: JSON.stringify({ values: input.rows }) }
    )
  }

  return {
    spreadsheetId: created.spreadsheetId,
    title: created.properties?.title ?? input.title,
    spreadsheetUrl: created.spreadsheetUrl ?? `https://docs.google.com/spreadsheets/d/${created.spreadsheetId}/edit`,
  }
}

/* ══════════════════════════════════════════
   Google People (Contacts)  —  https://people.googleapis.com/v1
   Scope: contacts.readonly. Used to resolve a name → email address.
   ══════════════════════════════════════════ */

const PEOPLE_BASE = 'https://people.googleapis.com/v1'

export interface ContactMatch {
  displayName: string
  email: string
}

/**
 * Search the user's contacts by free-text query, returning name+email matches.
 * Uses People API searchContacts (readMask limited to names + emailAddresses).
 */
export async function searchContacts(
  accessToken: string,
  query: string,
  pageSize = 10
): Promise<ContactMatch[]> {
  const params = new URLSearchParams({
    query,
    readMask: 'names,emailAddresses',
    pageSize: String(pageSize),
  })
  const data = await googleFetch<{
    results?: { person?: { names?: { displayName?: string }[]; emailAddresses?: { value?: string }[] } }[]
  }>(`${PEOPLE_BASE}/people:searchContacts?${params}`, accessToken)

  const matches: ContactMatch[] = []
  for (const r of data.results ?? []) {
    const email = r.person?.emailAddresses?.[0]?.value
    if (!email) continue
    matches.push({ email, displayName: r.person?.names?.[0]?.displayName ?? email })
  }
  return matches
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * Resolve a recipient reference to an email address. If it already looks like
 * an email, it's returned unchanged. Otherwise the contacts are searched and
 * the best match is returned. Returns `null` when nothing resolves — callers
 * decide whether to surface an actionable "couldn't find that contact" error.
 */
export async function resolveRecipient(
  accessToken: string,
  reference: string
): Promise<ContactMatch | null> {
  const ref = (reference || '').trim()
  if (!ref) return null
  if (EMAIL_RE.test(ref)) return { email: ref, displayName: ref }

  // 1) Personal contacts (People API).
  try {
    const matches = await searchContacts(accessToken, ref, 5)
    const exact = matches.find((m) => m.displayName.toLowerCase() === ref.toLowerCase())
    const hit = exact ?? matches[0]
    if (hit) return hit
  } catch {
    /* contacts scope missing or lookup failed — fall through to directory */
  }

  // 2) Org directory (Admin SDK) — best-effort. A colleague who isn't in
  //    personal contacts still resolves here. Failure (scope not granted /
  //    Admin SDK off) is swallowed so contacts-only setups keep working.
  try {
    const dir = await searchDirectoryUsers(accessToken, ref, 5)
    const exact = dir.find((m) => m.displayName.toLowerCase() === ref.toLowerCase())
    return exact ?? dir[0] ?? null
  } catch {
    return null
  }
}

/* ══════════════════════════════════════════
   Google Slides  —  https://slides.googleapis.com/v1
   Scopes: presentations (create/edit) + drive.file
   ══════════════════════════════════════════ */

const SLIDES_BASE = 'https://slides.googleapis.com/v1/presentations'

export interface GooglePresentation {
  presentationId: string
  title: string
  presentationUrl: string
}

/**
 * Create a Google Slides deck. Creates the presentation with a title, then —
 * when body text is supplied — appends a TITLE_AND_BODY slide and inserts the
 * title + body into its placeholders (the standard Slides batchUpdate pattern
 * with explicit placeholder object IDs).
 */
export async function createGooglePresentation(
  accessToken: string,
  input: { title: string; body?: string }
): Promise<GooglePresentation> {
  const created = await googleFetch<{ presentationId: string; title?: string }>(
    SLIDES_BASE,
    accessToken,
    { method: 'POST', body: JSON.stringify({ title: input.title }) }
  )

  const body = (input.body || '').trim()
  if (body) {
    const slideId = 'hub_slide_1'
    const titleId = 'hub_slide_1_title'
    const bodyId = 'hub_slide_1_body'
    await googleFetch<unknown>(
      `${SLIDES_BASE}/${created.presentationId}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              createSlide: {
                objectId: slideId,
                slideLayoutReference: { predefinedLayout: 'TITLE_AND_BODY' },
                placeholderIdMappings: [
                  { layoutPlaceholder: { type: 'TITLE' }, objectId: titleId },
                  { layoutPlaceholder: { type: 'BODY' }, objectId: bodyId },
                ],
              },
            },
            { insertText: { objectId: titleId, text: input.title } },
            { insertText: { objectId: bodyId, text: body } },
          ],
        }),
      }
    )
  }

  return {
    presentationId: created.presentationId,
    title: created.title ?? input.title,
    presentationUrl: `https://docs.google.com/presentation/d/${created.presentationId}/edit`,
  }
}

/* ══════════════════════════════════════════
   Admin SDK Directory  —  https://admin.googleapis.com/admin/directory/v1
   Scope: admin.directory.user.readonly. Resolve an org colleague → work email.
   ══════════════════════════════════════════ */

const DIRECTORY_BASE = 'https://admin.googleapis.com/admin/directory/v1'

/**
 * Search the org directory for users matching a free-text query, returning
 * name+email matches. Uses viewType=domain_public so non-admin users can read
 * the shared directory. `customer=my_customer` scopes the search to the
 * caller's own Workspace organization.
 */
export async function searchDirectoryUsers(
  accessToken: string,
  query: string,
  pageSize = 10
): Promise<ContactMatch[]> {
  // Directory query terms separated by spaces are ANDed, so search by name
  // only (the recipient-resolution case: "Maria" → her work email). Quotes are
  // stripped so they can't break the `name:'…'` term.
  const safe = query.replace(/['"]/g, '').trim()
  const params = new URLSearchParams({
    customer: 'my_customer',
    query: `name:'${safe}'`,
    viewType: 'domain_public',
    maxResults: String(pageSize),
    projection: 'basic',
  })
  const data = await googleFetch<{
    users?: { primaryEmail?: string; name?: { fullName?: string } }[]
  }>(`${DIRECTORY_BASE}/users?${params}`, accessToken)

  const matches: ContactMatch[] = []
  for (const u of data.users ?? []) {
    if (!u.primaryEmail) continue
    matches.push({ email: u.primaryEmail, displayName: u.name?.fullName ?? u.primaryEmail })
  }
  return matches
}
