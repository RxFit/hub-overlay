import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { resolveGoogleAuth, googleApiErrorResponse, googleRouteCtx } from '@/lib/google-session'
import { clampInt } from '@/lib/num'
import { GoogleCalendarCreateSchema } from '@/lib/zod-schemas'
import { authOptions } from '@/lib/auth'
import { listUpcomingEvents, createCalendarEvent, deleteCalendarEvent, listCalendars, GoogleCalendarEvent } from '@/lib/google'
import { updateCalendarEvent } from '@/lib/google/calendar'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  const { searchParams } = new URL(req.url)
  const maxResults = searchParams.get('maxResults')
  const calendarId = searchParams.get('calendarId') ?? undefined

  try {
    // How many events to show in the final list (caller-controlled, default 100)
    const displayMax = clampInt(maxResults, 100, 1, 100)
    // Fetch generously per-calendar so we don't miss events after sorting
    const perCalMax = 50
    let events: GoogleCalendarEvent[] = []

    if (calendarId) {
      // Tag each event with its source calendar so the client can delete it
      // from the right calendar (events.list omits this).
      events = (await listUpcomingEvents(accessToken, { maxResults: perCalMax, calendarId }))
        .map(e => ({ ...e, calendarId }))
    } else {
      const cals = await listCalendars(accessToken)
      // Only fetch from selected/primary calendars
      const selectedCals = cals.filter(c => c.selected || c.primary)

      const allEvents = await Promise.all(
        selectedCals.map(cal =>
          listUpcomingEvents(accessToken, { maxResults: perCalMax, calendarId: cal.id })
            .then(evs => evs.map(e => ({ ...e, calendarId: cal.id })))
            .catch(() => [])
        )
      )

      events = allEvents.flat()
      // Sort merged events by start time
      events.sort((a, b) => {
        const aTime = new Date(a.start.dateTime || a.start.date || 0).getTime()
        const bTime = new Date(b.start.dateTime || b.start.date || 0).getTime()
        return aTime - bTime
      })
      // Cap to displayMax to avoid excessive payload
      if (events.length > displayMax) {
        events = events.slice(0, displayMax)
      }
    }
    return NextResponse.json({ events })
  } catch (error) {
    return googleApiErrorResponse(error, googleRouteCtx(req, '/api/google/calendar'))
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = GoogleCalendarCreateSchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Validation failed', details: parsed.error.issues },
      { status: 400 }
    )
  }
  const body = parsed.data

  try {
    const event = await createCalendarEvent(accessToken, body)
    return NextResponse.json({ event })
  } catch (error) {
    return googleApiErrorResponse(error, googleRouteCtx(req, '/api/google/calendar'))
  }
}

/**
 * PATCH /api/google/calendar — update an existing event in place.
 *
 * Previously only create and delete existed, so "move my 3pm to 4pm" had no
 * path: the closest available behavior was delete-and-recreate, which loses the
 * event id, drops attendee RSVPs, and re-notifies everyone as though it were a
 * brand-new meeting.
 *
 * Fields omitted from the body keep their current values (events.patch merges),
 * so a reschedule preserves the title, description, attendees and any Meet
 * link. Attendees are notified by default — a silent reschedule leaves everyone
 * holding the old time.
 */
export async function PATCH(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response

  let body: {
    eventId?: string
    calendarId?: string
    sendUpdates?: 'all' | 'externalOnly' | 'none'
    summary?: string
    description?: string
    location?: string
    start?: string
    end?: string
    timeZone?: string
    attendees?: string[]
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const eventId = (body.eventId || '').trim()
  if (!eventId) {
    return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  }

  const { eventId: _id, calendarId, sendUpdates, ...patch } = body
  if (!Object.keys(patch).length) {
    return NextResponse.json({ error: 'No fields to update' }, { status: 400 })
  }

  try {
    const event = await updateCalendarEvent(auth.accessToken, eventId, patch, {
      calendarId,
      sendUpdates,
    })
    return NextResponse.json({ event })
  } catch (error) {
    return googleApiErrorResponse(error, googleRouteCtx(req, '/api/google/calendar'))
  }
}

export async function DELETE(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const auth = await resolveGoogleAuth(req)
  if (!auth.ok) return auth.response
  const accessToken = auth.accessToken

  let body: { eventId: string; calendarId?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.eventId) {
    return NextResponse.json({ error: 'eventId is required' }, { status: 400 })
  }

  try {
    await deleteCalendarEvent(accessToken, body.eventId, body.calendarId)
    return NextResponse.json({ success: true })
  } catch (error) {
    return googleApiErrorResponse(error, googleRouteCtx(req, '/api/google/calendar'))
  }
}
