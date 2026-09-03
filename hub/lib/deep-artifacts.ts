/**
 * lib/deep-artifacts.ts — a finished deep run becomes a tool artifact,
 * automatically and exactly once.
 *
 * Before this module, a Deep Research / Deep Think report only reached
 * `tool_artifacts` when the user pressed Save & Close on the panel that
 * happened to be open when the run landed. Anyone who navigated away, closed
 * the tab, or simply started the next run kept nothing — the Artifacts tab
 * stayed empty. The report itself was safe in `tool_runs` (the system of
 * record), but that store is per-run and only the latest run per tool
 * reattaches to the panel.
 *
 * Now the report is saved as an artifact from BOTH ends, and both ends are
 * idempotent on the run id:
 *
 *  - server landing: the worker result route calls `ensureDeepRunArtifactForRun`
 *    the moment a deep run lands `succeeded`, so the artifact exists whether
 *    or not any browser is watching;
 *  - client adopt: the panel asks `POST /api/deep-runs/:id {action:'save_artifact'}`
 *    when it renders a finished report — a no-op when landing already saved
 *    it, and the safety net for runs that landed before this shipped.
 *
 * "Exactly once" is enforced with a transaction-scoped advisory lock keyed on
 * the run id plus a check-then-insert inside that transaction — no new
 * column, no migration, and no unique index over historical JSON that a
 * duplicate row from the old manual path could have broken at deploy time.
 * The artifact id lives in `content.metadata.deepRunId`, which is also what
 * the old Save & Close path wrote, so pre-existing manual saves count as
 * "already saved" rather than being duplicated.
 *
 * Callers AWAIT the row. The worker route in particular must not detach it:
 * Cloud Run throttles an instance's CPU once the response is sent, so a
 * fire-and-forget save could stall forever with the worker already told
 * "recorded" — and the panel-side safety net only fires when someone opens
 * the panel. The embedding is the one step that is allowed to lag (bounded
 * by EMBED_TIMEOUT_MS, best-effort by contract).
 */

import { and, asc, eq, sql } from 'drizzle-orm'
import { withTransaction } from '@/lib/db'
import { toolArtifacts } from '@/lib/schema'
import { parseDeepReport } from '@/lib/deep-report'
import { DEEP_TOOLS, isDeepToolId } from '@/lib/deep-runs'
import { embedToolArtifact, normalizeArtifactOwner } from '@/lib/tool-artifacts'
import { getToolRunOwned } from '@/lib/tool-runs'
import { withTimeout } from '@/lib/timeout'
import { createLogger } from '@/lib/logger'
import type { ToolArtifactData, ToolArtifactSection } from '@/types'

const log = createLogger('deep-artifacts')

/** The slice of a tool_runs row the artifact is built from. */
export interface DeepRunArtifactSource {
  id: string
  tool: string
  brief: string
  resultMd: string | null
  inputs?: { id: string; title: string; toolId: string }[] | null
  chatId?: string | null
}

export interface EnsuredArtifact {
  id: string
  title: string
  /** true when THIS call inserted the row; false when one already existed. */
  created: boolean
}

/** Longest a fallback (brief-derived) title gets. */
const TITLE_FROM_BRIEF_CHARS = 80

/** Default bound on the best-effort embedding step. The row is the durable
 *  product; a slow model call must never hold a caller (the worker's result
 *  ack, the panel's "Saving…") hostage. On timeout the artifact simply isn't
 *  semantically searchable yet — exactly the documented best-effort outcome. */
export const EMBED_TIMEOUT_MS = 8_000

export interface EnsureDeepRunArtifactOptions {
  tenantId: string
  createdBy?: string | null
  /** Override the embedding bound (ms). */
  embedTimeoutMs?: number
}

function toolDisplayName(tool: string): string {
  return isDeepToolId(tool) ? DEEP_TOOLS[tool].name : tool
}

/**
 * PURE: shape the run's report into the artifact sections the viewer and the
 * Save & Close path already understand. A parsable report (the trailing JSON
 * block, lib/deep-report.ts) yields Summary → sections → Sources; anything
 * else is stored whole as a single Report section — the markdown IS the
 * report, and losing it would be worse than an unstructured card.
 */
export function buildDeepRunArtifact(run: DeepRunArtifactSource): ToolArtifactData {
  const parsed = parseDeepReport(run.resultMd)
  
  let headPrefix = ''
  if (run.inputs && run.inputs.length > 0) {
    const lineage = run.inputs.map(i => `* ${i.title}`).join('\n')
    headPrefix = `> **Built on:**\n${lineage}\n\n`
  }

  const sections: ToolArtifactSection[] = parsed
    ? [
        { id: `${run.id}-summary`, type: 'recommendation', title: 'Summary', content: headPrefix + parsed.summary },
        ...parsed.sections.map((s, i) => ({
          id: `${run.id}-s${i}`, type: 'insight' as const, title: s.heading, content: s.body,
        })),
        ...(parsed.sources.length > 0
          ? [{
              id: `${run.id}-sources`, type: 'generic' as const, title: 'Sources',
              content: parsed.sources.map((s, i) => `[${i + 1}] ${s.title} — ${s.url}`).join('\n'),
            }]
          : []),
      ]
    : [{ id: `${run.id}-report`, type: 'generic', title: 'Report', content: headPrefix + (run.resultMd ?? '') }]

  return {
    toolId: run.tool,
    title: parsed?.title ?? run.brief.trim().slice(0, TITLE_FROM_BRIEF_CHARS),
    sections,
    metadata: {
      deepRunId: run.id,
      ...(run.chatId ? { chatId: run.chatId } : {}),
      brief: run.brief,
    },
  }
}

