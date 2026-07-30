import { describe, it, expect } from 'vitest'
import {
  normalizeReports,
  isDue,
  dueReports,
  localParts,
  reportWindow,
  DEFAULT_REPORTS,
  type ReportConfig,
} from './config'

const weekly = (over: Partial<ReportConfig> = {}): ReportConfig => ({
  id: 'w',
  kind: 'ga4_gsc_digest',
  cadence: 'weekly',
  day: 'mon',
  hourLocal: 7,
  delivery: { email: ['admins'] },
  enabled: true,
  ...over,
})

/** 2026-07-27 is a Monday. 12:00Z = 07:00 America/Chicago (CDT, UTC-5). */
const MON_1200Z = new Date('2026-07-27T12:00:00Z')

describe('normalizeReports', () => {
  it('accepts the seeded defaults unchanged', () => {
    expect(normalizeReports(DEFAULT_REPORTS)).toHaveLength(2)
  })

  it('drops entries with an unusable id, kind or cadence', () => {
    const out = normalizeReports([
      { id: '', kind: 'ga4_gsc_digest', cadence: 'weekly' },
      { id: 'a', kind: 'nope', cadence: 'weekly' },
      { id: 'b', kind: 'ga4_gsc_digest', cadence: 'fortnightly' },
      { id: 'good', kind: 'ga4_gsc_digest', cadence: 'weekly' },
    ])
    expect(out.map(r => r.id)).toEqual(['good'])
  })

  it('drops duplicate ids rather than running a report twice', () => {
    const out = normalizeReports([
      { id: 'x', kind: 'ga4_gsc_digest', cadence: 'daily' },
      { id: 'x', kind: 'ga4_gsc_digest', cadence: 'daily' },
    ])
    expect(out).toHaveLength(1)
  })

  it('clamps an out-of-range hour instead of dropping the report', () => {
    expect(normalizeReports([{ id: 'a', kind: 'ga4_gsc_digest', cadence: 'daily', hourLocal: 99 }])[0].hourLocal).toBe(23)
    expect(normalizeReports([{ id: 'a', kind: 'ga4_gsc_digest', cadence: 'daily', hourLocal: -4 }])[0].hourLocal).toBe(0)
  })

  it('caps a monthly day at 28 so it fires every month', () => {
    // A report set for the 31st would silently skip February and 30-day months.
    const out = normalizeReports([{ id: 'm', kind: 'ga4_gsc_digest', cadence: 'monthly', day: 31 }])
    expect(out[0].day).toBe(28)
  })

  it('defaults an invalid weekday to Monday', () => {
    const out = normalizeReports([{ id: 'w', kind: 'ga4_gsc_digest', cadence: 'weekly', day: 'funday' }])
    expect(out[0].day).toBe('mon')
  })

  it('treats a missing enabled flag as enabled, and false as disabled', () => {
    expect(normalizeReports([{ id: 'a', kind: 'ga4_gsc_digest', cadence: 'daily' }])[0].enabled).toBe(true)
    expect(
      normalizeReports([{ id: 'a', kind: 'ga4_gsc_digest', cadence: 'daily', enabled: false }])[0].enabled,
    ).toBe(false)
  })

  it('keeps only usable delivery addresses', () => {
    const out = normalizeReports([
      {
        id: 'a',
        kind: 'ga4_gsc_digest',
        cadence: 'daily',
        delivery: { email: ['admins', '', 42, ' x@y.com '], chatSpaceId: ' spaces/1 ' },
      },
    ])
    expect(out[0].delivery.email).toEqual(['admins', 'x@y.com'])
    expect(out[0].delivery.chatSpaceId).toBe('spaces/1')
  })

  it('never throws on junk', () => {
    expect(normalizeReports(null)).toEqual([])
    expect(normalizeReports('nope')).toEqual([])
    expect(normalizeReports([null, 7, 'x'])).toEqual([])
  })
})

