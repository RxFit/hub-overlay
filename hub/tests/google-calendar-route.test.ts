import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

/* ════════════════════════════════════════════════════════════════════════════
   /api/google/calendar — route-owned logic (NS-11).

   Mocking boundary: next-auth session/JWT + `lib/google` (Calendar adapter).
   Real route logic under test: multi-calendar fan-out limited to
   selected/primary calendars, per-calendar failure resilience, source-calendar
   tagging (so the client deletes from the RIGHT calendar), merged time-sort,
   display cap, zod validation, and error mapping.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    token: null as unknown,
    listCalendars: vi.fn(),
    listUpcomingEvents: vi.fn(),
    createCalendarEvent: vi.fn(),
    deleteCalendarEvent: vi.fn(),
    resolveRecipient: vi.fn(async (token: string, r: string) => r),
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('next-auth/jwt', () => ({ getToken: vi.fn(async () => state.token) }))
vi.mock('@/lib/google', () => ({
  listCalendars: (...a: unknown[]) => state.listCalendars(...a),
  listUpcomingEvents: (...a: unknown[]) => state.listUpcomingEvents(...a),
  createCalendarEvent: (...a: unknown[]) => state.createCalendarEvent(...a),
  deleteCalendarEvent: (...a: unknown[]) => state.deleteCalendarEvent(...a),
  resolveRecipient: (...a: unknown[]) => state.resolveRecipient(...a),
}))

import { GET, POST, DELETE } from '@/app/api/google/calendar/route'

function getReq(qs = '') {
  return new NextRequest(`http://localhost/api/google/calendar${qs}`)
}
function bodyReq(method: 'POST' | 'DELETE', body: unknown) {
  return new NextRequest('http://localhost/api/google/calendar', {
    method,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  })
}
const ev = (id: string, dateTime: string) => ({ id, summary: id, start: { dateTime } })

beforeEach(() => {
  state.session = { user: { email: 'danny@rxfitatx.com' } }
  state.token = { accessToken: 'goog-token' }
  state.listCalendars.mockReset()
  state.listUpcomingEvents.mockReset()
  state.createCalendarEvent.mockReset()
  state.deleteCalendarEvent.mockReset()
})

describe('GET /api/google/calendar', () => {
  it('401s without a session, and 401s { reauth: true } on a dead Google token', async () => {
    state.session = null
    expect((await GET(getReq())).status).toBe(401)

    state.session = { user: { email: 'danny@rxfitatx.com' } }
    state.token = null
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })

  it('fetches a single calendar when ?calendarId= is given and tags each event with it', async () => {
    state.listUpcomingEvents.mockResolvedValue([ev('e1', '2026-07-09T10:00:00Z')])
    const res = await GET(getReq('?calendarId=work@group.calendar.google.com'))
    expect(res.status).toBe(200)
    const { events } = await res.json()
    expect(events[0].calendarId).toBe('work@group.calendar.google.com')
    expect(state.listCalendars).not.toHaveBeenCalled()
    expect(state.listUpcomingEvents).toHaveBeenCalledWith('goog-token', {
      maxResults: 50,
      calendarId: 'work@group.calendar.google.com',
    })
  })

  it('fans out ONLY to selected/primary calendars, merges + sorts by start time, tags sources, and survives one calendar failing', async () => {
    state.listCalendars.mockResolvedValue([
      { id: 'primary-cal', primary: true },
      { id: 'selected-cal', selected: true },
      { id: 'broken-cal', selected: true },
      { id: 'ignored-cal', selected: false }, // must never be fetched
    ])
    state.listUpcomingEvents.mockImplementation(async (_t: string, opts: { calendarId: string }) => {
      if (opts.calendarId === 'primary-cal') return [ev('late', '2026-07-10T10:00:00Z')]
      if (opts.calendarId === 'selected-cal') return [ev('early', '2026-07-08T08:00:00Z')]
      throw new Error('Google API error 500: this calendar is broken')
    })
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    const { events } = await res.json()
    // broken-cal degraded to [], ignored-cal never queried, order is time-asc
    expect(events.map((e: { id: string }) => e.id)).toEqual(['early', 'late'])
    expect(events[0].calendarId).toBe('selected-cal')
    expect(events[1].calendarId).toBe('primary-cal')
    const queried = state.listUpcomingEvents.mock.calls.map(c => (c[1] as { calendarId: string }).calendarId)
    expect(queried.sort()).toEqual(['broken-cal', 'primary-cal', 'selected-cal'])
  })

  it('caps the merged list to the clamped ?maxResults=', async () => {
    state.listCalendars.mockResolvedValue([{ id: 'c1', primary: true }])
    state.listUpcomingEvents.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ev(`e${i}`, `2026-07-0${(i % 9) + 1}T10:00:00Z`))
    )
    const res = await GET(getReq('?maxResults=3'))
    const { events } = await res.json()
    expect(events).toHaveLength(3)
  })

  it('maps an upstream auth error on the calendar list to 401 { reauth: true }', async () => {
    state.listCalendars.mockRejectedValue(new Error('Google API error 401: invalid credentials'))
    const res = await GET(getReq())
    expect(res.status).toBe(401)
    expect((await res.json()).reauth).toBe(true)
  })
})

describe('POST /api/google/calendar', () => {
  it('400s invalid JSON and zod violations (missing summary; bad attendee email)', async () => {
    expect((await POST(bodyReq('POST', '{nope'))).status).toBe(400)

    const noSummary = await POST(bodyReq('POST', { start: 'a', end: 'b' }))
    expect(noSummary.status).toBe(400)
    expect((await noSummary.json()).error).toBe('Validation failed')

    const badAttendee = await POST(bodyReq('POST', {
      summary: 's', start: '2026-07-09T10:00:00Z', end: '2026-07-09T11:00:00Z',
      attendees: ['not-an-email'],
    }))
    expect(badAttendee.status).toBe(400)
    expect(state.createCalendarEvent).not.toHaveBeenCalled()
  })

  it('creates an event from a valid payload and returns it', async () => {
    state.createCalendarEvent.mockResolvedValue({ id: 'ev-1' })
    const body = {
      summary: 'Standup',
      start: '2026-07-09T10:00:00Z',
      end: '2026-07-09T10:15:00Z',
      attendees: ['ops@rxfitatx.com'],
      timeZone: 'America/Chicago',
    }
    const res = await POST(bodyReq('POST', body))
    expect(res.status).toBe(200)
    expect((await res.json()).event.id).toBe('ev-1')
    expect(state.createCalendarEvent).toHaveBeenCalledWith('goog-token', body)
  })

  it('maps an upstream failure on create (500 → 502)', async () => {
    state.createCalendarEvent.mockRejectedValue(new Error('Google API error 500: nope'))
    const res = await POST(bodyReq('POST', {
      summary: 's', start: '2026-07-09T10:00:00Z', end: '2026-07-09T11:00:00Z',
    }))
    expect(res.status).toBe(502)
  })
})

describe('DELETE /api/google/calendar', () => {
  it('400s invalid JSON and a missing eventId', async () => {
    expect((await DELETE(bodyReq('DELETE', '{nope'))).status).toBe(400)
    const res = await DELETE(bodyReq('DELETE', { calendarId: 'c1' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('eventId is required')
  })

  it('deletes from the specified source calendar', async () => {
    state.deleteCalendarEvent.mockResolvedValue(undefined)
    const res = await DELETE(bodyReq('DELETE', { eventId: 'ev-1', calendarId: 'selected-cal' }))
    expect(res.status).toBe(200)
    expect((await res.json()).success).toBe(true)
    expect(state.deleteCalendarEvent).toHaveBeenCalledWith('goog-token', 'ev-1', 'selected-cal')
  })

  it('maps a 404 from Google straight through (its own 4xx)', async () => {
    state.deleteCalendarEvent.mockRejectedValue(new Error('Google API error 404: gone'))
    const res = await DELETE(bodyReq('DELETE', { eventId: 'ev-x' }))
    expect(res.status).toBe(404)
  })
})
