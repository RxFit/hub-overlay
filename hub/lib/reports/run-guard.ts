import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from '../db'
import { reportRuns } from '../schema'

/**
 * lib/reports/run-guard.ts — "has this reporting window already been done?"
 *
 * The scheduled runner decides due-ness from the wall clock, which leaves two
 * holes this module closes (both found on the live system, 2026-08-27):
 *
 *  1. DUPLICATES. A manual workflow dispatch or a job re-run inside a due hour
 *     regenerated the report: a second Drive artifact and a second email/Chat
 *     post, because nothing recorded that the window had run.
 *  2. MISSES. GitHub's scheduled workflows are best-effort and were observed
 *     dropping hourly firings for 2–10 hours. Against an "is it due in THIS
 *     hour?" runner, a dropped 07:00 firing means the weekly digest is never
 *     produced at all.
 *
 * The claim is an INSERT ... ON CONFLICT DO NOTHING against the unique index
 * (tenant_id, report_id, window_start). Doing it BEFORE generation is what
 * makes it correct under concurrency: two simultaneous callers both attempt
 * the insert, exactly one gets a row back, and only that one generates. An
 * after-the-fact "did it already run?" SELECT would leave the classic
 * check-then-act race wide open.
 *
 * FAILURE POLICY: a claim whose generation then fails is RELEASED, so the next
 * tick retries the window rather than the failure burning it for good. The
 * cost is a narrow window where a crashed instance leaves a claim behind and
 * that window is skipped for the day — the same trade the dispatch queue makes
 * with leases, and preferable to a silent permanent skip on any transient
 * Google error.
 */

export interface ReportWindowClaim {
  tenantId: string
  reportId: string
  windowStart: string
  windowEnd?: string
}

/**
 * Try to claim a reporting window. Returns true when THIS caller won the claim
 * and should generate; false when the window was already claimed or completed
 * (by an earlier tick, or by a concurrent one).
 *
 * Throws only on a real database failure. The caller treats a throw as "do not
 * generate": generating without a claim is the duplicate this module exists to
 * prevent, so failing closed is correct here even though it may delay a report.
 */
export async function claimReportWindow(claim: ReportWindowClaim): Promise<boolean> {
  const rows = await db
    .insert(reportRuns)
    .values({
      tenantId: claim.tenantId,
      reportId: claim.reportId,
      windowStart: claim.windowStart,
      windowEnd: claim.windowEnd ?? null,
    })
    .onConflictDoNothing({
      target: [reportRuns.tenantId, reportRuns.reportId, reportRuns.windowStart],
    })
    .returning({ id: reportRuns.id })

  return rows.length > 0
}

/** Key for the already-claimed set. NUL-joined so no report id or date can
 *  forge a collision with another pair. */
export function windowKey(reportId: string, windowStart: string): string {
  return `${reportId}\u0000${windowStart}`
}

/**
 * Which of these (report, window) pairs are ALREADY claimed or completed.
 *
 * A read-only pre-check, and deliberately NOT the safety mechanism: the
 * atomic claim above is what prevents duplicates. This exists so the runner
 * can answer "is there anything to do this tick?" BEFORE minting a Google
 * access token. Catch-up makes the do-nothing tick the common case — a report
 * generated at 07:00 is re-offered every hour for the rest of the day — and
 * without this the route would refresh OAuth on every one of them, turning a
 * transient token-refresh failure into a 409 and a false alert about a report
 * that was already delivered.
 *
 * A read failure is the caller's to interpret: proceeding is safe, because the
 * claim still decides.
 */
export async function findClaimedWindows(
  tenantId: string,
  candidates: Array<{ reportId: string; windowStart: string }>,
): Promise<Set<string>> {
  if (!candidates.length) return new Set()

  const rows = await db
    .select({ reportId: reportRuns.reportId, windowStart: reportRuns.windowStart })
    .from(reportRuns)
    .where(and(
      eq(reportRuns.tenantId, tenantId),
      inArray(reportRuns.reportId, candidates.map(c => c.reportId)),
      inArray(reportRuns.windowStart, candidates.map(c => c.windowStart)),
    ))

  // The two IN lists can cross-match (report A's window paired with report B's),
  // so intersect against the requested pairs rather than trusting the rows.
  const requested = new Set(candidates.map(c => windowKey(c.reportId, c.windowStart)))
  const claimed = new Set<string>()
  for (const row of rows) {
    const key = windowKey(row.reportId, row.windowStart)
    if (requested.has(key)) claimed.add(key)
  }
  return claimed
}

/**
 * Release a claim whose generation failed, so a later tick can retry the same
 * window. Best-effort: a failure to release must not mask the generation error
 * the caller is already reporting.
 */
export async function releaseReportWindow(claim: ReportWindowClaim): Promise<void> {
  try {
    await db
      .delete(reportRuns)
      .where(and(
        eq(reportRuns.tenantId, claim.tenantId),
        eq(reportRuns.reportId, claim.reportId),
        eq(reportRuns.windowStart, claim.windowStart),
        // Only release a claim that never completed. A row carrying a
        // document_id is a successful run's record and must survive.
        sql`document_id IS NULL`,
      ))
  } catch (err) {
    console.error(
      '[reports] failed to release window claim',
      claim.reportId,
      claim.windowStart,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Mark a claimed window as completed, recording the artifact it produced.
 *  Best-effort: the report exists in Drive either way, and the claim already
 *  prevents regeneration — this only enriches the ledger. */
export async function completeReportWindow(
  claim: ReportWindowClaim,
  documentId: string,
): Promise<void> {
  try {
    await db
      .update(reportRuns)
      .set({ documentId })
      .where(and(
        eq(reportRuns.tenantId, claim.tenantId),
        eq(reportRuns.reportId, claim.reportId),
        eq(reportRuns.windowStart, claim.windowStart),
      ))
  } catch (err) {
    console.error(
      '[reports] failed to record window completion',
      claim.reportId,
      claim.windowStart,
      err instanceof Error ? err.message : err,
    )
  }
}

/** Retention: the ledger only needs to answer "did this window run?" for
 *  windows still reachable by catch-up (same local day). A year is kept for
 *  operator readability — "when did the March digest go out?" — and trimmed
 *  beyond that. Best-effort, never throws into the runner. */
export async function pruneReportRuns(olderThanDays = 365): Promise<void> {
  try {
    await db
      .delete(reportRuns)
      .where(lt(reportRuns.createdAt, new Date(Date.now() - olderThanDays * 86_400_000)))
  } catch {
    /* retention is housekeeping — never fail a report run over it */
  }
}
