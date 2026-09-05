import { and, desc, eq, gt, lt, sql } from 'drizzle-orm'
import { db, withTransaction } from '@/lib/db'
import { toolRuns } from '@/lib/schema'

/**
 * lib/tool-runs.ts — the deep lane's durable product store
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4, PR B).
 *
 * Owns every read/write of `tool_runs` so the dispatch store, the deep-runs
 * routes, and tests share one contract:
 *
 *  - `status` holds enqueue + TERMINAL states only (queued | succeeded |
 *    failed | cancelled). The live "running" presentation is derived by the
 *    reader from the dispatch job — the queue owns execution state, this
 *    table owns the product.
 *  - Every terminal transition is a guarded CAS from 'queued'
 *    (WHERE status = 'queued'), so a user cancel racing a worker result
 *    lands exactly one terminal state and the loser no-ops.
 *  - Reads are TENANT + OWNER scoped at this layer, not in routes, so a
 *    route cannot forget either half of the workspace boundary.
 */

export type ToolRunStatus = 'queued' | 'succeeded' | 'failed' | 'cancelled'

export interface ToolRunRecord {
  id: string
  tool: string
  status: ToolRunStatus
  brief: string
  inputs?: { id: string; title: string; toolId: string }[]
  resultMd: string | null
  errorClass: string | null
  error: string | null
  userEmail: string
  chatId: string | null
  jobId: string | null
  attempt: number
  model: string | null
  latencyMs: number | null
  usage: Record<string, number> | null
  createdAt: string
  finishedAt: string | null
  /** The run this one re-ran (needs-you Retry), else null. */
  retryOf: string | null
}

/** Zombie guard for the per-tenant-user cap: a 'queued' row older than this no
 *  longer counts as active (its job long since expired or never existed). */
export const ACTIVE_WINDOW_MS = 60 * 60_000

function iso(v: Date | string | null): string | null {
  if (v === null) return null
  return v instanceof Date ? v.toISOString() : String(v)
}

function toRecord(r: typeof toolRuns.$inferSelect): ToolRunRecord {
  return {
    id: r.id,
    tool: r.tool,
    status: r.status as ToolRunStatus,
    brief: r.brief,
    inputs: (r.inputs as { id: string; title: string; toolId: string }[]) ?? undefined,
    resultMd: r.resultMd ?? null,
    errorClass: r.errorClass ?? null,
    error: r.error ?? null,
    userEmail: r.userEmail,
    chatId: r.chatId ?? null,
    jobId: r.jobId ?? null,
    attempt: r.attempt,
    model: r.model ?? null,
    latencyMs: r.latencyMs ?? null,
    usage: (r.usage as Record<string, number> | null) ?? null,
    createdAt: iso(r.createdAt) as string,
    finishedAt: iso(r.finishedAt),
    retryOf: r.retryOf ?? null,
  }
}

export interface CreateToolRunInput {
  /** Minted by the caller. The row is created BEFORE the dispatch enqueue
   *  (row-first ordering): a fast worker can otherwise claim, run, and post
   *  the result before the product row exists, and the landing CAS would
   *  no-op — losing the report. Row-first means landing always finds its
   *  row; a crash between the two writes leaves a jobless 'queued' row that
   *  expireStaleToolRuns retires. */
  id: string
  tool: string
  brief: string
  inputs?: { id: string; title: string; toolId: string }[]
  tenantId: string
  userEmail: string
  chatId?: string | null
  /** Set when this run is a needs-you Retry of an earlier run. */
  retryOf?: string | null
  /** Attached after the enqueue via attachToolRunJob. */
  jobId?: string | null
}

/** Postgres unique-violation on the one-active-run-per-tenant-user partial index
 *  (tool_runs_one_active_per_user, drizzle/migrate.mjs). Drizzle wraps the
 *  PostgresError in a DrizzleQueryError, so the SQLSTATE may sit on the
 *  error itself OR on its `cause` — check both. */
export function isActiveRunConflict(err: unknown): boolean {
  const direct = (err as { code?: string } | null)?.code
  const caused = (err as { cause?: { code?: string } } | null)?.cause?.code
  return direct === '23505' || caused === '23505'
}

export async function createToolRun(input: CreateToolRunInput): Promise<void> {
  await db.insert(toolRuns).values({
    id: input.id,
    tool: input.tool,
    brief: input.brief,
    inputs: input.inputs ? input.inputs : null,
    tenantId: input.tenantId,
    userEmail: input.userEmail.toLowerCase().trim(),
    chatId: input.chatId ?? null,
    jobId: input.jobId ?? null,
    retryOf: input.retryOf ?? null,
  })
}

export async function attachToolRunJob(id: string, jobId: string): Promise<void> {
  await db
    .update(toolRuns)
    .set({ jobId, updatedAt: new Date() })
    .where(eq(toolRuns.id, id))
}

/**
 * Retire this user's zombie rows — 'queued' long past any job's possible
 * lifetime (crash between row insert and enqueue, or a reap whose
 * tool_runs write failed). Terminal state instead of presentation-only
 * aging, so the one-active-run unique index can never deadlock a user on a
 * corpse. Called by the POST route before the cap check.
 */
