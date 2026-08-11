import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCalendarEvent, listRecentGmailThreads, GMAIL_TRIAGE_HEADERS, type GmailThread } from './google'

/* ════════════════════════════════════════════════════════════════════════════
   createCalendarEvent body construction (audit C-P0-1 / C-P0-2)
   Stub the fetch layer and capture the JSON POSTed to Google. The body must:
   - carry start.dateTime + start.timeZone for timed events,
   - carry a top-level location when supplied,
   - use start.date with NO timeZone for all-day events,
   - omit location when not provided.
   ════════════════════════════════════════════════════════════════════════════ */

function stubFetch() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ id: 'evt-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  )
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function capturedBody(fetchMock: ReturnType<typeof stubFetch>) {
  const init = (fetchMock.mock.calls[0] as unknown[])[1] as RequestInit
  return JSON.parse(init.body as string)
}

describe('createCalendarEvent body construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('attaches timeZone to timed start/end and copies location to the top level', async () => {
    const fetchMock = stubFetch()
    await createCalendarEvent('token', {
      summary: 'Client sync',
      start: '2026-06-24T09:00:00',
      end: '2026-06-24T10:00:00',
      location: '123 Congress Ave, Austin',
      timeZone: 'America/Chicago',
    })

    const body = capturedBody(fetchMock)
    expect(body.start).toMatchObject({ dateTime: '2026-06-24T09:00:00', timeZone: 'America/Chicago' })
    expect(body.end).toMatchObject({ dateTime: '2026-06-24T10:00:00', timeZone: 'America/Chicago' })
    expect(body.start.date).toBeUndefined()
    expect(body.location).toBe('123 Congress Ave, Austin')
  })

  it('uses start.date with NO timeZone for all-day events', async () => {
    const fetchMock = stubFetch()
    await createCalendarEvent('token', {
      summary: 'All-day offsite',
      start: '2026-06-24',
      end: '2026-06-25',
      timeZone: 'America/Chicago',
    })

    const body = capturedBody(fetchMock)
    expect(body.start).toEqual({ date: '2026-06-24' })
    expect(body.end).toEqual({ date: '2026-06-25' })
    expect(body.start.timeZone).toBeUndefined()
    expect(body.end.timeZone).toBeUndefined()
  })

  it('omits location when not provided', async () => {
    const fetchMock = stubFetch()
    await createCalendarEvent('token', {
      summary: 'No-location event',
      start: '2026-06-24T09:00:00',
      end: '2026-06-24T10:00:00',
      timeZone: 'America/Chicago',
    })

    const body = capturedBody(fetchMock)
    expect('location' in body).toBe(false)
  })

  it('omits timeZone on a timed event when none is supplied (backward compatible)', async () => {
    const fetchMock = stubFetch()
    await createCalendarEvent('token', {
      summary: 'Zoneless timed',
      start: '2026-06-24T09:00:00',
      end: '2026-06-24T10:00:00',
    })

    const body = capturedBody(fetchMock)
    expect(body.start).toEqual({ dateTime: '2026-06-24T09:00:00' })
    expect(body.start.timeZone).toBeUndefined()
  })
})

/* ════════════════════════════════════════════════════════════════════════════
   listRecentGmailThreads (Plan 8 / F2)
   Stub fetch and answer the inbox list + per-thread metadata calls. Must:
   - parse From/Subject/Date headers into a flat summary,
   - derive isUnread from the LAST message's labelIds and snippet from the FIRST,
   - request INBOX threads with metadata headers,
   - throw the module's standard error on a non-OK response.
   ════════════════════════════════════════════════════════════════════════════ */

