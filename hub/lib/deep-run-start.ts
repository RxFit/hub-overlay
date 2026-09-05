import { eq, inArray, and, sql } from 'drizzle-orm'
import { db } from './db'
import { toolArtifacts } from './schema'
import { composeRunPrompt, contextPayloadError, deepToolDeadlineMs, DEEP_TOOLS, type DeepToolId } from './deep-runs'
import { loadSkillContent } from './skills-loader'
import { enqueueJob, workCapableWorkerFresh } from './dispatch-store'
import { dispatchFreshMs, isDispatchConfigured, isDispatchEnabled } from './agy-dispatch'
import {
  attachToolRunJob,
  countActiveToolRuns,
  createToolRun,
  expireStaleToolRuns,
  finishToolRun,
  isActiveRunConflict,
} from './tool-runs'
import { emit } from './observability'
import { normalizeArtifactOwner } from './tool-artifacts'

/**
 * lib/deep-run-start.ts — the one way a deep run starts.
 *
 * Extracted from POST /api/deep-runs (Phase 4 PR 2) so the needs-you queue's
 * Retry re-enters EXACTLY the same guard sequence as a fresh start — dispatch
 * enabled → fresh work-capable worker → zombie expiry → one-active-run cap →
 * row first, job second → attach — instead of a second, weaker path. The
 * route keeps request validation; this module owns the engine contract
 * (docs/architecture/DEEP_LANE_2026-08-23.md §4, §7).
 *
 * Results are returned, not thrown, for every OUTCOME the design names
 * (503 dispatch_disabled / no_worker / queue_full, 409 active_run_exists).
 * Unexpected errors still throw — the route classifies missing tables and
 * hands the rest to withFault.
 */

export interface ArtifactRef {
  id: string
  title: string
  toolId: string
}

export type ContextResolution =
  | { ok: true; contextPayload?: string; ownedArtifacts?: ArtifactRef[] }
  | { ok: false; status: 400 | 403; error: string }

function resolveArtifact(artifact: { title: string; toolId: string; content: unknown }): string {
  const out: string[] = []
  out.push(`--- Tool Artifact (${artifact.toolId}): ${artifact.title} ---`)
  const walk = (sections: unknown, depth: number) => {
    if (!Array.isArray(sections) || depth > 8) return
    for (const raw of sections) {
      if (!raw || typeof raw !== 'object') continue
      const s = raw as Record<string, unknown>
      const title = typeof s.title === 'string' && s.title.trim() ? s.title : 'Untitled section'
      const body = typeof s.content === 'string' ? s.content.trim() : ''
      const heading = '#'.repeat(Math.min(2 + depth, 6))
      if (title !== 'Untitled section' || body) {
        out.push(body ? `${heading} ${title}\n${body}` : `${heading} ${title}`)
      }
      walk(s.children, depth + 1)
    }
  }
  const sections = artifact.content && typeof artifact.content === 'object'
    ? (artifact.content as { sections?: unknown }).sections
    : undefined
  if (sections) {
    walk(sections, 0)
  } else {
    out.push(typeof artifact.content === 'string' ? artifact.content : JSON.stringify(artifact.content))
  }
  return out.join('\n\n')
}

/**
 * Resolve the caller's selected artifacts (already de-duplicated ids) into
 * the prompt-transport payload + the durable `inputs` refs. Ownership and
 * tenant scoping are enforced here: any id the caller does not own is a 403
 * for the whole set.
 */
export async function resolveContextArtifacts(
  contextIds: string[],
  tenantId: string,
  userEmail: string,
): Promise<ContextResolution> {
  if (contextIds.length === 0) return { ok: true }
  const owned = await db
    .select({ id: toolArtifacts.id, content: toolArtifacts.content, title: toolArtifacts.title, toolId: toolArtifacts.toolId })
    .from(toolArtifacts)
    .where(and(
      inArray(toolArtifacts.id, contextIds),
      eq(toolArtifacts.tenantId, tenantId),
      eq(toolArtifacts.status, 'active'),
      sql`lower(${toolArtifacts.createdBy}) = ${normalizeArtifactOwner(userEmail)}`,
    ))
  if (owned.length !== contextIds.length) {
    return { ok: false, status: 403, error: 'one or more context artifacts do not exist or are not owned by you' }
  }
  const contextPayload = owned.map(resolveArtifact).join('\n\n')
  const contextProblem = contextPayloadError(contextPayload)
  if (contextProblem) return { ok: false, status: 400, error: contextProblem }
  return {
    ok: true,
    contextPayload,
    ownedArtifacts: owned.map((o) => ({ id: o.id, title: o.title, toolId: o.toolId })),
  }
}

