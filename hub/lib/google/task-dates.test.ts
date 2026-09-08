import { describe, it, expect } from 'vitest'
import { canonicalizeTaskDueDate } from './task-dates'

describe('canonicalizeTaskDueDate', () => {
  it('converts a bare calendar date to RFC3339 UTC midnight of the SAME date', () => {
    // Built from the string's own digits, not a local-zone Date — a server
    // running behind UTC must not roll the day back.
    expect(canonicalizeTaskDueDate('2026-07-28')).toEqual({
      ok: true,
      value: '2026-07-28T00:00:00.000Z',
    })
  })

  it('preserves the calendar date across a year/month boundary', () => {
    expect(canonicalizeTaskDueDate('2027-01-01')).toEqual({
      ok: true,
      value: '2027-01-01T00:00:00.000Z',
    })
  })

  it('rejects a calendar date that does not exist', () => {
    const result = canonicalizeTaskDueDate('2026-02-30')
    expect(result.ok).toBe(false)
  })

  it('rejects a malformed calendar date (month 13)', () => {
    expect(canonicalizeTaskDueDate('2026-13-01').ok).toBe(false)
  })

  it('passes through an already-resolved RFC3339 timestamp with Z', () => {
    expect(canonicalizeTaskDueDate('2026-07-28T15:00:00.000Z')).toEqual({
      ok: true,
      value: '2026-07-28T15:00:00.000Z',
    })
  })

  it('passes through an already-resolved RFC3339 timestamp with an explicit offset', () => {
    expect(canonicalizeTaskDueDate('2026-07-28T10:00:00-05:00')).toEqual({
      ok: true,
      value: '2026-07-28T10:00:00-05:00',
    })
  })

  it('rejects a naive datetime with no zone designator — resolved means unambiguous', () => {
    expect(canonicalizeTaskDueDate('2026-07-28T00:00:00').ok).toBe(false)
  })

  it('rejects an out-of-range time-of-day on an otherwise well-formed timestamp', () => {
    expect(canonicalizeTaskDueDate('2026-07-28T25:00:00Z').ok).toBe(false)
  })

  it.each([
    ['2026-07-28T10:00:00+99:99', 'offset hour and minute both out of range'],
    ['2026-07-28T10:00:00+24:00', 'offset hour outside the RFC3339 00-23 range'],
    ['2026-07-28T10:00:00+05:60', 'offset minute above 59'],
  ])('rejects a malformed numeric offset — %s (%s)', (value) => {
    const result = canonicalizeTaskDueDate(value)
    expect(result.ok).toBe(false)
  })

  it.each([
    'next Friday',
    'tomorrow',
    'Friday',
    'in 2 weeks',
    'end of month',
    'ASAP',
  ])('rejects ambiguous natural language %j before it can reach Google', (text) => {
    const result = canonicalizeTaskDueDate(text)
    expect(result.ok).toBe(false)
  })

  it('rejects an empty or whitespace-only value', () => {
    expect(canonicalizeTaskDueDate('').ok).toBe(false)
    expect(canonicalizeTaskDueDate('   ').ok).toBe(false)
  })

  it('trims surrounding whitespace before validating a good date', () => {
    expect(canonicalizeTaskDueDate('  2026-07-28  ')).toEqual({
      ok: true,
      value: '2026-07-28T00:00:00.000Z',
    })
  })
})
