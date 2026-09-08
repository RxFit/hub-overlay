import { lt } from 'drizzle-orm'
import { db } from '@/lib/db'
import { aiActionLog, aiRuns, toolRuns } from '@/lib/schema'
import { pruneExpiredMemories, pruneOldEventLogs } from '@/lib/agent-memory'
import { getTenantId } from '@/lib/tenant-context'
import { createLogger } from '@/lib/logger'
import { toFault } from '@/lib/fault'
import { reportFault } from '@/lib/fault-report'

/**
 * Data retention for the app's append-only ledgers
 * (ERROR_REPORTING_2026-08-24.md §8 "Volume control" Retention row :938,
 * §11 "The phased plan" Phase 2 :1122, and the
 * HARDENING_REVIEW_2026-08-20.md:119 open item this closes).
 *
 * WHAT IS DELETED, AND WHY 90 DAYS:
 *  - `ai_runs`, `ai_action_log`, `tool_runs` had ZERO retention before this
 *    module: nothing anywhere deleted a row from any of them, so each grew
 *    without bound from the day it was created. All three are provenance
 *    ledgers (engine/model/status/latency/usage, action targets, run
 *    outcomes) whose read surfaces — dispatch-health, ai-health, the alert
 *    tick's streak/collapse queries — look at the newest rows or the last
 *    24h. 90 days ("pruneOldAiRuns(90d)", spec §3 Layer 7 :293 and §11
 *    Phase 2 :1122) keeps a full quarter for spend and failure-class trend
 *    reads while bounding the tables.
 *  - `event_log` (30 days, pruneOldEventLogs) and per-agent TTL'd
 *    `agent_memory` rows (pruneExpiredMemories) — both moved here from
 *    app/api/kpis/sync/route.ts, where they only ran when someone clicked
 *    the settings-page sync button (spec §2.3 "Retention is welded to a
 *    user-triggered button").
 *
 * WHAT IS DELIBERATELY NOT DELETED HERE:
 *  - `dispatch_jobs` — lib/dispatch-store.ts's sweepStale already scrubs
 *    content after 10 minutes and hard-deletes rows after ROW_TTL_DAYS (7),
 *    under its own advisory lock, from the same hourly tick. Two deleters on
 *    one table would race the lock discipline that sweep was given for a
 *    reason.
 *  - `ai_runs` rows are the durable record dispatch_jobs points at ("ai_runs
 *    is the durable record", dispatch-store.ts:50); 90 days ≫ 7 days, so a
 *    job row can never outlive the run it references.
 *
 * SEQUENTIAL AND INDEPENDENT: the three deletes run one after another, and
 * a failure on one does not stop the next. Sequential because two of the
 * three scan: only `ai_runs` has a bare created_at index
 * (`ai_runs_created_idx`, lib/schema.ts:439); `ai_action_log` and
 * `tool_runs` carry only (user_email, created_at desc) composites
 * (lib/schema.ts:350, :578), whose leading column a `created_at < cutoff`
 * predicate cannot use — running those concurrently on one pool would just
 * contend, and one-at-a-time keeps failure attribution to a single table.
 * Independent because the whole reason this module exists is rows that
 * never get deleted: if the first
 * table's delete threw and short-circuited the rest, the other two ledgers
 * would silently return to zero retention. Failures are collected and
 * rethrown ONCE, after all three ran, as an AggregateError-shaped error whose
 * message names the failed tables.
 *
 * WHY A FAILED PRUNE IS A `degraded` FAULT AND NOT A swallow():
 * runRetention never rejects — the alert tick must proceed to evaluation no
 * matter what housekeeping did — but a retention failure is not the benign
 * kind of failure swallow() is for. A prune that fails every hour for a
 * month is exactly the immortal-rows problem the spec names, and a debug
 * line nobody grepped is how it stays invisible. reportFault() puts one
 * WARNING-severity line in Cloud Error Reporting per failing prune per tick
 * (bucketed by fingerprint, so a persistent failure is throttled, not a
 * storm) and a row in event_log's fault ledger, which is what the fault
 * digest surfaces. `degraded` because nothing the user asked for is lost —
 * the app serves fine with an oversized table — but the operator must hear
 * about it before the disk does.
 *
 * WHY layer 'cron': the FaultLayer names WHICH MECHANISM caught the fault.
 * This code has no request, no route, no job id and no stream; it runs
 * because the GitHub Actions hourly schedule curled the cron route. A
 * fault from here that carried layer 'route' would fingerprint and group
 * with request-path failures it has nothing to do with.
 */

const DAY_MS = 24 * 60 * 60 * 1000

export interface AiRunsPruneCounts {
  aiRuns: number
  aiActionLog: number
  toolRuns: number
}

/**
 * Bounded deletes on the three AI ledgers: `WHERE created_at < now - days`.
 * Returns the per-table deleted counts. Rejects only after every table has
 * been attempted (see the module header), with an error naming the tables
 * that failed and carrying their causes in `errors`.
 */