export interface StartDeepRunInput {
  tool: DeepToolId
  brief: string
  tenantId: string
  userEmail: string
  chatId: string | null
  ownedArtifacts?: ArtifactRef[]
  contextPayload?: string
  /** The run this one re-runs (needs-you Retry). */
  retryOf?: string | null
}

export interface StartedDeepRun {
  id: string
  tool: DeepToolId
  status: 'queued'
  brief: string
  chatId: string | null
  jobId: string
  createdAt: string
  retryOf: string | null
}

export type StartDeepRunResult =
  | { ok: true; run: StartedDeepRun }
  | { ok: false; status: 503 | 409; error: string; reason: 'dispatch_disabled' | 'no_worker' | 'active_run_exists' | 'queue_full' }

const ACTIVE_RUN_ERROR = {
  ok: false as const,
  status: 409 as const,
  error: 'You already have a deep run in flight — wait for it or cancel it first',
  reason: 'active_run_exists' as const,
}

export async function startDeepRun(input: StartDeepRunInput): Promise<StartDeepRunResult> {
  const { tool, brief, tenantId, chatId } = input
  const userEmail = input.userEmail

  // Allotment-only, fail honest (design §7): a deep run either gets the
  // engine or reports exactly why not — never a silent metered fallback.
  if (!isDispatchEnabled() || !isDispatchConfigured()) {
    return { ok: false, status: 503, error: 'The deep engine is not enabled on this deployment', reason: 'dispatch_disabled' }
  }
  const fresh = await workCapableWorkerFresh(dispatchFreshMs())
  if (!fresh) {
    return {
      ok: false,
      status: 503,
      error: 'The desktop worker is offline or running no work slot (WORKER_WORK_SLOTS) — deep runs execute there',
      reason: 'no_worker',
    }
  }

  // Retire zombie rows first so the unique cap below can never deadlock a
  // user on a corpse, then a fast advisory check for the friendly 409.
  await expireStaleToolRuns(tenantId, userEmail)
  if ((await countActiveToolRuns(tenantId, userEmail)) >= 1) return ACTIVE_RUN_ERROR

  // ROW FIRST, job second: a fast worker could otherwise claim and post a
  // result before the product row exists, and the landing CAS would no-op
  // — losing the report. Creating the row first also makes the
  // one-active-run cap atomic: the partial unique index refuses a second
  // 'queued' row for this user, closing the count-check race between
  // overlapping POSTs.
  const runId = crypto.randomUUID()
  const cfg = DEEP_TOOLS[tool]
  try {
    await createToolRun({
      id: runId,
      tool,
      brief,
      inputs: input.ownedArtifacts,
      tenantId,
      userEmail,
      chatId,
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
    })
  } catch (err) {
    if (isActiveRunConflict(err)) return ACTIVE_RUN_ERROR
    throw err
  }

  const prompt = composeRunPrompt(tool, brief, await loadSkillContent(tool), input.contextPayload)
  let outcome: Awaited<ReturnType<typeof enqueueJob>>
  try {
    outcome = await enqueueJob({
      kind: 'work_item',
      prompt,
      deadlineMs: deepToolDeadlineMs(tool),
      meta: {
        toolRunId: runId,
        tool,
        tenantId,
        userEmail: userEmail.toLowerCase().trim(),
        ...(cfg.effort ? { effort: cfg.effort } : {}),
      },
    })
  } catch (err) {
    // No job ⇒ the row must not sit 'queued' (it would hold the cap).
    await finishToolRun(db, runId, { status: 'failed', errorClass: 'no_worker', error: 'enqueue failed' }).catch(() => null)
    throw err
  }
  if ('refused' in outcome) {
    await finishToolRun(db, runId, { status: 'failed', errorClass: 'queue_full', error: 'dispatch queue at work capacity' }).catch(() => null)
    return { ok: false, status: 503, error: 'The deep engine is at capacity — try again shortly', reason: 'queue_full' }
  }
  emit({ type: 'dispatch_enqueued', jobId: outcome.id, kind: 'work_item' })
  // Best-effort: landing keys on toolRunId, not job_id; a lost attach only
  // costs the live-state derivation, which then reports by age.
  await attachToolRunJob(runId, outcome.id).catch(() => {})

  return {
    ok: true,
    run: {
      id: runId,
      tool,
      status: 'queued',
      brief,
      chatId,
      jobId: outcome.id,
      createdAt: new Date().toISOString(),
      retryOf: input.retryOf ?? null,
    },
  }
}
