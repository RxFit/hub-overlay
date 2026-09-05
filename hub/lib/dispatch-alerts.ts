import { and, desc, eq, gte, inArray, ne, or, isNull, sql } from 'drizzle-orm'
import { db } from './db'
import { aiRuns, eventLog, googlePrefs, hubUsers } from './schema'
import { getTenantId } from './tenant-context'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from './agy-dispatch'
import { isMissingTableError, listWorkers, reapExpired, sweepStale } from './dispatch-store'
import { resolveTenantToken } from './reports/access-token'
import { normalizeReports } from './reports/config'
import { sendChatMessage } from './google'
import { tagHubChatPost } from './chat-post-tag'
import { swallow } from '@/lib/swallow'

/**
 * Push alerting for the desktop-dispatch system (hardening move 1,
 * HARDENING_REVIEW_2026-08-20 § "Make failure push, not pull").
 *
 * The never-stall ladder means every dispatch failure degrades silently into
 * metered spend; before this module the only guaranteed failure detector was
 * the monthly bill. An hourly cron (.github/workflows/dispatch-alert.yml →
 * POST /api/cron/dispatch-alert) evaluates three conditions from data the Hub
 * already has and PUSHES to the operator instead of waiting to be asked:
 *
 *  - worker_stale       dispatch is enabled but no worker has phoned home
 *  - agy_error_streak   the newest agy runs in the ledger are all failures
 *                       (client aborts excluded — a closed tab is not an
 *                       engine failure). Deliberately NOT time-windowed: a
 *                       streak clears only when a newer run SUCCEEDS, never
 *                       by the evidence aging out over a quiet weekend.
 *  - allotment_collapse chat served metered with zero allotment wins in 24h
 *                       (inert until move 3 ledgers the metered chains — the
 *                       condition needs metered rows to count)
 *
 * Delivery is Google Chat via the operator-token path scheduled reports
 * already use, tagged with the pinned `— via HUB` literal. When no Chat space
 * is resolvable the caller (the GitHub Actions workflow) fails its run
 * instead, so GitHub's failure email becomes the fallback push path — a
 * completely dark Hub still reaches the operator.
 *
 * Alert state is DURABLE (event_log rows, eventType 'dispatch.alert'), never
 * in-memory: the Hub runs 1–3 instances and in-memory dedup is a documented
 * residual class in this repo. Posting discipline:
 *  - a condition set posts when it first appears and re-posts every REALERT_MS
 *    while it stands;
 *  - the re-alert window keys off the last DELIVERED post of the same
 *    fingerprint, so a flapping condition (worker stale ↔ fresh each hour)
 *    damps to one alert per window instead of posting on every flip;
 *  - recovery posts once, and only when the clear is affirmative — a
 *    windowed condition whose evidence merely aged out records the state
 *    change silently rather than announcing a fix that never happened.
 */

export type DispatchAlertKind =
  | 'worker_stale'
  | 'tables_missing'
  | 'agy_error_streak'
  | 'allotment_collapse'

export interface DispatchAlert {
  kind: DispatchAlertKind
  /** Human-readable, content-free detail (classes + counts, never model output). */
  detail: string
}

/** Re-alert an unchanged condition set at most this often. */
export const REALERT_MS = 6 * 60 * 60 * 1000

/** How many newest agy runs must ALL be errors to call it a streak. */
export const STREAK_N = 3

/** Metered chat successes in 24h needed before "collapse" can fire. */
export const COLLAPSE_MIN_METERED = 3

export const DISPATCH_ALERT_EVENT = 'dispatch.alert'

/** Everything `decideAlerts` needs, gathered by `loadAlertSnapshot`. */
export interface AlertSnapshot {
  dispatchEnabled: boolean
  workerSecretPresent: boolean
  tablesReady: boolean
  freshWorkerCount: number
  /** Milliseconds since ANY worker last phoned home; null = never seen. */
  workerLastSeenMsAgo: number | null
  /** Newest-first agy runs (aborts excluded), capped at STREAK_N. Unwindowed
   *  on purpose — see the module header. */
  recentAgyRuns: Array<{ status: string; errorClass: string | null }>
  /** Chat-source ledger counts over the last 24h. */
  chat24h: { agyOk: number; agyError: number; meteredOk: number }
}

/** Error classes are typed Hub-side but the union is open and worker-adjacent;
 *  clamp anything unexpected before it reaches a Chat message or a log. */
function sanitizeClass(k: string | null): string {
  const clean = (k ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32)
  return clean || 'unknown'
}

