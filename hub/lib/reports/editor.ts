/**
 * Editor-side helpers for scheduled reports (PURE — no DB, no React).
 *
 * The 7th finding of the #164 audit: `google_prefs.reports` became readable and
 * writable end to end, but nothing could write it, so the configurable cadence
 * shipped in #158 still could not be configured. This module is the logic half
 * of the editor that closes that gap.
 *
 * Pure and separate from the component because the parts worth testing are the
 * parts a form makes hard to test: turning a config into the sentence an admin
 * reads before trusting it, and producing defaults that survive
 * `normalizeReports` unchanged.
 */

import {
  DEFAULT_REPORTS,
  WEEKDAYS,
  type ReportConfig,
  type ReportCadence,
  type ReportKind,
  type Weekday,
} from './config'

/** Human labels for the two report kinds. */
export const REPORT_KIND_LABELS: Record<ReportKind, string> = {
  ga4_gsc_digest: 'Analytics digest (GA4 + Search Console)',
  business_review_deck: 'Business review deck',
}

export const CADENCE_LABELS: Record<ReportCadence, string> = {
  daily: 'Every day',
  weekly: 'Every week',
  monthly: 'Every month',
}

const WEEKDAY_LABELS: Record<Weekday, string> = {
  sun: 'Sunday', mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday',
  thu: 'Thursday', fri: 'Friday', sat: 'Saturday',
}

/** "7" → "7:00 AM". The runner works in whole local hours. */
export function formatHour(hour: number): string {
  const h = Math.min(23, Math.max(0, Math.floor(hour)))
  const suffix = h < 12 ? 'AM' : 'PM'
  const display = h % 12 === 0 ? 12 : h % 12
  return `${display}:00 ${suffix}`
}

/** "1" → "1st". Used for monthly day-of-month. */
export function ordinal(n: number): string {
  const v = Math.floor(n)
  const mod100 = v % 100
  if (mod100 >= 11 && mod100 <= 13) return `${v}th`
  switch (v % 10) {
    case 1: return `${v}st`
    case 2: return `${v}nd`
    case 3: return `${v}rd`
    default: return `${v}th`
  }
}

/**
 * The one-line schedule summary shown next to each report.
 *
 * This is the only place an admin can check that what they configured is what
 * will happen, so it states the timezone explicitly. A digest that fires at
 * "7:00 AM" in an unstated zone is exactly the ambiguity that made the audit's
 * first finding invisible for so long.
 */
export function describeSchedule(report: ReportConfig, timezone?: string): string {
  const at = `at ${formatHour(report.hourLocal)}`
  const zone = timezone ? ` ${timezone}` : ' (workspace timezone)'

  switch (report.cadence) {
    case 'daily':
      return `Every day ${at}${zone}`
    case 'weekly': {
      const day = typeof report.day === 'string' ? WEEKDAY_LABELS[report.day] : 'Monday'
      return `Every ${day} ${at}${zone}`
    }
    case 'monthly': {
      const day = typeof report.day === 'number' ? report.day : 1
      return `The ${ordinal(day)} of each month ${at}${zone}`
    }
  }
}

/** Who a report goes to, in prose. */
export function describeDelivery(report: ReportConfig): string {
  const parts: string[] = []
  const emails = report.delivery.email

  if (emails.includes('admins')) {
    const others = emails.filter(e => e !== 'admins')
    parts.push(others.length ? `all admins and ${others.length} more` : 'all admins')
  } else if (emails.length) {
    parts.push(emails.length === 1 ? emails[0] : `${emails.length} recipients`)
  }

  if (report.delivery.chatSpaceId) parts.push('a Chat space')

  // Empty delivery is a legitimate configuration, not a broken one — the
  // artifact is still created in Drive. Say so, rather than showing nothing.
  return parts.length ? `Sends to ${parts.join(' and ')}` : 'Saved to Drive only'
}

/** Stable-ish unique id for a newly added report. */
function newReportId(kind: ReportKind, existing: ReportConfig[]): string {
  const base = kind === 'business_review_deck' ? 'review' : 'digest'
  let n = 1
  const taken = new Set(existing.map(r => r.id))
  while (taken.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/**
 * A new report, pre-filled with the same defaults the seeded ones use.
 *
 * Deliberately starts DISABLED. An admin adding a row is mid-thought; a report
 * that begins firing before they have set the recipients would send the wrong
 * people a digest, and there is no unsend.
 */
export function newReport(kind: ReportKind, existing: ReportConfig[]): ReportConfig {
  const template = DEFAULT_REPORTS.find(r => r.kind === kind)
  return {
    id: newReportId(kind, existing),
    kind,
    cadence: template?.cadence ?? 'weekly',
    day: template?.day ?? 'mon',
    hourLocal: template?.hourLocal ?? 7,
    delivery: { email: ['admins'] },
    enabled: false,
  }
}

/**
 * Keep `day` meaningful when the cadence changes.
 *
 * The two cadences store different types in the same field — a weekday string
 * versus a day-of-month number — so switching from weekly to monthly with the
 * old value in place leaves `day: 'mon'` on a monthly report. `normalizeReports`
 * would silently rewrite that to the 1st on save; doing it here means the form
 * shows the admin what will actually be stored.
 */
export function applyCadence(report: ReportConfig, cadence: ReportCadence): ReportConfig {
  if (cadence === report.cadence) return report
  if (cadence === 'daily') return { ...report, cadence, day: undefined }
  if (cadence === 'weekly') {
    return { ...report, cadence, day: typeof report.day === 'string' ? report.day : 'mon' }
  }
  return { ...report, cadence, day: typeof report.day === 'number' ? report.day : 1 }
}

/**
 * Parse the recipients field into the stored array.
 *
 * `admins` is a token that expands to the tenant's admin emails at send time,
 * so it is preserved rather than validated as an address. Everything else must
 * look like an email — a typo'd recipient silently receiving nothing is worse
 * than being told at edit time.
 */
export function parseRecipients(input: string): { emails: string[]; invalid: string[] } {
  const emails: string[] = []
  const invalid: string[] = []
  const seen = new Set<string>()

  for (const raw of input.split(/[,\n;]/)) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)

    if (key === 'admins' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) emails.push(value)
    else invalid.push(value)
  }
  return { emails, invalid }
}

/** Render the stored array back into the editable field. */
export function formatRecipients(emails: string[]): string {
  return emails.join(', ')
}

/** Weekday options for the picker, in calendar order. */
export const WEEKDAY_OPTIONS: { value: Weekday; label: string }[] = WEEKDAYS.map(d => ({
  value: d,
  label: WEEKDAY_LABELS[d],
}))

/**
 * Days of the month offered by the picker.
 *
 * Capped at 28 to match `normalizeReports`: a report set for the 31st would
 * silently skip February and every 30-day month. Offering a day the scheduler
 * will not honour is worse than not offering it.
 */
export const MONTH_DAY_OPTIONS: number[] = Array.from({ length: 28 }, (_, i) => i + 1)