describe('localParts', () => {
  it('resolves wall-clock fields in the tenant timezone', () => {
    expect(localParts(MON_1200Z, 'America/Chicago')).toMatchObject({
      hour: 7,
      weekday: 'mon',
      dayOfMonth: 27,
    })
  })

  it('differs from UTC for the same instant', () => {
    expect(localParts(MON_1200Z, 'UTC').hour).toBe(12)
  })

  it('crosses a date boundary correctly', () => {
    // 02:00Z Monday is still Sunday evening in Chicago.
    const parts = localParts(new Date('2026-07-27T02:00:00Z'), 'America/Chicago')
    expect(parts.weekday).toBe('sun')
    expect(parts.dayOfMonth).toBe(26)
  })

  it('falls back to UTC for an unrecognized timezone rather than throwing', () => {
    expect(() => localParts(MON_1200Z, 'Mars/Olympus')).not.toThrow()
    expect(localParts(MON_1200Z, 'Mars/Olympus').hour).toBe(12)
  })

  it('reports midnight as hour 0, not 24', () => {
    expect(localParts(new Date('2026-07-27T00:00:00Z'), 'UTC').hour).toBe(0)
  })
})

describe('isDue', () => {
  it('fires a weekly report on its weekday and local hour', () => {
    expect(isDue(weekly(), MON_1200Z, 'America/Chicago')).toBe(true)
  })

  it('does not fire on the right hour but wrong day', () => {
    expect(isDue(weekly({ day: 'tue' }), MON_1200Z, 'America/Chicago')).toBe(false)
  })

  it('does not fire on the right day but wrong hour', () => {
    expect(isDue(weekly({ hourLocal: 9 }), MON_1200Z, 'America/Chicago')).toBe(false)
  })

  it('respects the timezone — the same instant is not 7am everywhere', () => {
    // 12:00Z is 07:00 in Chicago but 12:00 in UTC; a UTC tenant is not due.
    expect(isDue(weekly(), MON_1200Z, 'UTC')).toBe(false)
  })

  it('never fires a disabled report', () => {
    expect(isDue(weekly({ enabled: false }), MON_1200Z, 'America/Chicago')).toBe(false)
  })

  it('fires daily reports on any day at the right hour', () => {
    const daily = weekly({ cadence: 'daily', day: undefined })
    expect(isDue(daily, MON_1200Z, 'America/Chicago')).toBe(true)
    expect(isDue(daily, new Date('2026-07-29T12:00:00Z'), 'America/Chicago')).toBe(true)
  })

  it('fires a monthly report only on its day of month', () => {
    const monthly = weekly({ cadence: 'monthly', day: 27 })
    expect(isDue(monthly, MON_1200Z, 'America/Chicago')).toBe(true)
    expect(isDue({ ...monthly, day: 28 }, MON_1200Z, 'America/Chicago')).toBe(false)
  })

  it('is stable across the whole firing hour', () => {
    // Cloud Scheduler may fire at :00:03 or :00:47 — both must agree, or a
    // report would randomly skip.
    for (const minute of ['00', '17', '59']) {
      expect(isDue(weekly(), new Date(`2026-07-27T12:${minute}:00Z`), 'America/Chicago')).toBe(true)
    }
  })

  it('fires exactly once across a day of hourly polls', () => {
    const fires = Array.from({ length: 24 }, (_, h) =>
      isDue(weekly(), new Date(`2026-07-27T${String(h).padStart(2, '0')}:00:00Z`), 'America/Chicago'),
    ).filter(Boolean)
    expect(fires).toHaveLength(1)
  })
})

describe('dueReports', () => {
  it('selects only the reports due now', () => {
    const reports = [weekly({ id: 'a' }), weekly({ id: 'b', hourLocal: 9 }), weekly({ id: 'c', day: 'fri' })]
    expect(dueReports(reports, MON_1200Z, 'America/Chicago').map(r => r.id)).toEqual(['a'])
  })

  it('returns nothing when none are due', () => {
    expect(dueReports([weekly({ hourLocal: 3 })], MON_1200Z, 'America/Chicago')).toEqual([])
  })
})

describe('reportWindow', () => {
  it('ends yesterday, because today is partial data', () => {
    // A "last week" digest that includes a half-finished today understates
    // every figure in it.
    const { endDate } = reportWindow('weekly', new Date('2026-07-28T07:00:00Z'))
    expect(endDate).toBe('2026-07-27')
  })

  it('spans seven days for a weekly report', () => {
    expect(reportWindow('weekly', new Date('2026-07-28T07:00:00Z'))).toEqual({
      startDate: '2026-07-21',
      endDate: '2026-07-27',
    })
  })

  it('spans thirty days for a monthly report', () => {
    expect(reportWindow('monthly', new Date('2026-07-31T07:00:00Z'))).toEqual({
      startDate: '2026-07-01',
      endDate: '2026-07-30',
    })
  })

  it('covers a single day for a daily report', () => {
    const { startDate, endDate } = reportWindow('daily', new Date('2026-07-28T07:00:00Z'))
    expect(startDate).toBe('2026-07-27')
    expect(endDate).toBe('2026-07-27')
  })

  it('crosses a month boundary correctly', () => {
    expect(reportWindow('weekly', new Date('2026-08-03T07:00:00Z'))).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-08-02',
    })
  })
})

