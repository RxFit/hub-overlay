import { describe, it, expect } from 'vitest'
import {
  formatHour,
  ordinal,
  describeSchedule,
  describeDelivery,
  newReport,
  applyCadence,
  parseRecipients,
  formatRecipients,
  MONTH_DAY_OPTIONS,
  WEEKDAY_OPTIONS,
} from './editor'
import { normalizeReports, DEFAULT_REPORTS, type ReportConfig } from './config'

const base: ReportConfig = {
  id: 'weekly-digest',
  kind: 'ga4_gsc_digest',
  cadence: 'weekly',
  day: 'mon',
  hourLocal: 7,
  delivery: { email: ['admins'] },
  enabled: true,
}

describe('formatHour', () => {
  it('renders 12-hour times with the right meridiem', () => {
    expect(formatHour(0)).toBe('12:00 AM')
    expect(formatHour(7)).toBe('7:00 AM')
    expect(formatHour(12)).toBe('12:00 PM')
    expect(formatHour(13)).toBe('1:00 PM')
    expect(formatHour(23)).toBe('11:00 PM')
  })

  it('clamps out-of-range hours rather than rendering nonsense', () => {
    expect(formatHour(-5)).toBe('12:00 AM')
    expect(formatHour(99)).toBe('11:00 PM')
  })
})

describe('ordinal', () => {
  it('handles the ordinary cases', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(4)).toBe('4th')
    expect(ordinal(21)).toBe('21st')
  })

  it('handles the teens, which do not follow the last-digit rule', () => {
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(13)).toBe('13th')
  })
})

describe('describeSchedule', () => {
  it('describes a weekly report', () => {
    expect(describeSchedule(base, 'America/Chicago')).toBe('Every Monday at 7:00 AM America/Chicago')
  })

  it('describes a daily report', () => {
    expect(describeSchedule({ ...base, cadence: 'daily', day: undefined }, 'UTC'))
      .toBe('Every day at 7:00 AM UTC')
  })

  it('describes a monthly report with an ordinal day', () => {
    expect(describeSchedule({ ...base, cadence: 'monthly', day: 3 }, 'UTC'))
      .toBe('The 3rd of each month at 7:00 AM UTC')
  })

  it('ALWAYS states the timezone — an unstated one is the bug that hid a day-late window', () => {
    expect(describeSchedule(base)).toContain('workspace timezone')
    expect(describeSchedule(base, 'Asia/Tokyo')).toContain('Asia/Tokyo')
  })

  it('falls back sensibly when day is the wrong type for the cadence', () => {
    // Mid-edit state: cadence flipped before day was corrected.
    expect(describeSchedule({ ...base, cadence: 'monthly', day: 'mon' }, 'UTC'))
      .toBe('The 1st of each month at 7:00 AM UTC')
    expect(describeSchedule({ ...base, cadence: 'weekly', day: 9 }, 'UTC'))
      .toBe('Every Monday at 7:00 AM UTC')
  })
})

describe('describeDelivery', () => {
  it('names the admins token', () => {
    expect(describeDelivery(base)).toBe('Sends to all admins')
  })

  it('counts extra recipients alongside admins', () => {
    expect(describeDelivery({ ...base, delivery: { email: ['admins', 'a@b.com'] } }))
      .toBe('Sends to all admins and 1 more')
  })

  it('names a single explicit recipient', () => {
    expect(describeDelivery({ ...base, delivery: { email: ['a@b.com'] } }))
      .toBe('Sends to a@b.com')
  })

  it('mentions a Chat space when one is set', () => {
    expect(describeDelivery({ ...base, delivery: { email: ['admins'], chatSpaceId: 'spaces/x' } }))
      .toContain('a Chat space')
  })

  it('describes an empty delivery as Drive-only, not as broken', () => {
    // Empty delivery is legitimate — the artifact is still created.
    expect(describeDelivery({ ...base, delivery: { email: [] } })).toBe('Saved to Drive only')
  })
})