/** PURE: snapshot → active alert conditions. Unit-tested in isolation. */
export function decideAlerts(s: AlertSnapshot): DispatchAlert[] {
  const alerts: DispatchAlert[] = []

  // Worker liveness only matters while dispatch is the configured transport;
  // with the flag off (kill switch) an absent worker is the expected state.
  if (s.dispatchEnabled && s.workerSecretPresent) {
    if (!s.tablesReady) {
      alerts.push({
        kind: 'tables_missing',
        detail: 'dispatch tables are missing — the migration has not run; every chat turn is riding the metered chain',
      })
    } else if (s.freshWorkerCount === 0) {
      const ago =
        s.workerLastSeenMsAgo === null
          ? 'never seen'
          : `last seen ${Math.round(s.workerLastSeenMsAgo / 60_000)} min ago`
      alerts.push({
        kind: 'worker_stale',
        detail: `no desktop worker is fresh (${ago}) while dispatch is enabled — chat is silently riding the metered chain`,
      })
    }
  }

  if (s.recentAgyRuns.length >= STREAK_N && s.recentAgyRuns.every((r) => r.status === 'error')) {
    const counts = new Map<string, number>()
    for (const r of s.recentAgyRuns) {
      const k = sanitizeClass(r.errorClass)
      counts.set(k, (counts.get(k) ?? 0) + 1)
    }
    const classes = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, n]) => `${k}×${n}`)
      .join(', ')
    alerts.push({
      kind: 'agy_error_streak',
      detail: `the last ${s.recentAgyRuns.length} agy runs all failed (${classes})`,
    })
  }

  // Needs move 3 (metered-chain ledgering) to produce meteredOk rows; until
  // then this stays structurally inert and self-activates when move 3 ships.
  if (s.chat24h.meteredOk >= COLLAPSE_MIN_METERED && s.chat24h.agyOk === 0) {
    alerts.push({
      kind: 'allotment_collapse',
      detail: `last 24h of chat: ${s.chat24h.meteredOk} metered turns served, zero allotment successes (${s.chat24h.agyError} agy failures)`,
    })
  }

  return alerts
}

/** Stable identity of a condition set, for dedup across ticks. */
export function alertFingerprint(alerts: DispatchAlert[]): string {
  return alerts
    .map((a) => a.kind)
    .sort()
    .join(',')
}

export interface LastAlertState {
  fingerprint: string
  at: Date
  /** Where that state landed: 'chat' | 'github' | 'suppressed' | 'none'. */
  channel: string
}

export type PostingAction = 'alert' | 'alert_suppressed' | 'recovery' | 'recovery_silent' | 'none'

/**
 * PURE: should this tick push anything?
 *
 * `last` is the most recent durable state row; `lastPostedSameFpAt` is when
 * this exact fingerprint was last DELIVERED (chat/github — not a suppressed
 * record), which is what the re-alert window keys off. Keying the window off
 * deliveries (rather than the latest state row) is the flap damping: a
 * condition that clears and returns inside the window changes state each time
 * but only earns one delivered alert per REALERT_MS.
 */
export function decidePosting(
  alerts: DispatchAlert[],
  last: LastAlertState | null,
  lastPostedSameFpAt: Date | null,
  nowMs: number,
): PostingAction {
  const fp = alertFingerprint(alerts)
  if (fp) {
    const withinWindow = lastPostedSameFpAt !== null && nowMs - lastPostedSameFpAt.getTime() < REALERT_MS
    if (last && last.fingerprint === fp) {
      // Standing condition: quiet inside the window, re-deliver after it.
      return withinWindow ? 'none' : 'alert'
    }
    // State change into (or between) alerting sets: deliver, unless this
    // exact set was already delivered inside the window (a flap).
    return withinWindow ? 'alert_suppressed' : 'alert'
  }
  if (last && last.fingerprint !== '') {
    // A suppressed flap-alert never reached anyone — do not announce a
    // recovery for an alert nobody saw.
    return last.channel === 'suppressed' ? 'recovery_silent' : 'recovery'
  }
  return 'none'
}

/** PURE: the Chat message body (untagged — the poster applies `— via HUB`). */
export function formatAlertMessage(alerts: DispatchAlert[]): string {
  const lines = ['⚠️ Hub dispatch alert', ...alerts.map((a) => `• ${a.detail}`)]
  const base = process.env.NEXTAUTH_URL
  if (base) lines.push(`Details: ${base}/api/admin/dispatch-health`)
  return lines.join('\n')
}

export function formatRecoveryMessage(): string {
  return '✅ Hub dispatch recovered — previous alert conditions have cleared.'
}

/* ── I/O half: snapshot gathering, durable state, Chat delivery ─────────── */

