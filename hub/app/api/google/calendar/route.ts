import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { getToken } from 'next-auth/jwt'
import { authOptions } from '@/lib/auth'
import { listUpcomingEvents, createCalendarEvent, listCalendars, GoogleCalendarEvent } from '@/lib/google'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

  const { searchParams } = new URL(req.url)
  const maxResults = searchParams.get('maxResults')
  const calendarId = searchParams.get('calendarId') ?? undefined

  try {
    const maxResNum = maxResults ? parseInt(maxResults, 10) : 10
    let events: GoogleCalendarEvent[] = []

    if (calendarId) {
      events = await listUpcomingEvents(accessToken, { maxResults: maxResNum, calendarId })
    } else {
      const cals = await listCalendars(accessToken)
      // Only fetch from selected calendars to avoid overwhelming API / returning too much
      const selectedCals = cals.filter(c => c.selected || c.primary)
      
      const allEvents = await Promise.all(
        selectedCals.map(cal => 
          listUpcomingEvents(accessToken, { maxResults: maxResNum, calendarId: cal.id }).catch(() => [])
        )
      )
      
      events = allEvents.flat()
      // Sort by start time
      events.sort((a, b) => {
        const aTime = new Date(a.start.dateTime || a.start.date || 0).getTime()
        const bTime = new Date(b.start.dateTime || b.start.date || 0).getTime()
        return aTime - bTime
      })
      // Slice to maxResults so we don't return 100 events
      if (events.length > maxResNum) {
        events = events.slice(0, maxResNum)
      }
    }
    return NextResponse.json({ events })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const token = await getToken({ req })
  const accessToken = token?.accessToken as string | undefined
  if (!accessToken) {
    return NextResponse.json({ error: 'No Google access token' }, { status: 401 })
  }

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
    const message = error instanceof Error ? error.message : 'Unknown error'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