export async function pruneOldAiRuns(days = 90): Promise<AiRunsPruneCounts> {
  const cutoff = new Date(Date.now() - days * DAY_MS)
  const counts: AiRunsPruneCounts = { aiRuns: 0, aiActionLog: 0, toolRuns: 0 }
  const failures: Array<{ table: string; err: unknown }> = []

  // Typed as the three drizzle table objects rather than a loop over
  // `keyof AiRunsPruneCounts` so each delete keeps its concrete column type;
  // the order is the order the tables were created in (oldest ledger first).
  const steps = [
    { key: 'aiRuns' as const, table: 'ai_runs', run: () => db.delete(aiRuns).where(lt(aiRuns.createdAt, cutoff)) },
    { key: 'aiActionLog' as const, table: 'ai_action_log', run: () => db.delete(aiActionLog).where(lt(aiActionLog.createdAt, cutoff)) },
    { key: 'toolRuns' as const, table: 'tool_runs', run: () => db.delete(toolRuns).where(lt(toolRuns.createdAt, cutoff)) },
  ]

  for (const step of steps) {
    try {
      // postgres-js returns the affected-row count as `count` (see
      // pruneOldEventLogs) — not the node-pg `rowCount`.
      const result = await step.run()
      counts[step.key] = result.count
    } catch (err) {
      failures.push({ table: step.table, err })
    }
  }

  if (failures.length) {
    // AggregateError-shaped by hand: `AggregateError` itself is ES2021 and
    // tsconfig targets es2018, and the message must name the tables so the
    // fault record (which scrubs and truncates free text) still says which
    // ledger is regrowing without anyone opening `errors`.
    // The first cause rides `cause` so the fault's causeChain carries the
    // driver's actual reason (e.g. a missing table after a partial migration).
    const error = new Error(
      `pruneOldAiRuns: ${failures.length} of ${steps.length} deletes failed (${failures.map((f) => f.table).join(', ')})`,
      { cause: failures[0].err },
    ) as Error & { errors: unknown[]; tables: string[] }
    error.name = 'RetentionError'
    error.errors = failures.map((f) => f.err)
    error.tables = failures.map((f) => f.table)
    throw error
  }

  return counts
}

export interface RetentionSummary {
  /** Rows deleted per ledger; a prune that failed reports null. */
  eventLog: number | null
  aiRuns: AiRunsPruneCounts | null
  /** pruneExpiredMemories returns void — true means it ran to completion. */
  expiredMemories: boolean
  /** Which prunes failed this run (each already reported as a fault). */
  failed: Array<'pruneExpiredMemories' | 'pruneOldEventLogs' | 'pruneOldAiRuns'>
}

/**
 * The hourly-tick entry point (defaultAlertTickDeps.housekeep in
 * lib/dispatch-alerts.ts). Runs each prune in its own try/catch, reports each
 * failure as ONE degraded fault, and NEVER rejects — housekeeping must not
 * take the alert path down with it (spec §3 Layer 7 :291: "a tick that
 * times out takes the alert path down with it, which is the one path that
 * must never fail quietly"). Never rejecting does NOT cover a timeout: three
 * of the four deletes this runs scan (event_log, ai_action_log, tool_runs —
 * see the index notes above and in pruneOldEventLogs), which is why spec
 * :291-292 requires the tick's budget be raised BEFORE housekeeping grows.
 * It was, in the same change: maxDuration 300 in
 * app/api/cron/dispatch-alert/route.ts and --max-time 300 in
 * .github/workflows/dispatch-alert.yml — the Cloud Run platform ceiling, so
 * anything slower than that needs the spec's other option, a second tick.
 * Counts are logged at info so a healthy run is visible too.
 */
export async function runRetention(): Promise<RetentionSummary> {
  const log = createLogger('retention')
  const summary: RetentionSummary = { eventLog: null, aiRuns: null, expiredMemories: false, failed: [] }

  const report = (op: RetentionSummary['failed'][number], err: unknown) => {
    summary.failed.push(op)
    log.error({ err, op }, 'retention prune failed')
    try {
      // toFault scrubs the message; the context carries only the op name — no
      // row content, no tenant, nothing from the tables themselves. `op` is
      // on lib/fault.ts's ALLOWED_CONTEXT_KEYS (a code-chosen identifier),
      // so the record says WHICH prune failed, not just that one did.
      reportFault(
        toFault(err, { layer: 'cron', module: 'retention', severity: 'degraded', context: { op } }),
        { rawStack: err instanceof Error ? err.stack : null },
      )
    } catch (reporterErr) {
      // reportFault never throws by contract; toFault is pure but not
      // infallible. Neither may convert "a prune failed" into "the tick
      // rejected" — the log.error above already carries the failure.
      log.error({ err: reporterErr, op }, 'retention fault report failed')
    }
  }

  // Still tenant-scoped (per-agent TTL rows are a tenant's own data and the
  // TTL is set by the tenant's agents); getTenantId() is the same single-
  // tenant resolution the kpis/sync caller used.
  try {
    await pruneExpiredMemories(getTenantId())
    summary.expiredMemories = true
  } catch (err) {
    report('pruneExpiredMemories', err)
  }

  try {
    summary.eventLog = await pruneOldEventLogs()
  } catch (err) {
    report('pruneOldEventLogs', err)
  }

  try {
    summary.aiRuns = await pruneOldAiRuns()
  } catch (err) {
    report('pruneOldAiRuns', err)
  }

  log.info(
    {
      eventLog: summary.eventLog,
      aiRuns: summary.aiRuns?.aiRuns ?? null,
      aiActionLog: summary.aiRuns?.aiActionLog ?? null,
      toolRuns: summary.aiRuns?.toolRuns ?? null,
      expiredMemories: summary.expiredMemories,
      failed: summary.failed,
    },
    'retention tick complete',
  )
  return summary
}