export async function loadAlertSnapshot(now = new Date()): Promise<AlertSnapshot> {
  let tablesReady = true
  let freshWorkerCount = 0
  let workerLastSeenMsAgo: number | null = null
  try {
    const cutoff = now.getTime() - dispatchFreshMs()
    const workers = await listWorkers()
    freshWorkerCount = workers.filter((w) => w.lastSeenAt.getTime() > cutoff).length
    if (workers.length) {
      const newest = Math.max(...workers.map((w) => w.lastSeenAt.getTime()))
      workerLastSeenMsAgo = Math.max(0, now.getTime() - newest)
    }
  } catch (err) {
    if (!isMissingTableError(err)) throw err
    tablesReady = false
  }

  const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000)

  // No time window (see module header) and no 'abort' rows: an operator
  // closing the tab three times must not read as an engine failure streak.
  const recentAgyRuns = await db
    .select({ status: aiRuns.status, errorClass: aiRuns.errorClass })
    .from(aiRuns)
    .where(and(eq(aiRuns.engine, 'agy'), or(isNull(aiRuns.errorClass), ne(aiRuns.errorClass, 'abort'))))
    .orderBy(desc(aiRuns.createdAt))
    .limit(STREAK_N)

  const chatCounts = await db
    .select({ engine: aiRuns.engine, status: aiRuns.status, n: sql<number>`count(*)::int` })
    .from(aiRuns)
    .where(and(eq(aiRuns.source, 'chat'), gte(aiRuns.createdAt, dayAgo)))
    .groupBy(aiRuns.engine, aiRuns.status)

  const chat24h = { agyOk: 0, agyError: 0, meteredOk: 0 }
  for (const row of chatCounts) {
    if (row.engine === 'agy') {
      if (row.status === 'ok') chat24h.agyOk += row.n
      else chat24h.agyError += row.n
    } else if (row.status === 'ok') {
      chat24h.meteredOk += row.n
    }
  }

  return {
    dispatchEnabled: isDispatchEnabled(),
    workerSecretPresent: isDispatchConfigured(),
    tablesReady,
    freshWorkerCount,
    workerLastSeenMsAgo,
    recentAgyRuns,
    chat24h,
  }
}

/** One durable alert row as the needs-you queue reads it (Phase 4 PR 2). */
export interface DispatchAlertRow {
  id: string
  createdAt: Date
  /** Alert kinds in the set; empty for a recovery row. */
  kinds: string[]
  channel: string
}

/**
 * Recent dispatch alert state rows, newest first — the "alert/recovery
 * history" reader Phase 3 §2 named as missing. Content-free by construction
 * (the rows carry only fingerprint, channel, kinds).
 */
export async function listDispatchAlerts(tenantId: string, since: Date, limit: number): Promise<DispatchAlertRow[]> {
  const rows = await db
    .select({ id: eventLog.id, payload: eventLog.payload, createdAt: eventLog.createdAt })
    .from(eventLog)
    .where(and(
      eq(eventLog.tenantId, tenantId),
      eq(eventLog.eventType, DISPATCH_ALERT_EVENT),
      gte(eventLog.createdAt, since),
    ))
    .orderBy(desc(eventLog.createdAt))
    .limit(limit)
  return rows.map((row) => {
    const payload = row.payload as { kinds?: unknown; channel?: unknown } | null
    const kinds = Array.isArray(payload?.kinds)
      ? payload!.kinds.filter((k): k is string => typeof k === 'string').map((k) => k.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))
      : []
    return {
      id: row.id,
      createdAt: row.createdAt,
      kinds,
      channel: typeof payload?.channel === 'string' ? payload.channel : 'none',
    }
  })
}

/** One alert row by id, tenant-scoped — the needs-you Explain tap for an
 *  alert card (Phase 4 PR 2). Same content-free shape as the list reader. */
export async function getDispatchAlert(tenantId: string, id: string): Promise<DispatchAlertRow | null> {
  const [row] = await db
    .select({ id: eventLog.id, payload: eventLog.payload, createdAt: eventLog.createdAt })
    .from(eventLog)
    .where(and(eq(eventLog.tenantId, tenantId), eq(eventLog.id, id), eq(eventLog.eventType, DISPATCH_ALERT_EVENT)))
    .limit(1)
  if (!row) return null
  const payload = row.payload as { kinds?: unknown; channel?: unknown } | null
  const kinds = Array.isArray(payload?.kinds)
    ? payload!.kinds.filter((k): k is string => typeof k === 'string').map((k) => k.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32))
    : []
  return { id: row.id, createdAt: row.createdAt, kinds, channel: typeof payload?.channel === 'string' ? payload.channel : 'none' }
}