/**
 * PURE: the row title, matching the convention the manual Save & Close path
 * used (`<Tool name>: <report title>`) so old and new saves sort and read
 * alike in the Artifacts tab.
 */
export function deepRunArtifactTitle(run: Pick<DeepRunArtifactSource, 'tool'>, data: ToolArtifactData): string {
  return `${toolDisplayName(run.tool)}: ${data.title || 'Untitled'}`
}

/**
 * The "artifact for this run" predicate: tenant + active + the run id in
 * content.metadata — and, when the owner is known, THEIR row only.
 * metadata.deepRunId is client-writable through POST /api/tool-artifacts, so
 * without the owner clause any user in the tenant could pre-create a row
 * claiming someone else's run id and silently block that owner's auto-save
 * (the panel would say "Saved" while their list stayed empty). Owner
 * comparison is case-insensitive, like every other createdBy check.
 */
function deepRunPredicate(tenantId: string, runId: string, owner: string | null | undefined) {
  const ownerKey = normalizeArtifactOwner(owner)
  return and(
    eq(toolArtifacts.tenantId, tenantId),
    eq(toolArtifacts.status, 'active'),
    sql`${toolArtifacts.content}->'metadata'->>'deepRunId' = ${runId}`,
    ...(ownerKey ? [sql`lower(${toolArtifacts.createdBy}) = ${ownerKey}`] : []),
  )
}

/**
 * Save the run's report as an artifact unless one already exists for it.
 *
 * The advisory lock serialises concurrent callers for the SAME run (the
 * landing side effect and the panel's adopt can race by design) while leaving
 * everything else untouched; the lock is transaction-scoped, so a crash
 * releases it. The embedding step runs AFTER the transaction, is bounded by
 * a timeout, and is best-effort — an artifact that isn't semantically
 * searchable is still an artifact, and holding a row lock (or a caller)
 * across a model call is not worth it.
 *
 * Throws only when the DATABASE write itself fails; the caller decides
 * whether that is fatal (the API route) or logged (the worker landing).
 */
export async function ensureDeepRunArtifact(
  run: DeepRunArtifactSource,
  opts: EnsureDeepRunArtifactOptions,
): Promise<EnsuredArtifact> {
  const data = buildDeepRunArtifact(run)
  const title = deepRunArtifactTitle(run, data)

  const ensured = await withTransaction(async (tx) => {
    // hashtext() folds the run id to an int4; pg_advisory_xact_lock(bigint)
    // accepts it directly. Namespaced so it can't collide with any other
    // advisory-lock use that hashes a bare uuid.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`deep-run-artifact:${run.id}`}))`)

    const existing = await tx
      .select({ id: toolArtifacts.id, title: toolArtifacts.title })
      .from(toolArtifacts)
      .where(deepRunPredicate(opts.tenantId, run.id, opts.createdBy))
      .orderBy(asc(toolArtifacts.createdAt))
      .limit(1)
    if (existing[0]) {
      return { id: existing[0].id, title: existing[0].title, created: false }
    }

    const [row] = await tx
      .insert(toolArtifacts)
      .values({
        tenantId: opts.tenantId,
        toolId: run.tool,
        chatId: run.chatId ?? null,
        title,
        content: data,
        contextSummary: null,
        createdBy: opts.createdBy ? normalizeArtifactOwner(opts.createdBy) : null,
        status: 'active',
      })
      .returning({ id: toolArtifacts.id, title: toolArtifacts.title })
    return { id: row.id, title: row.title, created: true }
  })

  if (ensured.created) {
    log.info({ artifactId: ensured.id, runId: run.id, tool: run.tool }, 'Deep run report saved as artifact')
    // Best-effort by contract (embedToolArtifact never throws) and bounded:
    // on timeout the call keeps running in the background and the caller
    // moves on with the durable row already committed.
    const embedded = await withTimeout(
      embedToolArtifact({ id: ensured.id, tenantId: opts.tenantId, toolId: run.tool, title, content: data }),
      opts.embedTimeoutMs ?? EMBED_TIMEOUT_MS,
      false,
      'deep-artifact-embed',
    )
    if (!embedded) log.warn({ artifactId: ensured.id }, 'Deep run artifact saved; embedding pending or skipped')
  }
  return ensured
}

/**
 * Landing-side entry point: look the run up by id (owner-scoped, same read
 * the panel uses) and save it when — and only when — it is a landed deep
 * run with a report. Returns null when there is nothing to save (unknown
 * run, not a deep tool, not succeeded, empty report) so callers can treat
 * "nothing" and "saved" as the two honest outcomes.
 */
export async function ensureDeepRunArtifactForRun(
  runId: string,
  userEmail: string,
  tenantId: string,
  opts: Pick<EnsureDeepRunArtifactOptions, 'embedTimeoutMs'> = {},
): Promise<EnsuredArtifact | null> {
  const run = await getToolRunOwned(runId, userEmail)
  if (!run || !isDeepToolId(run.tool) || run.status !== 'succeeded' || !run.resultMd?.trim()) return null
  return ensureDeepRunArtifact(run, { tenantId, createdBy: run.userEmail, ...opts })
}