export async function expireStaleToolRuns(tenantId: string, userEmail: string): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS)
  const rows = await db
    .update(toolRuns)
    .set({
      status: 'failed',
      errorClass: 'orphaned',
      error: 'run lost its engine job (expired while queued)',
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(toolRuns.tenantId, tenantId),
      eq(toolRuns.userEmail, userEmail.toLowerCase().trim()),
      eq(toolRuns.status, 'queued'),
      lt(toolRuns.createdAt, cutoff),
    ))
    .returning({ id: toolRuns.id })
  return rows.length
}

export async function getToolRunOwned(id: string, tenantId: string, userEmail: string): Promise<ToolRunRecord | null> {
  const rows = await db
    .select()
    .from(toolRuns)
    .where(and(
      eq(toolRuns.id, id),
      eq(toolRuns.tenantId, tenantId),
      eq(toolRuns.userEmail, userEmail.toLowerCase().trim()),
    ))
    .limit(1)
  return rows[0] ? toRecord(rows[0]) : null
}

export async function listToolRuns(
  tenantId: string,
  userEmail: string,
  opts: { tool?: string; limit: number },
): Promise<ToolRunRecord[]> {
  const conds = [
    eq(toolRuns.tenantId, tenantId),
    eq(toolRuns.userEmail, userEmail.toLowerCase().trim()),
  ]
  if (opts.tool) conds.push(eq(toolRuns.tool, opts.tool))
  const rows = await db
    .select()
    .from(toolRuns)
    .where(and(...conds))
    .orderBy(desc(toolRuns.createdAt))
    .limit(opts.limit)
  return rows.map(toRecord)
}

/** Active = still 'queued' AND recent enough that its job could be live. */
export async function countActiveToolRuns(tenantId: string, userEmail: string): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS)
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(toolRuns)
    .where(and(
      eq(toolRuns.tenantId, tenantId),
      eq(toolRuns.userEmail, userEmail.toLowerCase().trim()),
      eq(toolRuns.status, 'queued'),
      gt(toolRuns.createdAt, cutoff),
    ))
  return rows[0]?.n ?? 0
}

export type ToolRunTerminal =
  | { status: 'succeeded'; resultMd: string; model?: string | null; latencyMs?: number | null; usage?: Record<string, number> | null; attempt?: number }
  | { status: 'failed' | 'cancelled'; errorClass?: string | null; error?: string | null; model?: string | null; latencyMs?: number | null; attempt?: number }

/** What landing returns to the caller so it can run side effects (ledger
 *  attribution, the PR-D chat pointer) without re-reading the row. */
export interface LandedToolRun {
  id: string
  tool: string
  tenantId: string
  userEmail: string
  chatId: string | null
}

/**
 * The guarded terminal CAS, generic over db/tx so dispatch-store can land a
 * result INSIDE the postResult transaction (atomic with the queue's own
 * terminal transition) while the cancel route uses the plain connection.
 * Returns the landed identity, or null when the row was missing or already
 * terminal (the race loser's no-op).
 */
export async function finishToolRun(
  exec: Pick<typeof db, 'update'>,
  id: string,
  terminal: ToolRunTerminal,
): Promise<LandedToolRun | null> {
  const now = new Date()
  const rows = await exec
    .update(toolRuns)
    .set({
      status: terminal.status,
      resultMd: terminal.status === 'succeeded' ? terminal.resultMd : null,
      errorClass: terminal.status === 'succeeded' ? null : (terminal.errorClass ?? null),
      error: terminal.status === 'succeeded' ? null : (terminal.error ?? null),
      model: terminal.model ?? null,
      latencyMs: terminal.latencyMs ?? null,
      usage: terminal.status === 'succeeded' ? (terminal.usage ?? null) : null,
      attempt: terminal.attempt ?? 0,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(eq(toolRuns.id, id), eq(toolRuns.status, 'queued')))
    .returning({
      id: toolRuns.id,
      tool: toolRuns.tool,
      tenantId: toolRuns.tenantId,
      userEmail: toolRuns.userEmail,
      chatId: toolRuns.chatId,
    })
  const row = rows[0]
  return row ? { id: row.id, tool: row.tool, tenantId: row.tenantId, userEmail: row.userEmail, chatId: row.chatId } : null
}

/**
 * User-initiated cancel: mark the run cancelled immediately (the user's
 * intent is now, not at the worker's next heartbeat). Returns the jobId to
 * cancel in the queue, or null when the run wasn't the caller's or had
 * already gone terminal.
 */
export async function cancelToolRun(id: string, tenantId: string, userEmail: string): Promise<string | null> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ jobId: toolRuns.jobId, status: toolRuns.status })
      .from(toolRuns)
      .where(and(
        eq(toolRuns.id, id),
        eq(toolRuns.tenantId, tenantId),
        eq(toolRuns.userEmail, userEmail.toLowerCase().trim()),
      ))
      .limit(1)
      .for('update')
    const row = rows[0]
    if (!row || row.status !== 'queued') return null
    await finishToolRun(tx, id, { status: 'cancelled', errorClass: 'abort', error: 'cancelled by the user' })
    return row.jobId
  })
}
