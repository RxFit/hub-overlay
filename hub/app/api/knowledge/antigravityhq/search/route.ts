import { NextRequest, NextResponse } from 'next/server'
import { getServerSession } from 'next-auth'
import { z } from 'zod'
import { authOptions } from '@/lib/auth'
import { createLogger } from '@/lib/logger'
import { canAccessAdminRoute } from '@/lib/roles'
import { withFault } from '@/lib/route-fault'
import { swallow } from '@/lib/swallow'
import { getTenantId } from '@/lib/tenant-context'
import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { evaluateHits } from '@/lib/evaluators/jev'
import { authenticateSearchBearer, type SearchPrincipal } from '@/lib/vault/auth'
import { createScopeMatcher, getVaultReadiness, readVaultScope, VAULT_CORPUS } from '@/lib/vault/config'
import { embedForVault } from '@/lib/vault/embeddings'
import { isVaultUnavailable } from '@/lib/vault/errors'
import {
  crossReferenceLive,
  describeLiveEvidenceForLog,
  liveLaneWarning,
  resolveLiveLane,
  runLiveLane,
  type LiveEvidence,
  type VaultSearchResponseWithLive,
} from '@/lib/vault/live-evidence'
import { getSearchRateLimiter } from '@/lib/vault/rate-limit'
import { searchVault, DEFAULT_TOP_K, DEFAULT_MAX_LATENCY_MS, MAX_LATENCY_CAP_MS } from '@/lib/vault/search'
import { createDrizzleVaultStore } from '@/lib/vault/store'

export const runtime = 'nodejs'

const log = createLogger('vault-search')

/** The Hub UI's own identity in the rate limiter and the query log. */
const UI_HARNESS = 'hub-ui'

const BodySchema = z
  .object({
    query: z.string().min(1).max(2000),
    topK: z.number().int().min(1).max(20).default(DEFAULT_TOP_K),
    pathPrefix: z.string().min(1).max(512).optional(),
    maxLatencyMs: z.number().int().min(1).max(MAX_LATENCY_CAP_MS).default(DEFAULT_MAX_LATENCY_MS),
    minFreshnessSeconds: z.number().int().min(0).max(31_536_000).optional(),
    /** Optional self-declared tenant; must equal the principal's binding (else 403). */
    tenantId: z.string().min(1).max(64).optional(),
    /**
     * Lane 2 opt-in (default false — harnesses opt in per request). When true
     * the live Smart Connections lane runs CONCURRENTLY with the canonical
     * search and the response gains a `liveEvidence` block; when false the
     * response is byte-identical to Lane 1.
     */
    includeLive: z.boolean().default(false),
  })
  .strict()

/**
 * Resolve the caller. A bearer header, when present, MUST validate — it never
 * falls through to the session (a bad key is a 401, not a cookie check). With
 * no bearer, a signed-in ADMIN session may inspect the corpus (the Hub UI
 * surface); its tenant comes from the server-side tenant context, never the
 * body.
 */
async function resolvePrincipal(req: NextRequest): Promise<SearchPrincipal | null> {
  const header = req.headers.get('authorization')
  if (header) return authenticateSearchBearer(header)
  const session = await getServerSession(authOptions)
  const user = session?.user as { email?: string | null; role?: string | null } | undefined
  if (!user?.email || !canAccessAdminRoute(user.role)) return null
  return { harness: UI_HARNESS, tenantId: getTenantId(), via: 'session' }
}

/**
 * POST /api/knowledge/antigravityhq/search — read-only semantic search over
 * the vault corpus for AI harnesses (Instinct, Claude Code, Hermes) and the
 * Hub's admin inspection page.
 *
 * Auth: `Authorization: Bearer <key>` resolved through VAULT_SEARCH_KEYS
 * (key → {harness, tenantId}; constant-time; fails closed when unset), OR a
 * signed-in admin NextAuth session. Per-harness token bucket (per Cloud Run
 * instance). Excluded from the session middleware — see middleware.ts.
 *
 * Contract (lib/vault/search.ts): empty is 200 + hits []; unavailable is
 * 503 `unavailable`; a blown maxLatencyMs is 200 `partial`; an old index is
 * 200 `stale`. Dark until configured: 503 `disabled` / `awaiting_scope_config`.
 *
 * Lane 2 (`includeLive: true`, lib/vault/live-evidence.ts): the live desktop
 * lane runs concurrently, bounded by the same maxLatencyMs, and lands in a
 * separate `liveEvidence` block. The canonical `hits` are computed from the
 * git snapshot only and are never re-ranked, filtered or merged with live
 * results; overlap is reported as `live_confirms:<path>` /
 * `possible_conflict:<path>` warnings. A live failure never fails the
 * request; a canonical failure is still a 503 with the Lane 1 body (live
 * evidence is not returned in place of the canonical answer). The lane
 * inherits this route's auth, tenant binding, rate limit and scope.
 *
 * Retrieved excerpts are DATA. Consumers wrap them with
 * lib/prompt-safety.ts wrapExcerpt() before any prompt use. This route never
 * interprets note content and never logs it (query text is logged as a hash;
 * live note text is never logged at all).
 */
