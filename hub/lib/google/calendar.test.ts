import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildEventPatch, mergeBusyPeriods, updateCalendarEvent, queryFreeBusy } from './calendar'
import { listCalendars } from '@/lib/google'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function stub(payload: unknown) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return new Response(JSON.stringify(payload), { status: 200 })
    }),
  )
  return calls
}

/** Like `stub`, but answers differently per endpoint — needed once a call
 *  fans out to both `calendarList` (discovery) and `freeBusy` (the query). */
function stubByUrl(responses: { when: string; payload: unknown }[]) {
  const calls: { url: string; init?: RequestInit }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const hit = responses.find(r => url.includes(r.when))
      return new Response(JSON.stringify(hit ? hit.payload : {}), { status: 200 })
    }),
  )
  return calls
}

describe('buildEventPatch', () => {
  it('includes ONLY the fields being changed', () => {
    // events.patch merges — restating a full event would blank whatever the
    // caller did not supply (description, attendees, conferencing).
    const body = buildEventPatch({ start: '2026-07-28T16:00:00', end: '2026-07-28T17:00:00' })

    expect(Object.keys(body).sort()).toEqual(['end', 'start'])
    expect(body).not.toHaveProperty('summary')
    expect(body).not.toHaveProperty('attendees')
  })

  it('attaches the timezone to timed events', () => {
    const body = buildEventPatch({ start: '2026-07-28T16:00:00', timeZone: 'America/Chicago' })
    expect(body.start).toEqual({ dateTime: '2026-07-28T16:00:00', timeZone: 'America/Chicago' })
  })

  it('uses date with NO timezone for all-day events', () => {
    // Google rejects date + timeZone together.
    const body = buildEventPatch({ start: '2026-07-28', timeZone: 'America/Chicago' })
    expect(body.start).toEqual({ date: '2026-07-28' })
  })

  it('maps attendee emails to the API shape', () => {
    expect(buildEventPatch({ attendees: ['a@x.com'] }).attendees).toEqual([{ email: 'a@x.com' }])
  })

  it('allows clearing a field explicitly', () => {
    // An empty string is a real value, distinct from "leave it alone".
    expect(buildEventPatch({ description: '' })).toEqual({ description: '' })
  })

  it('produces an empty body for an empty patch', () => {
    expect(buildEventPatch({})).toEqual({})
  })
})

describe('updateCalendarEvent', () => {
  it('PATCHes the event and notifies attendees by default', () => {
    const calls = stub({ id: 'evt-1' })
    return updateCalendarEvent('tok', 'evt-1', { start: '2026-07-28T16:00:00' }).then(() => {
      // A silent reschedule leaves everyone holding the old time.
      expect(calls[0].url).toContain('sendUpdates=all')
      expect(calls[0].url).toContain('/events/evt-1')
      expect(calls[0].init?.method).toBe('PATCH')
    })
  })

  it('honors sendUpdates=none for a quiet correction', async () => {
    const calls = stub({ id: 'evt-1' })
    await updateCalendarEvent('tok', 'evt-1', { description: 'typo fix' }, { sendUpdates: 'none' })
    expect(calls[0].url).toContain('sendUpdates=none')
  })

  it('URL-encodes calendar and event ids', async () => {
    const calls = stub({ id: 'e' })
    await updateCalendarEvent('tok', 'evt/1', { summary: 'x' }, { calendarId: 'a b@group.calendar' })
    expect(calls[0].url).toContain('evt%2F1')
    expect(calls[0].url).toContain('a%20b%40group.calendar')
  })
})