async function loadLastAlertState(tenantId: string): Promise<LastAlertState | null> {
  const [row] = await db
    .select({ payload: eventLog.payload, createdAt: eventLog.createdAt })
    .from(eventLog)
    .where(and(eq(eventLog.tenantId, tenantId), eq(eventLog.eventType, DISPATCH_ALERT_EVENT)))
    .orderBy(desc(eventLog.createdAt))
    .limit(1)
  if (!row) return null
  const payload = row.payload as { fingerprint?: unknown; channel?: unknown } | null
  return {
    fingerprint: typeof payload?.fingerprint === 'string' ? payload.fingerprint : '',
    at: row.createdAt,
    channel: typeof payload?.channel === 'string' ? payload.channel : 'none',
  }
}

/** When this fingerprint last actually REACHED someone (chat or the GitHub
 *  failure email) — the timestamp the flap-damping window keys off. */
async function loadLastPostedAt(tenantId: string, fingerprint: string): Promise<Date | null> {
  if (!fingerprint) return null
  const [row] = await db
    .select({ createdAt: eventLog.createdAt })
    .from(eventLog)
    .where(and(
      eq(eventLog.tenantId, tenantId),
      eq(eventLog.eventType, DISPATCH_ALERT_EVENT),
      sql`payload->>'fingerprint' = ${fingerprint}`,
      sql`payload->>'channel' IN ('chat', 'github')`,
    ))
    .orderBy(desc(eventLog.createdAt))
    .limit(1)
  return row?.createdAt ?? null
}

/** BEST-EFFORT, mirroring recordEvent: a failed state write must never fail
 *  the tick (or mislabel a Chat post that already went out). Degraded dedup
 *  just means the next tick re-delivers — noisy, visible, honest. */
async function recordAlertState(
  tenantId: string,
  fingerprint: string,
  channel: string,
  kinds: string[],
): Promise<void> {
  try {
    await db.insert(eventLog).values({
      tenantId,
      eventType: DISPATCH_ALERT_EVENT,
      actor: 'system:cron',
      payload: { fingerprint, channel, kinds },
    })
  } catch (err) {
    console.warn('[dispatch-alerts] failed to record alert state:', err instanceof Error ? err.message : err)
  }
}

/**
 * The Chat space alerts go to: ALERT_CHAT_SPACE env var when set, else the
 * first configured scheduled report that already posts to a space. Null means
 * no Chat channel — the workflow's failure email takes over.
 */
async function resolveAlertSpace(tenantId: string): Promise<string | null> {
  const fromEnv = process.env.ALERT_CHAT_SPACE?.trim()
  if (fromEnv) return fromEnv
  try {
    const [prefsRow] = await db
      .select({ reports: googlePrefs.reports })
      .from(googlePrefs)
      .where(eq(googlePrefs.tenantId, tenantId))
      .limit(1)
    for (const report of normalizeReports(prefsRow?.reports)) {
      if (report.delivery.chatSpaceId) return report.delivery.chatSpaceId
    }
  } catch {
    // Fall through — no space is a handled outcome, not an error.
  }
  return null
}

async function postToChat(tenantId: string, spaceId: string, text: string): Promise<boolean> {
  const admins = await db
    .select({ email: hubUsers.email })
    .from(hubUsers)
    .where(and(eq(hubUsers.tenantId, tenantId), inArray(hubUsers.role, ['admin', 'superadmin'])))
  // Union with SUPERADMIN_EMAILS: on a deployment where the operator's
  // hub_users row is missing or roleless, the stored refresh token can still
  // be found under the configured superadmin address.
  const candidates = new Set(admins.map((a) => a.email))
  for (const e of (process.env.SUPERADMIN_EMAILS ?? '').split(',')) {
    const email = e.trim()
    if (email) candidates.add(email)
  }
  const token = await resolveTenantToken(tenantId, [...candidates], [
    'https://www.googleapis.com/auth/chat.messages.create',
  ])
  if (!token) return false
  await sendChatMessage(token.accessToken, spaceId, tagHubChatPost(text))
  return true
}

/** What one tick did — the cron route's response body, and what the GitHub
 *  workflow branches on (`github` and `post_failed` fail the workflow run). */
export interface AlertTickResult {
  alerts: DispatchAlert[]
  delivery: 'posted' | 'recovery_posted' | 'suppressed' | 'github' | 'post_failed' | 'none'
  channel: string | null
}

/** I/O seams, injectable so the orchestration is unit-testable without a DB
 *  (same idiom as dispatch-worker's injectable config/fetch). */
