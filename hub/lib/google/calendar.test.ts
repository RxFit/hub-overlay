import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildEventPatch, mergeBusyPeriods, updateCalendarEvent, queryFreeBusy } from './calendar'

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
  it('defaults to the primary calendar and merges across calendars', async () => {
    const calls = stub({
      calendars: {
        primary: { busy: [{ start: '2026-07-28T09:00:00Z', end: '2026-07-28T10:00:00Z' }] },
        work: { busy: [{ start: '2026-07-28T09:30:00Z', end: '2026-07-28T11:00:00Z' }] },
      },
    })

    const result = await queryFreeBusy('tok', {
      timeMin: '2026-07-28T00:00:00Z',
      timeMax: '2026-07-29T00:00:00Z',
    })

    expect(JSON.parse(String(calls[0].init?.body)).items).toEqual([{ id: 'primary' }])
    // The same invite on two calendars is one busy block, not two.
    expect(result.merged).toHaveLength(1)
    expect(Object.keys(result.byCalendar)).toEqual(['primary', 'work'])
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