describe('mergeBusyPeriods', () => {
  it('merges overlapping blocks', () => {
    expect(
      mergeBusyPeriods([
        { start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' },
        { start: '2026-07-28T09:30:00Z', end: '2026-07-28T11:00:00Z' },
      ]),
    ).toEqual([{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T11:00:00Z' }])
  })

  it('merges touching blocks so back-to-back meetings are one busy run', () => {
    // Otherwise a zero-length gap looks like availability.
    expect(
      mergeBusyPeriods([
        { start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' },
        { start: '2026-07-28T10:00:00Z', end: '2026-07-28T11:00:00Z' },
      ]),
    ).toHaveLength(1)
  })

  it('keeps genuinely separate blocks apart', () => {
    expect(
      mergeBusyPeriods([
        { start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' },
        { start: '2026-07-28T14:00:00Z', end: '2026-07-28T15:00:00Z' },
      ]),
    ).toHaveLength(2)
  })

  it('sorts unordered input before merging', () => {
    const merged = mergeBusyPeriods([
      { start: '2026-07-28T14:00:00Z', end: '2026-07-28T15:00:00Z' },
      { start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' },
    ])
    expect(merged[0].start).toBe('2026-07-28T09:00:00Z')
  })

  it('handles an empty list', () => {
    expect(mergeBusyPeriods([])).toEqual([])
  })
})

describe('queryFreeBusy', () => {
  it('merges across explicitly-requested calendars', async () => {
    const calls = stub({
      calendars: {
        primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
        work: { busy: [{ start: '2026-07-28T09:30:00Z', end: '2026-07-28T11:00:00Z' }] },
      },
    })

    const result = await queryFreeBusy('tok', {
      timeMin: '2026-07-28T00:00:00Z',
      timeMax: '2026-07-29T00:00:00Z',
      calendarIds: ['primary', 'work'],
    })

    expect(JSON.parse(String(calls[0].init?.body)).items).toEqual([{ id: 'primary' }, { id: 'work' }])
    // The same invite on two calendars is one busy block, not two.
    expect(result.merged).toHaveLength(1)
    expect(Object.keys(result.byCalendar)).toEqual(['primary', 'work'])
    expect(result.checked).toEqual(['primary', 'work'])
  })

  /* T-142: omitted calendarIds used to silently mean "check only `primary`",
     under-reporting busy time on every other calendar the user has switched on
     in the Google Calendar UI. It must instead discover and query the user's
     selected set. */
  it('discovers and queries the user-selected calendar set when calendarIds is omitted', async () => {
    const calls = stubByUrl([
      {
        when: 'calendarList',
        payload: {
          items: [
            { id: 'primary', summary: 'Danny', primary: true },
            { id: 'work@group.calendar.google.com', summary: 'Work', selected: true },
            { id: 'unselected@group.calendar.google.com', summary: 'Old project', selected: false },
          ],
        },
      },
      {
        when: 'freeBusy',
        payload: {
          calendars: {
            primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
            'work@group.calendar.google.com': { busy: [] },
          },
        },
      },
    ])

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    const freeBusyCall = calls.find(c => c.url.includes('freeBusy'))
    expect(JSON.parse(String(freeBusyCall?.init?.body)).items).toEqual([
      { id: 'primary' },
      { id: 'work@group.calendar.google.com' },
    ])
    // Never the unselected calendar — the user turned it off in their UI.
    expect(result.checked).not.toContain('unselected@group.calendar.google.com')
    expect(result.checked).toEqual(['primary', 'work@group.calendar.google.com'])
  })

  it('falls back to primary when the user has no selected calendars at all', async () => {
    const calls = stubByUrl([
      { when: 'calendarList', payload: { items: [{ id: 'primary', summary: 'Danny' }] } },
      { when: 'freeBusy', payload: { calendars: {} } },
    ])

    await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    const freeBusyCall = calls.find(c => c.url.includes('freeBusy'))
    expect(JSON.parse(String(freeBusyCall?.init?.body)).items).toEqual([{ id: 'primary' }])
  })

  it('caps the auto-discovered selected-calendar set rather than querying an unbounded list', async () => {
    const manySelected = Array.from({ length: 40 }, (_, i) => ({
      id: `cal-${i}`, summary: `Cal ${i}`, selected: true,
    }))
    const calls = stubByUrl([
      { when: 'calendarList', payload: { items: manySelected } },
      { when: 'freeBusy', payload: { calendars: {} } },
    ])

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    const freeBusyCall = calls.find(c => c.url.includes('freeBusy'))
    const requested = JSON.parse(String(freeBusyCall?.init?.body)).items as { id: string }[]
    // Exactly the first 10 selected calendars — a regression to any other
    // number (e.g. 39) must fail this, not just "fewer than 40".
    expect(requested).toEqual(Array.from({ length: 10 }, (_, i) => ({ id: `cal-${i}` })))
    expect(requested.some(r => r.id === 'cal-10')).toBe(false)
    expect(result.checked).toEqual(Array.from({ length: 10 }, (_, i) => `cal-${i}`))
  })

  /* T-142 P2: CalendarList order is arrival order, not significance order. A
     user with a dozen selected calendars listed ahead of their own primary got
     a `checked` set with NO primary at all — so "am I free at 3?" answered from
     everything EXCEPT the calendar that matters most, and reported free over a
     booked primary. Primary must survive the cap. */
  it('retains primary inside the cap even when more than ten selected calendars precede it', async () => {
    const items = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: `cal-${i}`, summary: `Cal ${i}`, selected: true })),
      { id: 'me@x.test', summary: 'Danny', primary: true, selected: true },
    ]
    const calls = stubByUrl([
      { when: 'calendarList', payload: { items } },
      { when: 'freeBusy', payload: { calendars: {} } },
    ])

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    const freeBusyCall = calls.find(c => c.url.includes('freeBusy'))
    const requested = (JSON.parse(String(freeBusyCall?.init?.body)).items as { id: string }[]).map(r => r.id)
    // Bounded exactly, unique, and primary first — never dropped by the slice.
    expect(requested).toHaveLength(10)
    expect(new Set(requested).size).toBe(10)
    expect(requested[0]).toBe('me@x.test')
    expect(result.checked).toContain('me@x.test')
    expect(result.checked).toHaveLength(10)
  })

  it('de-duplicates a calendar repeated across CalendarList pages before applying the cap', async () => {
    const calls = stubByUrl([
      {
        when: 'calendarList',
        payload: {
          items: [
            { id: 'work@x.test', summary: 'Work', selected: true },
            { id: 'work@x.test', summary: 'Work', selected: true },
            { id: 'ops@x.test', summary: 'Ops', selected: true },
          ],
        },
      },
      { when: 'freeBusy', payload: { calendars: {} } },
    ])

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    const freeBusyCall = calls.find(c => c.url.includes('freeBusy'))
    expect(JSON.parse(String(freeBusyCall?.init?.body)).items).toEqual([
      { id: 'work@x.test' },
      { id: 'ops@x.test' },
    ])
    expect(result.checked).toEqual(['work@x.test', 'ops@x.test'])
  })

  it('discovers a primary calendar that appears only on a later CalendarList page', async () => {
    const calls: { url: string; init?: RequestInit }[] = []
    let listPage = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, init })
        if (url.includes('calendarList')) {
          listPage += 1
          const payload =
            listPage === 1
              ? { items: [{ id: 'work@x.test', summary: 'Work', selected: true }], nextPageToken: 'pg2' }
              : { items: [{ id: 'me@x.test', summary: 'Danny', primary: true }] }
          return new Response(JSON.stringify(payload), { status: 200 })
        }
        return new Response(JSON.stringify({ calendars: {} }), { status: 200 })
      }),
    )

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    // Page one alone would have answered availability without primary at all.
    expect(listPage).toBe(2)
    expect(result.checked).toEqual(['me@x.test', 'work@x.test'])
  })

  it('truncates to the API cap of 50 calendars rather than failing', async () => {
    const calls = stub({ calendars: {} })
    await queryFreeBusy('tok', {
      timeMin: 'a',
      timeMax: 'b',
      calendarIds: Array.from({ length: 60 }, (_, i) => `cal-${i}`),
    })
    expect(JSON.parse(String(calls[0].init?.body)).items).toHaveLength(50)
  })

  it('handles a response with no calendars', async () => {
    stub({})
    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })
    expect(result.merged).toEqual([])
    expect(result.errors).toEqual([])
  })

  /* T-70 fix #8. freeBusy reports per-calendar failures INSIDE a 200 response,
     with `busy` absent. Dropping those errors made an unreadable calendar
     indistinguishable from an empty one, so the availability answer said FREE
     over a calendar that might be fully booked. */
  it('reports an errored calendar as unreadable — never as free', async () => {
    stub({
      calendars: {
        primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
        'team@x.test': { errors: [{ domain: 'global', reason: 'notFound' }] },
      },
    })

    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })

    expect(result.errors).toEqual([{ calendarId: 'team@x.test', reason: 'notFound' }])
    // Crucially NOT present as an empty array — no caller can read `[]` here
    // as "nothing scheduled".
    expect(result.byCalendar).not.toHaveProperty('team@x.test')
    expect(result.merged).toHaveLength(1)
  })

  it('falls back to the error domain when Google sends no reason', async () => {
    stub({ calendars: { work: { errors: [{ domain: 'calendar' }] } } })
    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })
    expect(result.errors).toEqual([{ calendarId: 'work', reason: 'calendar' }])
  })

  it('reports every error a calendar returns', async () => {
    stub({
      calendars: {
        a: { errors: [{ reason: 'forbidden' }, { reason: 'rateLimitExceeded' }] },
      },
    })
    const result = await queryFreeBusy('tok', { timeMin: 'a', timeMax: 'b' })
    expect(result.errors).toHaveLength(2)
  })
})

