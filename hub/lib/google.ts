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
    createMeetLink?: boolean
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

  if (event.createMeetLink) {
    body.conferenceData = {
      createRequest: {
        requestId: `meet-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
        conferenceSolutionKey: {
          type: 'hangoutsMeet',
        },
      },
    }
  }

  const queryParams = event.createMeetLink ? '?conferenceDataVersion=1' : ''

  return googleFetch<GoogleCalendarEvent>(
    `${CALENDAR_BASE}/calendars/${calId}/events${queryParams}`,
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

export interface GoogleContact {
  name: string
  email: string
}

/** Search/resolve contacts by query using Google People API */
export async function searchContacts(
  accessToken: string,
  query: string
): Promise<GoogleContact[]> {
  const params = new URLSearchParams({
    query,
    readMask: 'names,emailAddresses',
  })
  try {
    const data = await googleFetch<{
      results?: {
        person: {
          names?: { displayName: string }[]
          emailAddresses?: { value: string }[]
        }
      }[]
    }>(
      `https://people.googleapis.com/v1/people:searchContacts?${params}`,
      accessToken
    )
    const contacts: GoogleContact[] = []
    if (data.results) {
      for (const res of data.results) {
        const name = res.person.names?.[0]?.displayName || ''
        const email = res.person.emailAddresses?.[0]?.value || ''
        if (email) {
          contacts.push({ name, email })
        }
      }
    }
    return contacts
  } catch (error) {
    console.error('[google] searchContacts error:', error)
    return []
  }
}

/** Search users in the Workspace Directory (Admin SDK Directory API) */
export async function searchDirectoryUsers(
  accessToken: string,
  query: string
): Promise<GoogleContact[]> {
  const params = new URLSearchParams({
    customer: 'my_customer',
    query,
    viewType: 'domain_public',
  })
  try {
    const data = await googleFetch<{
      users?: {
        primaryEmail: string
        name?: { fullName: string }
      }[]
    }>(
      `https://admin.googleapis.com/admin/directory/v1/users?${params}`,
      accessToken
    )
    const contacts: GoogleContact[] = []
    if (data.users) {
      for (const u of data.users) {
        contacts.push({
          name: u.name?.fullName || '',
          email: u.primaryEmail,
        })
      }
    }
    return contacts
  } catch (error) {
    console.error('[google] searchDirectoryUsers error:', error)
    return []
  }
}

/** Resolve a recipient string (name or email) to an email address */
export async function resolveRecipient(
  accessToken: string,
  recipient: string
): Promise<string> {
  const clean = recipient.trim()
  const EMAIL_RE = /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/
  if (EMAIL_RE.test(clean)) {
    return clean
  }

  // 1. Search personal contacts
  const contacts = await searchContacts(accessToken, clean)
  if (contacts.length > 0) {
    return contacts[0].email
  }

  // 2. Try Workspace Directory
  const dirUsers = await searchDirectoryUsers(accessToken, clean)
  if (dirUsers.length > 0) {
    return dirUsers[0].email
  }

  return recipient
}

/** Create a new Google Document */
export async function createGoogleDoc(
  accessToken: string,
  title: string,
  content: string
): Promise<{ documentId: string; url: string }> {
  const doc = await googleFetch<{ documentId: string }>(
    'https://docs.googleapis.com/v1/documents',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    }
  )

  if (content) {
    await googleFetch<void>(
      `https://docs.googleapis.com/v1/documents/${doc.documentId}:batchUpdate`,
      accessToken,
      {
        method: 'POST',
        body: JSON.stringify({
          requests: [
            {
              insertText: {
                text: content,
                location: { index: 1 },
              },
            },
          ],
        }),
      }
    )
  }

  return {
    documentId: doc.documentId,
    url: `https://docs.google.com/document/d/${doc.documentId}/edit`,
  }
}

/** Create a new Google Sheet */
export async function createGoogleSheet(
  accessToken: string,
  title: string,
  values: string[][]
): Promise<{ spreadsheetId: string; url: string }> {
  const sheet = await googleFetch<{ spreadsheetId: string }>(
    'https://sheets.googleapis.com/v4/spreadsheets',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        properties: { title },
      }),
    }
  )

  if (values && values.length > 0) {
    await googleFetch<void>(
      `https://sheets.googleapis.com/v4/spreadsheets/${sheet.spreadsheetId}/values/Sheet1!A1?valueInputOption=USER_ENTERED`,
      accessToken,
      {
        method: 'PUT',
        body: JSON.stringify({
          range: 'Sheet1!A1',
          majorDimension: 'ROWS',
          values,
        }),
      }
    )
  }

  return {
    spreadsheetId: sheet.spreadsheetId,
    url: `https://docs.google.com/spreadsheets/d/${sheet.spreadsheetId}/edit`,
  }
}

/** Create a new Google Slides presentation */
export async function createGooglePresentation(
  accessToken: string,
  title: string,
  slides: { title: string; content?: string }[]
): Promise<{ presentationId: string; url: string }> {
  const pres = await googleFetch<{ presentationId: string }>(
    'https://slides.googleapis.com/v1/presentations',
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({ title }),
    }
  )

  if (slides && slides.length > 0) {
    const requests: any[] = []
    for (let i = 0; i < slides.length; i++) {
      const slide = slides[i]
      const slideId = `slide_page_${i}`
      
      requests.push({
        createSlide: {
          objectId: slideId,
          slideLayoutReference: {
            predefinedLayout: 'TITLE_AND_BODY',
          },
        },
      })

      const titleId = `title_${i}`
      const bodyId = `body_${i}`
      
      requests.push(
        {
          createShape: {
            objectId: titleId,
            shapeType: 'TEXT_BOX',
            elementProperties: {
              pageObjectId: slideId,
              size: {
                width: { magnitude: 6000000, unit: 'EMU' },
                height: { magnitude: 1000000, unit: 'EMU' },
              },
              transform: {
                scaleX: 1,
                scaleY: 1,
                translateX: 500000,
                translateY: 500000,
                unit: 'EMU',
              },
            },
          },
        },
        {
          insertText: {
            objectId: titleId,
            text: slide.title,
          },
        }
      )

      if (slide.content) {
        requests.push(
          {
            createShape: {
              objectId: bodyId,
              shapeType: 'TEXT_BOX',
              elementProperties: {
                pageObjectId: slideId,
                size: {
                  width: { magnitude: 6000000, unit: 'EMU' },
                  height: { magnitude: 4000000, unit: 'EMU' },
                },
                transform: {
                  scaleX: 1,
                  scaleY: 1,
                  translateX: 500000,
                  translateY: 2000000,
                  unit: 'EMU',
                },
              },
            },
          },
          {
            insertText: {
              objectId: bodyId,
              text: slide.content,
            },
          }
        )
      }
    }

    if (requests.length > 0) {
      await googleFetch<void>(
        `https://slides.googleapis.com/v1/presentations/${pres.presentationId}:batchUpdate`,
        accessToken,
        {
          method: 'POST',
          body: JSON.stringify({ requests }),
        }
      )
    }
  }

  return {
    presentationId: pres.presentationId,
    url: `https://docs.google.com/presentation/d/${pres.presentationId}/edit`,
  }
}