export interface AlertTickDeps {
  housekeep: () => Promise<void>
  loadSnapshot: (now: Date) => Promise<AlertSnapshot>
  loadLastState: (tenantId: string) => Promise<LastAlertState | null>
  loadLastPostedAt: (tenantId: string, fingerprint: string) => Promise<Date | null>
  recordState: (tenantId: string, fingerprint: string, channel: string, kinds: string[]) => Promise<void>
  resolveSpace: (tenantId: string) => Promise<string | null>
  post: (tenantId: string, spaceId: string, text: string) => Promise<boolean>
}

export const defaultAlertTickDeps: AlertTickDeps = {
  // Guaranteed hourly reap + sweep: the 5%-probabilistic sweep starves at low
  // traffic (Soon-table item; the sweep itself is advisory-locked in
  // dispatch-store). Failures here must not block alerting.
  housekeep: async () => {
    await reapExpired().catch((err: unknown) => swallow(err, { module: 'dispatch-alerts', op: 'housekeepReapExpired' }))
    await sweepStale().catch((err: unknown) => swallow(err, { module: 'dispatch-alerts', op: 'housekeepSweepStale' }))
  },
  loadSnapshot: loadAlertSnapshot,
  loadLastState: loadLastAlertState,
  loadLastPostedAt,
  recordState: recordAlertState,
  resolveSpace: resolveAlertSpace,
  post: postToChat,
}

export async function runDispatchAlertTick(
  now = new Date(),
  deps: AlertTickDeps = defaultAlertTickDeps,
): Promise<AlertTickResult> {
  const tenantId = getTenantId()

  await deps.housekeep()

  const snapshot = await deps.loadSnapshot(now)
  const alerts = decideAlerts(snapshot)
  const fingerprint = alertFingerprint(alerts)
  const last = await deps.loadLastState(tenantId)
  const lastPostedAt = await deps.loadLastPostedAt(tenantId, fingerprint)
  const action = decidePosting(alerts, last, lastPostedAt, now.getTime())

  if (action === 'none') {
    return { alerts, delivery: fingerprint ? 'suppressed' : 'none', channel: null }
  }

  const kinds = alerts.map((a) => a.kind)

  if (action === 'alert_suppressed') {
    // Flap damping: the state change is recorded (so recovery logic stays
    // truthful) but this exact set was already delivered inside the window.
    await deps.recordState(tenantId, fingerprint, 'suppressed', kinds)
    return { alerts, delivery: 'suppressed', channel: null }
  }

  if (action === 'recovery' || action === 'recovery_silent') {
    // Affirmative-evidence gate: allotment_collapse is 24h-windowed, so it
    // can "clear" purely by the metered evidence aging out. Announce the
    // recovery only when an allotment success actually landed; otherwise
    // record the state change silently. (worker/tables are live checks and
    // the streak is unwindowed, so those clear affirmatively by construction.)
    const silently =
      action === 'recovery_silent' ||
      (last!.fingerprint.includes('allotment_collapse') && snapshot.chat24h.agyOk === 0)
    if (!silently) {
      const channel = await deps.resolveSpace(tenantId)
      if (channel) {
        try {
          const sent = await deps.post(tenantId, channel, formatRecoveryMessage())
          await deps.recordState(tenantId, '', sent ? 'chat' : 'none', [])
          return { alerts, delivery: sent ? 'recovery_posted' : 'none', channel }
        } catch {
          // Recovery is good news — never fail the workflow over it.
        }
      }
    }
    await deps.recordState(tenantId, '', 'none', [])
    return { alerts, delivery: 'none', channel: null }
  }

  const channel = await deps.resolveSpace(tenantId)
  if (!channel) {
    // No Chat channel: the caller (GitHub Actions) fails its run and GitHub's
    // failure email is the push. That delivery is deterministic given this
    // response, so it counts as delivered for dedup purposes.
    await deps.recordState(tenantId, fingerprint, 'github', kinds)
    return { alerts, delivery: 'github', channel: null }
  }

  let sent: boolean
  try {
    sent = await deps.post(tenantId, channel, formatAlertMessage(alerts))
  } catch {
    // Not recorded → the next tick retries; the workflow fails this run so
    // the operator still hears about it through GitHub.
    return { alerts, delivery: 'post_failed', channel }
  }
  if (!sent) return { alerts, delivery: 'post_failed', channel }
  // recordState is best-effort internally: a state-write hiccup after a
  // successful post must not report post_failed (that would double-post).
  await deps.recordState(tenantId, fingerprint, 'chat', kinds)
  return { alerts, delivery: 'posted', channel }
}
