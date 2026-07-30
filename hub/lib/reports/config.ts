/**
 * Scheduled report configuration and due-time evaluation.
 *
 * Cadence and recipients are per-tenant and admin-editable (decision 6) rather
 * than hardcoded — the seeded defaults are a weekly GA4+GSC digest and a
 * monthly review, but a tenant can retime, redirect or disable each one.
 *
 * ── The scheduling model, and why it is shaped this way ──
 * Cloud Scheduler fires the runner HOURLY. Each firing asks every configured
 * report "are you due in this hour, in your tenant's timezone?". That is
 * deliberately different from giving each report its own cron entry:
 *
 *  - Per-report cron entries would need provisioning and deprovisioning from
 *    application code every time an admin changed a cadence — infrastructure
 *    mutations driven by a settings form.
 *  - An hourly poll makes the schedule pure DATA. Changing a cadence is a row
 *    update, and the logic that decides "due" is a pure function, which is the
 *    part worth testing exhaustively.
 *
 * The cost is up to an hour of granularity, which is the right trade for a
 * weekly digest.
 *
 * This module is PURE (no DB, no network) so the scheduling rules can be tested
 * directly — scheduling bugs are the kind that silently send nothing for weeks,
 * or send the same digest seven times.
 */

export type ReportCadence = 'daily' | 'weekly' | 'monthly'
export type ReportKind = 'ga4_gsc_digest' | 'business_review_deck'

export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export interface ReportDelivery {
  /** 'admins' expands to the tenant's admin emails; other entries are literal
   *  addresses. Empty means Drive-only (the artifact is still created). */
  email: string[]
  /** Google Chat space to post a link to, when set. */
  chatSpaceId?: string
}

export interface ReportConfig {
  id: string
  kind: ReportKind
  cadence: ReportCadence
  /** Weekday for 'weekly'; day-of-month (1–28) for 'monthly'; ignored daily. */
  day?: Weekday | number
  /** Local hour (0–23) in the tenant's timezone. */
  hourLocal: number
  delivery: ReportDelivery
  enabled: boolean
}

/** Seeded defaults — the starting point Danny asked for, all editable after. */
export const DEFAULT_REPORTS: ReportConfig[] = [
  {
    id: 'weekly-digest',
    kind: 'ga4_gsc_digest',
    cadence: 'weekly',
    day: 'mon',
    hourLocal: 7,
    delivery: { email: ['admins'] },
    enabled: true,
  },
  {
    id: 'monthly-review',
    kind: 'business_review_deck',
    cadence: 'monthly',
    day: 1,
    hourLocal: 7,
    delivery: { email: ['admins'] },
    enabled: true,
  },
]

const CADENCES: ReadonlySet<string> = new Set<ReportCadence>(['daily', 'weekly', 'monthly'])
const KINDS: ReadonlySet<string> = new Set<ReportKind>(['ga4_gsc_digest', 'business_review_deck'])

/**
 * Harden stored/admin-supplied config. Never throws — a malformed entry is
 * dropped rather than allowed to wedge the whole runner, because one bad row
 * must not stop every other tenant's reports.
 */
export function normalizeReports(input: unknown): ReportConfig[] {
  if (!Array.isArray(input)) return []
  const seen = new Set<string>()
  const out: ReportConfig[] = []

  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>

    const id = typeof r.id === 'string' ? r.id.trim().slice(0, 64) : ''
    const kind = typeof r.kind === 'string' && KINDS.has(r.kind) ? (r.kind as ReportKind) : null
    const cadence =
      typeof r.cadence === 'string' && CADENCES.has(r.cadence) ? (r.cadence as ReportCadence) : null
    if (!id || !kind || !cadence || seen.has(id)) continue

    // An out-of-range hour is clamped rather than dropped: the admin clearly
    // wanted this report, and 7am is a defensible reading of a typo.
    const rawHour = typeof r.hourLocal === 'number' ? Math.floor(r.hourLocal) : 7
    const hourLocal = Math.min(23, Math.max(0, Number.isFinite(rawHour) ? rawHour : 7))

    let day: Weekday | number | undefined
    if (cadence === 'weekly') {
      day = typeof r.day === 'string' && (WEEKDAYS as readonly string[]).includes(r.day)
        ? (r.day as Weekday)
        : 'mon'
    } else if (cadence === 'monthly') {
      const n = typeof r.day === 'number' ? Math.floor(r.day) : 1
      // Capped at 28 so every month actually contains the day — a report set
      // for the 31st would silently skip February and the 30-day months.
      day = Math.min(28, Math.max(1, Number.isFinite(n) ? n : 1))
    }

    const deliveryRaw = (r.delivery ?? {}) as Record<string, unknown>
    const email = Array.isArray(deliveryRaw.email)
      ? deliveryRaw.email
          .filter((e): e is string => typeof e === 'string' && !!e.trim())
          .map(e => e.trim().slice(0, 200))
          .slice(0, 25)
      : []
    const chatSpaceId =
      typeof deliveryRaw.chatSpaceId === 'string' && deliveryRaw.chatSpaceId.trim()
        ? deliveryRaw.chatSpaceId.trim().slice(0, 120)
        : undefined

    seen.add(id)
    out.push({
      id,
      kind,
      cadence,
      day,
      hourLocal,
      delivery: { email, ...(chatSpaceId ? { chatSpaceId } : {}) },
      enabled: r.enabled !== false,
    })
  }

  return out
}

