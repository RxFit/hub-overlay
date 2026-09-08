/**
 * Calendar operations the original wrapper never grew: updating an event, and
 * answering availability.
 *
 * Only create and delete existed, so "move my 3pm to 4pm" had no path at all —
 * the closest the app could do was delete and recreate, which loses the event
 * id, drops attendee RSVPs and re-notifies everyone as if it were new.
 */

import { googleFetch } from './client'
import { listCalendars } from '@/lib/google'

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3'

/** freeBusy's own hard cap on requested calendars. */
const FREEBUSY_API_CAP = 50
/** Bound for an AUTO-DISCOVERED selected-calendar set — distinct from (and
 *  tighter than) the API's own cap, so "when am I free?" with no explicit
 *  calendarIds can't balloon into checking dozens of stale selected calendars
 *  a user forgot were toggled on. */
const MAX_AUTO_DISCOVERED_CALENDARS = 10

export interface CalendarEventPatch {
  summary?: string
  description?: string
  location?: string
  /** ISO datetime ("2026-07-28T15:00:00") or all-day date ("2026-07-28"). */
  start?: string
  end?: string
  timeZone?: string
  attendees?: string[]
}

export interface PatchedEvent {
  id: string
  summary?: string
  htmlLink?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
}

/** All-day dates are 10 characters ("2026-07-28"); anything longer is timed. */
const isAllDay = (value: string) => value.length === 10

/**
 * Build the PATCH body from a partial update.
 *
 * `events.patch` merges: fields omitted here keep their current values. That is
 * exactly what "move my 3pm to 4pm" wants — the title, description, attendees
 * and conferencing all survive untouched. Building a full event body instead
 * would silently blank whatever the caller didn't restate.
 *
 * Pure, so the merge semantics are testable without a network call.
 */
export function buildEventPatch(patch: CalendarEventPatch): Record<string, unknown> {
  const body: Record<string, unknown> = {}

  if (patch.summary !== undefined) body.summary = patch.summary
  if (patch.description !== undefined) body.description = patch.description
  if (patch.location !== undefined) body.location = patch.location

  // Timed events carry the caller's IANA zone so Google anchors the naive local
  // datetime to the right offset rather than the calendar default; all-day
  // events must NOT carry one, or Google rejects the field combination.
  if (patch.start !== undefined) {
    body.start = isAllDay(patch.start)
      ? { date: patch.start }
      : { dateTime: patch.start, ...(patch.timeZone ? { timeZone: patch.timeZone } : {}) }
  }
  if (patch.end !== undefined) {
    body.end = isAllDay(patch.end)
      ? { date: patch.end }
      : { dateTime: patch.end, ...(patch.timeZone ? { timeZone: patch.timeZone } : {}) }
  }

  if (patch.attendees !== undefined) {
    body.attendees = patch.attendees.map(email => ({ email }))
  }

  return body
}

/**
 * Update an existing event in place.
 *
 * `sendUpdates` defaults to 'all' so attendees actually learn the meeting
 * moved. A silent reschedule is worse than none: everyone keeps the old time
 * in their calendar and shows up to an empty room. Callers that genuinely want
 * a quiet correction (fixing a typo in the description) can pass 'none' — and
 * the confirm card states which will happen.
 */
export async function updateCalendarEvent(
  accessToken: string,
  eventId: string,
  patch: CalendarEventPatch,
  opts: { calendarId?: string; sendUpdates?: 'all' | 'externalOnly' | 'none' } = {},
): Promise<PatchedEvent> {
  const calId = encodeURIComponent(opts.calendarId ?? 'primary')
  const params = new URLSearchParams({ sendUpdates: opts.sendUpdates ?? 'all' })

  return googleFetch<PatchedEvent>(
    `${CALENDAR_BASE}/calendars/${calId}/events/${encodeURIComponent(eventId)}?${params}`,
    accessToken,
    { method: 'PATCH', body: JSON.stringify(buildEventPatch(patch)) },
  )
}

export interface BusyPeriod {
  start: string
  end: string
}

/** A calendar Google could not read for us — permission, not-found, rate limit. */
export interface CalendarReadError {
  calendarId: string
  /** Google's `reason` code, e.g. "notFound", "forbidden", "rateLimitExceeded". */
  reason: string
}