describe('reportWindow — tenant-local anchoring (regression)', () => {
  it('anchors the window to the tenant local date, not the UTC date', () => {
    // The bug: isDue matched in tenant-local time while reportWindow computed
    // from UTC. At UTC+9 the seeded Mon 07:00 digest fires at 22:00Z Sunday, so
    // the UTC-derived window landed a full day behind, permanently.
    const firing = new Date('2026-08-02T22:00:00Z') // Mon 2026-08-03 07:00 Asia/Tokyo
    expect(reportWindow('weekly', firing, 'Asia/Tokyo')).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-08-02',
    })
    // Same instant read as UTC is a day earlier — this is the divergence.
    expect(reportWindow('weekly', firing, 'UTC').endDate).toBe('2026-08-01')
  })

  it('agrees with isDue about which local day it is', () => {
    const firing = new Date('2026-08-02T22:00:00Z')
    const tz = 'Asia/Tokyo'
    // isDue sees Monday...
    expect(isDue(weekly({ day: 'mon' }), firing, tz)).toBe(true)
    // ...so the window must end on Sunday the 2nd, the local yesterday.
    expect(reportWindow('weekly', firing, tz).endDate).toBe('2026-08-02')
  })

  it('still ends yesterday for a western timezone', () => {
    // 12:00Z Tue = 07:00 Chicago Tue; yesterday local is Monday the 27th.
    expect(reportWindow('daily', new Date('2026-07-28T12:00:00Z'), 'America/Chicago')).toEqual({
      startDate: '2026-07-27',
      endDate: '2026-07-27',
    })
  })

  it('falls back to UTC for an unusable timezone rather than throwing', () => {
    expect(() => reportWindow('weekly', new Date('2026-07-28T12:00:00Z'), 'Mars/Olympus')).not.toThrow()
  })

  it('keeps the no-timezone behavior unchanged', () => {
    expect(reportWindow('weekly', new Date('2026-07-28T07:00:00Z'))).toEqual({
      startDate: '2026-07-21',
      endDate: '2026-07-27',
    })
  })
})

describe('normalizeReports — settings-editor round trip', () => {
  it('survives a whole-list save/reload without drifting', () => {
    // The editor PUTs the entire list and renders whatever comes back, so
    // normalize must be idempotent or the form would visibly change after save.
    const edited = [
      { id: 'weekly-digest', kind: 'ga4_gsc_digest', cadence: 'weekly', day: 'fri', hourLocal: 16,
        delivery: { email: ['admins'] }, enabled: true },
      { id: 'monthly-review', kind: 'business_review_deck', cadence: 'monthly', day: 1, hourLocal: 9,
        delivery: { email: [] }, enabled: false },
    ]
    const once = normalizeReports(edited)
    expect(normalizeReports(once)).toEqual(once)
    expect(once[0]).toMatchObject({ cadence: 'weekly', day: 'fri', hourLocal: 16 })
    expect(once[1].enabled).toBe(false)
  })

  it('repairs a cadence switch that left a stale day value', () => {
    // Switching weekly -> monthly in the UI could carry a weekday across; the
    // server must not store 'mon' as a day-of-month.
    const out = normalizeReports([
      { id: 'x', kind: 'ga4_gsc_digest', cadence: 'monthly', day: 'mon', hourLocal: 7, delivery: { email: [] } },
    ])
    expect(out[0].day).toBe(1)
  })

  it('accepts an empty delivery list as Drive-only', () => {
    const out = normalizeReports([
      { id: 'x', kind: 'ga4_gsc_digest', cadence: 'weekly', delivery: { email: [] } },
    ])
    expect(out[0].delivery.email).toEqual([])
  })

  it('preserves both seeded defaults through a reset-then-save', () => {
    expect(normalizeReports(DEFAULT_REPORTS)).toEqual(DEFAULT_REPORTS)
  })
})