describe('newReport', () => {
  it('starts DISABLED so a half-configured report cannot send', () => {
    // There is no unsend; an admin adding a row is mid-thought.
    expect(newReport('ga4_gsc_digest', []).enabled).toBe(false)
  })

  it('inherits the seeded defaults for its kind', () => {
    const r = newReport('business_review_deck', [])
    const seeded = DEFAULT_REPORTS.find(d => d.kind === 'business_review_deck')!
    expect(r.cadence).toBe(seeded.cadence)
    expect(r.day).toBe(seeded.day)
    expect(r.hourLocal).toBe(seeded.hourLocal)
  })

  it('never collides with an existing id', () => {
    const first = newReport('ga4_gsc_digest', [])
    const second = newReport('ga4_gsc_digest', [first])
    const third = newReport('ga4_gsc_digest', [first, second])
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)
  })

  it('survives the server normalizer unchanged', () => {
    // A default that normalizeReports would rewrite means the form lies about
    // what gets stored.
    const r = newReport('ga4_gsc_digest', [])
    expect(normalizeReports([r])).toEqual([r])
  })
})

describe('applyCadence', () => {
  it('drops day when switching to daily', () => {
    expect(applyCadence(base, 'daily').day).toBeUndefined()
  })

  it('converts a weekday to a day-of-month when switching to monthly', () => {
    // Leaving 'mon' on a monthly report would be silently rewritten on save.
    expect(applyCadence(base, 'monthly').day).toBe(1)
  })

  it('converts a day-of-month to a weekday when switching to weekly', () => {
    const monthly: ReportConfig = { ...base, cadence: 'monthly', day: 14 }
    expect(applyCadence(monthly, 'weekly').day).toBe('mon')
  })

  it('preserves a compatible day', () => {
    const friday: ReportConfig = { ...base, day: 'fri' }
    expect(applyCadence(friday, 'weekly').day).toBe('fri')
    const tenth: ReportConfig = { ...base, cadence: 'monthly', day: 10 }
    expect(applyCadence(tenth, 'monthly').day).toBe(10)
  })

  it('returns the same object when the cadence is unchanged', () => {
    expect(applyCadence(base, 'weekly')).toBe(base)
  })

  it('produces configs the server normalizer accepts unchanged', () => {
    for (const cadence of ['daily', 'weekly', 'monthly'] as const) {
      const next = applyCadence(base, cadence)
      expect(normalizeReports([next])).toEqual([next])
    }
  })
})

describe('parseRecipients', () => {
  it('splits on commas, semicolons and newlines', () => {
    const { emails } = parseRecipients('a@b.com, c@d.com; e@f.com\ng@h.com')
    expect(emails).toEqual(['a@b.com', 'c@d.com', 'e@f.com', 'g@h.com'])
  })

  it('preserves the admins token rather than rejecting it as an address', () => {
    expect(parseRecipients('admins, a@b.com').emails).toEqual(['admins', 'a@b.com'])
  })

  it('reports a malformed address instead of silently dropping it', () => {
    // A typo'd recipient receiving nothing forever is worse than an edit-time error.
    const { emails, invalid } = parseRecipients('a@b.com, not-an-email')
    expect(emails).toEqual(['a@b.com'])
    expect(invalid).toEqual(['not-an-email'])
  })

  it('deduplicates case-insensitively', () => {
    expect(parseRecipients('A@B.com, a@b.com').emails).toEqual(['A@B.com'])
  })

  it('ignores empty segments and surrounding whitespace', () => {
    expect(parseRecipients('  a@b.com ,, ').emails).toEqual(['a@b.com'])
  })

  it('round-trips through formatRecipients', () => {
    const input = 'admins, a@b.com'
    expect(formatRecipients(parseRecipients(input).emails)).toBe(input)
  })
})

describe('picker options', () => {
  it('offers only days every month actually has', () => {
    // normalizeReports caps at 28; offering the 31st would promise a send that
    // silently skips February and every 30-day month.
    expect(MONTH_DAY_OPTIONS[0]).toBe(1)
    expect(MONTH_DAY_OPTIONS.at(-1)).toBe(28)
    expect(MONTH_DAY_OPTIONS).toHaveLength(28)
  })

  it('offers all seven weekdays in calendar order', () => {
    expect(WEEKDAY_OPTIONS.map(d => d.value)).toEqual(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'])
  })
})