/**
 * The tenant-local wall-clock fields for an instant.
 *
 * Uses Intl rather than manual offset arithmetic so daylight-saving transitions
 * are handled by the platform's timezone database. Getting this wrong would
 * shift every report by an hour for half the year.
 *
 * Falls back to UTC for an unrecognized timezone rather than throwing — a typo
 * in a settings field must not stop the runner.
 */
export function localParts(
  now: Date,
  timeZone: string | undefined,
): { hour: number; weekday: Weekday; dayOfMonth: number } {
  let parts: Intl.DateTimeFormatPart[]
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timeZone || 'UTC',
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
      day: 'numeric',
    }).formatToParts(now)
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: 'numeric',
      hour12: false,
      weekday: 'short',
      day: 'numeric',
    }).formatToParts(now)
  }

  const get = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  // "24" appears for midnight in some hour12:false implementations.
  const hour = parseInt(get('hour'), 10) % 24
  const weekday = get('weekday').toLowerCase().slice(0, 3) as Weekday
  const dayOfMonth = parseInt(get('day'), 10)

  return { hour: Number.isFinite(hour) ? hour : 0, weekday, dayOfMonth }
}

/**
 * Is this report due in the hour containing `now`?
 *
 * Called once per hourly firing. Matching on the HOUR (not the minute) is what
 * makes the poll robust: Cloud Scheduler firing at :00:03 or :00:47 must
 * produce the same answer, or a report would randomly skip.
 */
export function isDue(report: ReportConfig, now: Date, timeZone?: string): boolean {
  if (!report.enabled) return false

  const { hour, weekday, dayOfMonth } = localParts(now, timeZone)
  if (hour !== report.hourLocal) return false

  switch (report.cadence) {
    case 'daily':
      return true
    case 'weekly':
      return weekday === report.day
    case 'monthly':
      return dayOfMonth === report.day
  }
}

/** Reports due right now, in config order. */
export function dueReports(reports: ReportConfig[], now: Date, timeZone?: string): ReportConfig[] {
  return reports.filter(r => isDue(r, now, timeZone))
}

/**
 * The tenant-local calendar date for an instant, as YYYY-MM-DD.
 *
 * `en-CA` formats as YYYY-MM-DD natively, so no reassembly is needed. Falls
 * back to UTC for an unrecognized timezone, matching `localParts`.
 */
export function localDateString(now: Date, timeZone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', ...opts }).format(now)
  } catch {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', ...opts }).format(now)
  }
}

/**
 * The reporting window a run covers, as ISO dates.
 *
 * Ends YESTERDAY, not today: analytics for the current day are partial, and a
 * "last week" digest that silently includes six and a half days understates
 * every figure in it.
 *
 * ── Why this takes a timezone ──
 * It used to derive the window from UTC calendar dates while `isDue` decided
 * due-ness in the tenant's LOCAL timezone — two different clocks in one run. At
 * offsets of UTC+8 or further east the seeded Mon 07:00 digest fires at 22:00Z
 * the previous UTC day, so every window landed a full day behind the "ends
 * yesterday" contract, permanently and silently. Anchoring the window to the
 * same local calendar date `isDue` matched keeps the two in agreement.
 */
export function reportWindow(
  cadence: ReportCadence,
  now: Date,
  timeZone?: string,
): { startDate: string; endDate: string } {
  // Anchor to the tenant's local calendar day, then do plain date arithmetic on
  // a UTC-anchored instant — only whole calendar dates matter from here, so the
  // anchor's offset is irrelevant and DST cannot shift the result.
  const end = new Date(`${localDateString(now, timeZone)}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() - 1)

  const start = new Date(end)
  const span = cadence === 'daily' ? 0 : cadence === 'weekly' ? 6 : 29
  start.setUTCDate(start.getUTCDate() - span)

  return { startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10) }
}
