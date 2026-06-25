import { describe, it, expect, vi, afterEach } from 'vitest'
import { createCalendarEvent } from './google'

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
