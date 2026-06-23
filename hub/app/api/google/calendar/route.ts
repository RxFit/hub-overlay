import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { resolveGoogleAuth, googleApiErrorResponse } from '@/lib/google-session'
import { authOptions } from '@/lib/auth'
import { listUpcomingEvents, createCalendarEvent, deleteCalendarEvent, listCalendars, GoogleCalendarEvent } from '@/lib/google'

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
    const displayMax = maxResults ? parseInt(maxResults, 10) : 100
    // Fetch generously per-calendar so we don't miss events after sorting
    const perCalMax = 50
    let events: GoogleCalendarEvent[] = []

    if (calendarId) {
      events = await listUpcomingEvents(accessToken, { maxResults: perCalMax, calendarId })
    } else {
      const cals = await listCalendars(accessToken)
      // Only fetch from selected/primary calendars
      const selectedCals = cals.filter(c => c.selected || c.primary)

      const allEvents = await Promise.all(
        selectedCals.map(cal =>
          listUpcomingEvents(accessToken, { maxResults: perCalMax, calendarId: cal.id }).catch(() => [])
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
    return googleApiErrorResponse(error)
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

  let body: {
    summary: string
    description?: string
    start: string
    end: string
    attendees?: string[]
    calendarId?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  if (!body.summary || !body.start || !body.end) {
    return NextResponse.json(
      { error: 'summary, start, and end are required' },
      { status: 400 }
    )
  }

  try {
    const event = await createCalendarEvent(accessToken, body)
    return NextResponse.json({ event })
  } catch (error) {
    return googleApiErrorResponse(error)
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
    return googleApiErrorResponse(error)
  }
}
