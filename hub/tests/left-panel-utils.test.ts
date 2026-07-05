import { describe, it, expect } from 'vitest'
import { eventDisplayTitle } from '@/app/components/LeftPanelUtils'

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