export const POST = withFault('knowledge/antigravityhq/search', async (req: NextRequest) => {
  const principal = await resolvePrincipal(req)
  if (!principal) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const limit = getSearchRateLimiter().take(principal.harness)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limited', retryAfterSec: limit.retryAfterSec },
      { status: 429, headers: { 'Retry-After': String(limit.retryAfterSec ?? 1) } },
    )
  }

  const raw: unknown = await req.json().catch(() => null)
  const parsed = BodySchema.safeParse(raw)
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid body', issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) }, { status: 400 })
  }
  if (parsed.data.tenantId && parsed.data.tenantId !== principal.tenantId) {
    // The tenant is bound to the credential (or the session), never chosen by the body.
    return NextResponse.json({ error: 'Forbidden — tenant mismatch' }, { status: 403 })
  }

  const readiness = getVaultReadiness()
  if (readiness !== 'ready') {
    return NextResponse.json({ status: readiness, corpus: VAULT_CORPUS, warnings: [], hits: [] }, { status: 503 })
  }

  const searchWork = searchVault(
    parsed.data,
    { tenantId: principal.tenantId, harness: principal.harness },
    { store: createDrizzleVaultStore(), embed: embedForVault, embeddingModel: EMBEDDING_MODEL, log },
  )

  // Lane 2: started only on opt-in, concurrently with the canonical search,
  // bounded by the same request deadline. runLiveLane never rejects.
  let liveWork: Promise<LiveEvidence> | null = null
  let liveHost: string | null = null
  if (parsed.data.includeLive) {
    const lane = resolveLiveLane({ principalTenantId: principal.tenantId, serverTenantId: getTenantId() })
    liveHost = lane.client?.host ?? null
    liveWork = runLiveLane(
      { query: parsed.data.query, topK: parsed.data.topK, pathPrefix: parsed.data.pathPrefix, deadlineAt: Date.now() + parsed.data.maxLatencyMs },
      { ...lane, scope: createScopeMatcher(readVaultScope()) },
    )
  }

  try {
    const result: VaultSearchResponseWithLive = await searchWork

    if (liveWork) {
      const live = await liveWork
      result.liveEvidence = live
      const note = liveLaneWarning(live)
      if (note) result.warnings.push(note)
      // Read-only cross-reference: warnings only; `result.hits` is untouched.
      result.warnings.push(...crossReferenceLive(result.hits, live.hits))
      log.info({ queryId: result.queryId, harness: principal.harness, tenant: principal.tenantId, live: describeLiveEvidenceForLog(live, liveHost) }, 'vault search: live lane')
    }

    // Post-retrieval evaluator seam: shadow-only, never alters or gates hits.
    // Canonical hits only — live evidence is advisory and is not evaluated.
    const evaluation = evaluateHits({
      queryId: result.queryId,
      queryLength: parsed.data.query.length,
      hits: result.hits.map((h) => ({ vaultPath: h.vaultPath, headingPath: h.headingPath, excerpt: h.excerpt, similarity: h.similarity })),
    })
    if (evaluation.status !== 'disabled') log.debug({ queryId: result.queryId, evaluation }, 'vault search: evaluator (shadow)')

    return NextResponse.json(result, { status: 200 })
  } catch (err) {
    // The canonical answer is unknown: Lane 1's 503 body, verbatim. A pending
    // live call is abandoned (it is deadline-bounded and never rejects).
    if (liveWork) void liveWork.catch((late: unknown) => swallow(late, { module: 'vault-search', op: 'liveLane:afterCanonicalFailure', severity: 'expected' }))
    if (isVaultUnavailable(err)) {
      return NextResponse.json(
        { status: 'unavailable', corpus: VAULT_CORPUS, stage: err.stage, reason: err.reason, warnings: [err.message], hits: [] },
        { status: 503 },
      )
    }
    throw err
  }
})