export interface FreeBusyResult {
  /** Busy blocks per calendar id — only calendars that were actually readable. */
  byCalendar: Record<string, BusyPeriod[]>
  /** All busy blocks merged and sorted — what "when am I free?" needs. */
  merged: BusyPeriod[]
  /** Calendars freeBusy returned an error for. Google reports these INSIDE a
   *  200 response, one entry per calendar, with `busy` absent. Dropping them
   *  made an unreadable calendar indistinguishable from an empty one, so a
   *  fully-booked calendar the user lacks permission on was reported as FREE —
   *  the worst possible failure mode for an availability answer. */
  errors: CalendarReadError[]
  /** Every calendar id actually included in the freeBusy request, whether
   *  explicitly passed in or auto-discovered — the union of byCalendar's keys
   *  and errors' calendarIds. Lets a caller tell the user which calendars an
   *  availability answer covers, even before splitting readable/unreadable. */
  checked: string[]
}

/**
 * Merge overlapping/adjacent busy blocks into a minimal set.
 *
 * Two calendars almost always double-book the same meeting (an invite lands on
 * both), so raw blocks overlap heavily. Without merging, "find me a free hour"
 * has to reason over duplicates. Exported for direct testing.
 */
export function mergeBusyPeriods(periods: BusyPeriod[]): BusyPeriod[] {
  const sorted = periods
    .filter(p => p.start && p.end)
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start))

  const merged: BusyPeriod[] = []
  for (const period of sorted) {
    const last = merged[merged.length - 1]
    // `<=` merges touching blocks too: back-to-back meetings are one busy run,
    // not a zero-length gap someone could be offered.
    if (last && period.start <= last.end) {
      if (period.end > last.end) last.end = period.end
    } else {
      merged.push({ ...period })
    }
  }
  return merged
}

/**
 * Query free/busy across calendars.
 *
 * When `calendarIds` is omitted, this discovers the user's SELECTED calendar
 * set (what they see turned on in the Google Calendar UI) instead of silently
 * checking only `primary` — an availability answer that only ever looked at
 * `primary` under-reports busy time on every other calendar the user actually
 * uses. The discovered set is bounded (`MAX_AUTO_DISCOVERED_CALENDARS`)
 * independent of the API's own 50-calendar cap.
 */
export async function queryFreeBusy(
  accessToken: string,
  input: { timeMin: string; timeMax: string; calendarIds?: string[]; timeZone?: string },
): Promise<FreeBusyResult> {
  let ids: string[]
  if (input.calendarIds?.length) {
    ids = input.calendarIds.slice(0, FREEBUSY_API_CAP)
  } else {
    const cals = await listCalendars(accessToken)
    const discovered = cals.filter(c => c.selected || c.primary)
    // CalendarList order is arrival order, not significance order, and the cap
    // is a plain slice — so an account whose primary is listed after ten
    // selected calendars used to lose primary entirely and answer "free" over
    // the one calendar that matters most. Float primary ahead of the cap, and
    // de-duplicate first so a repeated id can't spend a slot twice.
    const ordered = [
      ...discovered.filter(c => c.primary),
      ...discovered.filter(c => !c.primary),
    ].map(c => c.id)
    const unique = [...new Set(ordered.filter(Boolean))]
    ids = (unique.length ? unique : ['primary']).slice(0, MAX_AUTO_DISCOVERED_CALENDARS)
  }

  const data = await googleFetch<{
    calendars?: Record<string, { busy?: BusyPeriod[]; errors?: { domain?: string; reason?: string }[] }>
  }>(`${CALENDAR_BASE}/freeBusy`, accessToken, {
    method: 'POST',
    body: JSON.stringify({
      timeMin: input.timeMin,
      timeMax: input.timeMax,
      ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      items: ids.map(id => ({ id })),
    }),
  })

  const byCalendar: Record<string, BusyPeriod[]> = {}
  const all: BusyPeriod[] = []
  const errors: CalendarReadError[] = []
  for (const [calendarId, entry] of Object.entries(data.calendars ?? {})) {
    // An errored calendar is NOT an empty one. Record it and leave it out of
    // byCalendar entirely, so no caller can read `[]` as "nothing scheduled".
    if (entry.errors?.length) {
      for (const err of entry.errors) {
        errors.push({ calendarId, reason: err.reason || err.domain || 'unknown' })
      }
      continue
    }
    const busy = entry.busy ?? []
    byCalendar[calendarId] = busy
    all.push(...busy)
  }

  return { byCalendar, merged: mergeBusyPeriods(all), errors, checked: ids }
}
