import { describe, it, expect } from 'vitest'
import { eventDisplayTitle, validateEventForm } from '@/app/components/LeftPanelUtils'

/**
 * Unit coverage for the calendar event display-title helper (F6). Summary-less
 * Google Calendar events must render as '(untitled)' — matching the
 * lib/panel-inject.ts convention — instead of "undefined".
 */

describe('eventDisplayTitle (F6)', () => {
  it('falls back to (untitled) when summary is undefined', () => {
    expect(eventDisplayTitle(undefined)).toBe('(untitled)')
    expect(eventDisplayTitle()).toBe('(untitled)')
  })

  it('falls back to (untitled) when summary is an empty string', () => {
    expect(eventDisplayTitle('')).toBe('(untitled)')
  })

  it('falls back to (untitled) when summary is whitespace-only', () => {
    expect(eventDisplayTitle('   ')).toBe('(untitled)')
    expect(eventDisplayTitle('\n\t ')).toBe('(untitled)')
  })

  it('returns the trimmed summary when present', () => {
    expect(eventDisplayTitle('Team standup')).toBe('Team standup')
    expect(eventDisplayTitle('  Team standup  ')).toBe('Team standup')
  })
})

/**
 * Unit coverage for the new-event modal validation helper (F7). End must be
 * after start, and attendees must pass the server's email rule — bad input
 * must never reach the POST.
 */

describe('validateEventForm (F7)', () => {
  it('rejects an end time before the start time', () => {
    expect(validateEventForm({ startTime: '14:00', endTime: '13:00', attendees: '' }))
      .toBe('End time must be after the start time.')
  })

  it('rejects an end time equal to the start time', () => {
    expect(validateEventForm({ startTime: '09:00', endTime: '09:00', attendees: '' }))
      .toBe('End time must be after the start time.')
  })

  it('accepts an end time after the start time', () => {
    expect(validateEventForm({ startTime: '09:00', endTime: '10:00', attendees: '' })).toBeNull()
  })

  it('accepts an empty attendee field', () => {
    expect(validateEventForm({ startTime: '09:00', endTime: '10:00', attendees: '' })).toBeNull()
    expect(validateEventForm({ startTime: '09:00', endTime: '10:00', attendees: '  , ' })).toBeNull()
  })

  it('rejects a single malformed attendee (singular message)', () => {
    expect(validateEventForm({ startTime: '09:00', endTime: '10:00', attendees: 'not-an-email' }))
      .toBe('Invalid attendee email: not-an-email')
  })

  it('reports only the bad addresses in a mixed list (plural message)', () => {
    expect(validateEventForm({
      startTime: '09:00',
      endTime: '10:00',
      attendees: 'good@example.com, bad-one, also@ok.io, @nope',
    })).toBe('Invalid attendee emails: bad-one, @nope')
  })

  it('accepts whitespace-padded valid emails', () => {
    expect(validateEventForm({
      startTime: '09:00',
      endTime: '10:00',
      attendees: '  a@b.com ,  c@d.org  ',
    })).toBeNull()
  })

  it('checks times before attendees', () => {
    expect(validateEventForm({ startTime: '14:00', endTime: '13:00', attendees: 'not-an-email' }))
      .toBe('End time must be after the start time.')
  })
})