function jsonRes(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function gmailHeaders(subject: string, from: string, date: string) {
  return [
    { name: 'Subject', value: subject },
    { name: 'From', value: from },
    { name: 'Date', value: date },
  ]
}

function stubGmailFetch(
  list: unknown,
  threads: Record<string, GmailThread | { status: number }>,
) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url)
    if (u.includes('/threads?')) {
      return typeof list === 'object' && list !== null && 'status' in (list as object)
        ? jsonRes({ error: 'denied' }, (list as { status: number }).status)
        : jsonRes(list)
    }
    const id = u.match(/\/threads\/([^?]+)/)?.[1] ?? ''
    const t = threads[id]
    if (t && 'status' in t && typeof t.status === 'number' && !('id' in t)) {
      return jsonRes({ error: 'boom' }, t.status)
    }
    return jsonRes(t)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('listRecentGmailThreads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('parses thread metadata into { id, from, subject, date, snippet, isUnread }', async () => {
    stubGmailFetch(
      { threads: [{ id: 't1' }, { id: 't2' }] },
      {
        t1: {
          id: 't1',
          messages: [
            {
              id: 'm1', threadId: 't1', snippet: 'first message snippet',
              labelIds: ['INBOX'],
              payload: { headers: gmailHeaders('Old subject', 'a@x.com', 'Thu, 02 Jul 2026 09:00:00 -0500') },
            },
            {
              id: 'm2', threadId: 't1', snippet: 'latest reply snippet',
              labelIds: ['INBOX', 'UNREAD'],
              payload: { headers: gmailHeaders('Re: Old subject', 'Bob <b@x.com>', 'Fri, 03 Jul 2026 10:00:00 -0500') },
            },
          ],
        },
        t2: {
          id: 't2',
          messages: [
            {
              id: 'm3', threadId: 't2', snippet: 'read one',
              labelIds: ['INBOX'],
              payload: { headers: gmailHeaders('Invoice', 'billing@x.com', 'Wed, 01 Jul 2026 08:00:00 -0500') },
            },
          ],
        },
      },
    )

    const threads = await listRecentGmailThreads('token', { maxResults: 2 })
    expect(threads).toHaveLength(2)
    // Headers + unread flag AND snippet all come from the LAST message, so a
    // multi-message thread previews its latest reply (matching Gmail's list).
    expect(threads[0]).toMatchObject({
      id: 't1',
      subject: 'Re: Old subject',
      from: 'Bob <b@x.com>',
      date: 'Fri, 03 Jul 2026 10:00:00 -0500',
      snippet: 'latest reply snippet',
      isUnread: true,
      messageCount: 2,
    })
    expect(threads[1]).toMatchObject({ id: 't2', subject: 'Invoice', isUnread: false })
  })

  it('requests INBOX threads then per-thread metadata with every triage header', async () => {
    const fetchMock = stubGmailFetch({ threads: [{ id: 't1' }] }, {
      t1: {
        id: 't1',
        messages: [{ id: 'm1', threadId: 't1', labelIds: [], payload: { headers: gmailHeaders('S', 'f@x.com', 'D') } }],
      },
    })

    await listRecentGmailThreads('token', { maxResults: 7 })
    const urls = fetchMock.mock.calls.map(c => String(c[0]))
    expect(urls[0]).toContain('/threads?labelIds=INBOX&maxResults=7')
    expect(urls[1]).toContain('/threads/t1?format=metadata')
    // Gmail bills quota per METHOD, not per header, so the full triage set is
    // free. Asking for only From/Subject/Date is what left the ranker unable to
    // tell a mailing list from a person.
    for (const h of GMAIL_TRIAGE_HEADERS) {
      expect(urls[1]).toContain(`metadataHeaders=${encodeURIComponent(h)}`)
    }
    expect(urls[1]).toContain('metadataHeaders=List-Unsubscribe')
  })

  it('preserves labelIds — Gmail\'s own CATEGORY_* and IMPORTANT verdicts', async () => {
    stubGmailFetch({ threads: [{ id: 't1' }] }, {
      t1: {
        id: 't1',
        messages: [{
          id: 'm1', threadId: 't1',
          labelIds: ['INBOX', 'UNREAD', 'CATEGORY_PROMOTIONS', 'IMPORTANT'],
          internalDate: '1786400000000',
          payload: { headers: gmailHeaders('S', 'f@x.com', 'D') },
        }],
      },
    })
    const [t] = await listRecentGmailThreads('token')
    expect(t.labelIds).toContain('CATEGORY_PROMOTIONS')
    expect(t.labelIds).toContain('IMPORTANT')
    expect(t.receivedAt).toBe(1786400000000)
  })

  it('detects reciprocity from ANY message in the thread, not just the last', async () => {
    stubGmailFetch({ threads: [{ id: 't1' }] }, {
      t1: {
        id: 't1',
        messages: [
          // The user replied FIRST, then the sender wrote back — so the last
          // message carries no SENT label and a last-message-only scan misses it.
          { id: 'm1', threadId: 't1', labelIds: ['SENT'], payload: { headers: gmailHeaders('S', 'me@x.com', 'D') } },
          { id: 'm2', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], payload: { headers: gmailHeaders('Re: S', 'them@y.com', 'D') } },
        ],
      },
    })
    const [t] = await listRecentGmailThreads('token')
    expect(t.userReplied).toBe(true)
    expect(t.threadLabelIds).toContain('SENT')
  })

  it('resolves addressing relative to the user, case-insensitively', async () => {
    stubGmailFetch({ threads: [{ id: 'solo' }, { id: 'blast' }, { id: 'cc' }] }, {
      solo: {
        id: 'solo',
        messages: [{ id: 'm', threadId: 'solo', labelIds: ['INBOX'], payload: { headers: [
          ...gmailHeaders('S', 'a@x.com', 'D'),
          { name: 'To', value: 'Danny@RxFitATX.com' },
        ] } }],
      },
      blast: {
        id: 'blast',
        messages: [{ id: 'm', threadId: 'blast', labelIds: ['INBOX'], payload: { headers: [
          ...gmailHeaders('S', 'a@x.com', 'D'),
          { name: 'To', value: 'undisclosed-recipients:;' },
        ] } }],
      },
      cc: {
        id: 'cc',
        messages: [{ id: 'm', threadId: 'cc', labelIds: ['INBOX'], payload: { headers: [
          ...gmailHeaders('S', 'a@x.com', 'D'),
          { name: 'To', value: '"Team, Ops" <ops@y.com>' },
          { name: 'Cc', value: 'danny@rxfitatx.com, other@z.com' },
        ] } }],
      },
    })
    const threads = await listRecentGmailThreads('token', { userEmail: 'danny@rxfitatx.com' })
    const by = Object.fromEntries(threads.map(t => [t.id, t]))
    expect(by.solo.addressedDirectly).toBe(true)
    expect(by.solo.recipientCount).toBe(1)
    expect(by.blast.undisclosedRecipients).toBe(true)
    expect(by.blast.addressedDirectly).toBe(false)
    // A quoted display name containing a comma must not inflate the count.
    expect(by.cc.ccOnly).toBe(true)
    expect(by.cc.recipientCount).toBe(3)
  })

  it('returns [] for an empty inbox and drops threads whose metadata fetch fails', async () => {
    stubGmailFetch({ threads: [] }, {})
    expect(await listRecentGmailThreads('token')).toEqual([])

    vi.unstubAllGlobals()
    stubGmailFetch({ threads: [{ id: 'ok' }, { id: 'bad' }] }, {
      ok: {
        id: 'ok',
        messages: [{ id: 'm1', threadId: 'ok', labelIds: [], payload: { headers: gmailHeaders('S', 'f@x.com', 'D') } }],
      },
      bad: { status: 500 },
    })
    const threads = await listRecentGmailThreads('token')
    expect(threads).toHaveLength(1)
    expect(threads[0].id).toBe('ok')
  })

  it('throws the standard Google API error when the list call is not OK', async () => {
    stubGmailFetch({ status: 403 }, {})
    await expect(listRecentGmailThreads('token')).rejects.toThrow(/Google API error 403/)
  })
})
