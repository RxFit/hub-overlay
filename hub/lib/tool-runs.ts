import { and, desc, eq, gt, sql } from 'drizzle-orm'
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
 *  - Reads are OWNER-SCOPED by user_email at this layer, not in routes, so
 *    a route cannot forget the scope.
 */

export type ToolRunStatus = 'queued' | 'succeeded' | 'failed' | 'cancelled'

export interface ToolRunRecord {
  id: string
  tool: string
  status: ToolRunStatus
  brief: string
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
}

/** Zombie guard for the per-user cap: a 'queued' row older than this no
 *  longer counts as active (its job long since expired or never existed). */
const ACTIVE_WINDOW_MS = 60 * 60_000

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
  }
}

export interface CreateToolRunInput {
  /** Minted by the caller BEFORE the dispatch enqueue, so the job's
   *  payload_meta.toolRunId and this row agree even if the second write
   *  fails (an orphaned job no-ops at landing; an orphaned row ages out of
   *  the active window). */
  id: string
  tool: string
  brief: string
  userEmail: string
  chatId?: string | null
  jobId: string
}

export async function createToolRun(input: CreateToolRunInput): Promise<void> {
  await db.insert(toolRuns).values({
    id: input.id,
    tool: input.tool,
    brief: input.brief,
    userEmail: input.userEmail.toLowerCase().trim(),
    chatId: input.chatId ?? null,
    jobId: input.jobId,
  })
}

export async function getToolRunOwned(id: string, userEmail: string): Promise<ToolRunRecord | null> {
  const rows = await db
    .select()
    .from(toolRuns)
    .where(and(eq(toolRuns.id, id), eq(toolRuns.userEmail, userEmail.toLowerCase().trim())))
    .limit(1)
  return rows[0] ? toRecord(rows[0]) : null
}

export async function listToolRuns(
  userEmail: string,
  opts: { tool?: string; limit: number },
): Promise<ToolRunRecord[]> {
  const conds = [eq(toolRuns.userEmail, userEmail.toLowerCase().trim())]
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
export async function countActiveToolRuns(userEmail: string): Promise<number> {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS)
  const rows = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(toolRuns)
    .where(and(
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
      userEmail: toolRuns.userEmail,
      chatId: toolRuns.chatId,
    })
  const row = rows[0]
  return row ? { id: row.id, tool: row.tool, userEmail: row.userEmail, chatId: row.chatId } : null
}

/**
 * User-initiated cancel: mark the run cancelled immediately (the user's
 * intent is now, not at the worker's next heartbeat). Returns the jobId to
 * cancel in the queue, or null when the run wasn't the caller's or had
 * already gone terminal.
 */
export async function cancelToolRun(id: string, userEmail: string): Promise<string | null> {
  return withTransaction(async (tx) => {
    const rows = await tx
      .select({ jobId: toolRuns.jobId, status: toolRuns.status, owner: toolRuns.userEmail })
      .from(toolRuns)
      .where(eq(toolRuns.id, id))
      .limit(1)
      .for('update')
    const row = rows[0]
    if (!row || row.owner !== userEmail.toLowerCase().trim() || row.status !== 'queued') return null
    await finishToolRun(tx, id, { status: 'cancelled', errorClass: 'abort', error: 'cancelled by the user' })
    return row.jobId
  })
}
