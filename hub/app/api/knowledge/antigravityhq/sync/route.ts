import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '@/lib/db'
import { tenants } from '@/lib/schema'
import { createLogger } from '@/lib/logger'
import { withFault } from '@/lib/route-fault'
import { getDefaultTenantId } from '@/lib/tenant-context'
import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { verifySyncBearer } from '@/lib/vault/auth'
import { getVaultReadiness, getVaultRepo, readVaultScope, VAULT_CORPUS } from '@/lib/vault/config'
import { embedForVault } from '@/lib/vault/embeddings'
import { isVaultUnavailable } from '@/lib/vault/errors'
import { createGitHubClient } from '@/lib/vault/github'
import { createDrizzleVaultStore } from '@/lib/vault/store'
import { runVaultSync, DEFAULT_MAX_NOTES_PER_RUN } from '@/lib/vault/sync'

export const runtime = 'nodejs'
/** Under Cloud Run's 300s request ceiling; the run's own deadline is shorter still. */
export const maxDuration = 300

const log = createLogger('vault-sync')

/** Wall-clock budget for one run, leaving headroom under maxDuration for the response. */
const RUN_DEADLINE_MS = 240_000

const BodySchema = z
  .object({
    tenantId: z.string().min(1).max(64).optional(),
    maxNotesPerRun: z.number().int().min(1).max(1000).optional(),
    resolveSourceModified: z.boolean().optional(),
  })
  .strict()

/**
 * Same posture as app/api/embeddings/upsert: the sync key names a SERVICE, not
 * a tenant, so a body tenantId is accepted only when it is a known tenant.
 */
async function isKnownTenant(tenantId: string): Promise<boolean> {
  const rows = await db.select({ id: tenants.id }).from(tenants).where(eq(tenants.id, tenantId)).limit(1)
  return rows.length > 0
}

/**
 * POST /api/knowledge/antigravityhq/sync — read the vault git snapshot into
 * the corpus (Lane 1). Machine route: `Authorization: Bearer <VAULT_SYNC_API_KEY>`
 * (constant-time; fails closed when unset). Excluded from the session
 * middleware for that reason — see middleware.ts.
 *
 * DENY BY DEFAULT: 503 `disabled` until VAULT_GITHUB_TOKEN is bound, 503
 * `awaiting_scope_config` until VAULT_INCLUDE_GLOBS names folders. Nothing is
 * fetched or indexed in either state. The read-only PAT is never created here
 * (owner step, docs/runbooks/vault-search.md).
 *
 * Idempotent and incremental (lib/vault/sync.ts): an unchanged commit is a
 * no-op that still records a run; a large first index is several runs
 * (`maxNotesPerRun`, default 200 — the response's `notesRemaining` says
 * whether to call again).
 */
export const POST = withFault('knowledge/antigravityhq/sync', async (req: NextRequest) => {
  if (!verifySyncBearer(req.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const readiness = getVaultReadiness()
  if (readiness !== 'ready') {
    return NextResponse.json({ status: readiness, corpus: VAULT_CORPUS }, { status: 503 })
  }

  const raw: unknown = await req.json().catch(() => ({}))
  const parsed = BodySchema.safeParse(raw ?? {})
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues.map((i) => i.message) }, { status: 400 })
  }
  const tenantId = parsed.data.tenantId ?? getDefaultTenantId()
  if (!(await isKnownTenant(tenantId))) {
    return NextResponse.json({ error: 'Unknown tenantId' }, { status: 403 })
  }

  const repo = getVaultRepo()
  const controller = new AbortController()
  const deadline = setTimeout(() => controller.abort(), RUN_DEADLINE_MS)
  try {
    const result = await runVaultSync(
      { tenantId, corpus: VAULT_CORPUS },
      {
        store: createDrizzleVaultStore(),
        github: createGitHubClient({
          token: process.env.VAULT_GITHUB_TOKEN as string,
          owner: repo.owner,
          repo: repo.repo,
          signal: controller.signal,
        }),
        embed: embedForVault,
        scope: readVaultScope(),
        ref: repo.ref,
        embeddingModel: EMBEDDING_MODEL,
        log,
        maxNotesPerRun: parsed.data.maxNotesPerRun ?? DEFAULT_MAX_NOTES_PER_RUN,
        resolveSourceModified: parsed.data.resolveSourceModified,
        signal: controller.signal,
      },
    )
    return NextResponse.json({ corpus: VAULT_CORPUS, repo: repo.slug, ref: repo.ref, tenantId, ...result }, { status: 200 })
  } catch (err) {
    if (isVaultUnavailable(err)) {
      // The run is already recorded as `failed` in vault_sync_runs; tell the
      // scheduler which upstream broke, without stack text.
      return NextResponse.json(
        { status: 'unavailable', corpus: VAULT_CORPUS, stage: err.stage, reason: err.reason, detail: err.message },
        { status: 503 },
      )
    }
    throw err
  } finally {
    clearTimeout(deadline)
  }
})