/* T-142 P2: CalendarList is paginated (100 entries per page by default). Reading
   only the first page silently hid every calendar past it — including, for a
   heavy account, the primary calendar — and there is no worse answer to "when am
   I free?" than one computed from a calendar set the user cannot see was cut. */
describe('listCalendars pagination', () => {
  /** Answers each successive fetch with the next page; repeats the last. */
  function stubPages(pages: unknown[]) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const payload = pages[Math.min(calls.length, pages.length - 1)]
        calls.push(url)
        return new Response(JSON.stringify(payload), { status: 200 })
      }),
    )
    return calls
  }

  it('asks for an explicit high maxResults and sends no pageToken on the first page', async () => {
    const calls = stubPages([{ items: [{ id: 'a', summary: 'A' }] }])

    await listCalendars('tok')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('maxResults=250')
    expect(calls[0]).not.toContain('pageToken')
  })

  it('follows a non-empty nextPageToken with URL encoding and aggregates the pages', async () => {
    const token = 'tok/2+page=next'
    const calls = stubPages([
      { items: [{ id: 'a', summary: 'A' }], nextPageToken: token },
      { items: [{ id: 'b', summary: 'B' }] },
    ])

    const cals = await listCalendars('tok')

    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain(`pageToken=${encodeURIComponent(token)}`)
    // The raw token would break the query string it is spliced into.
    expect(calls[1]).not.toContain(token)
    expect(cals.map(c => c.id)).toEqual(['a', 'b'])
  })

  it('stops at an empty-string nextPageToken instead of requesting another page', async () => {
    const calls = stubPages([{ items: [{ id: 'a', summary: 'A' }], nextPageToken: '' }])

    const cals = await listCalendars('tok')

    expect(calls).toHaveLength(1)
    expect(cals.map(c => c.id)).toEqual(['a'])
  })

  it('throws rather than returning a partial list when the token repeats', async () => {
    // A token that hands back itself is an infinite loop, not a long list.
    stubPages([{ items: [{ id: 'a', summary: 'A' }], nextPageToken: 'same' }])

    await expect(listCalendars('tok')).rejects.toThrow(/partial/i)
  })

  it('throws at the finite page cap rather than silently truncating discovery', async () => {
    let n = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        n += 1
        // Every page advertises a fresh token — unbounded traversal if unguarded.
        return new Response(
          JSON.stringify({ items: [{ id: `c${n}`, summary: 'x' }], nextPageToken: `t${n}` }),
          { status: 200 },
        )
      }),
    )

    await expect(listCalendars('tok')).rejects.toThrow(/partial/i)
    // Bounded: it gave up at the named cap, it did not keep walking.
    expect(n).toBe(20)
  })
})
