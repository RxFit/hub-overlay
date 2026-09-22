import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { describeSearchKeys, isSyncKeyConfigured } from './auth'
import { getVaultReadiness, getVaultRepo, isVaultTokenConfigured, readVaultScope, VAULT_CORPUS, type VaultReadiness } from './config'
import { describeError, isVaultUnavailable, type VaultFailureReason, type VaultUnavailableError } from './errors'
import type { EmbedFn } from './embeddings'
import { createSmartConnectionsClientFromEnv, readSmartConnectionsConfig, type SmartConnectionsProbe } from './smart-connections'
import type { VaultStore, VaultSyncRunRow } from './store'

/**
 * Vault search health report — SERVER-ONLY, admin-facing.
 *
 * Mirrors lib/vertex-health.ts: walk the same dependencies the sync and
 * search routes use and say WHICH stage is not ready, with the concrete next
 * action. `healthy` is true only when every stage is `ok`.
 *
 * Stages, in the order the runbook lists the owner's steps:
 *   config     VAULT_GITHUB_TOKEN bound? include globs set? sync/search keys?
 *   db         the sync ledger and coverage counts can be read
 *   embedding  the embedding model answers (one live call, bounded)
 *   sync       the last run finished and did not fail
 *
 * Lane 2 (`smartConnections`) is reported in its own section and is NOT a
 * stage: the live desktop lane is optional by design, so an unconfigured or
 * unreachable endpoint never changes `healthy`, `readiness` or `summary`.
 * It is probed (initialize + tools/list, no search) only when configured and
 * only when the embedding probe runs too (`?probe=0` skips both).
 *
 * SECURITY: reports presence booleans and counts only — never a token, a key,
 * a glob's matches, note content, or a query. The Smart Connections section
 * names the endpoint HOST at most, never the key.
 */

export type VaultHealthStage = 'config' | 'db' | 'embedding' | 'sync'
export type VaultHealthStatus = 'ok' | 'fail' | 'skipped'

export interface VaultStageResult {
  stage: VaultHealthStage
  status: VaultHealthStatus
  detail: string
}

export interface VaultHealthReport {
  healthy: boolean
  readiness: VaultReadiness
  corpus: string
  repo: { slug: string; ref: string }
  config: {
    githubTokenConfigured: boolean
    scopeConfigured: boolean
    includeGlobs: number
    excludeGlobs: number
    syncKeyConfigured: boolean
    searchKeys: { configured: boolean; count: number; rejected: number; malformed: boolean }
    embeddingModel: string
  }
  stages: VaultStageResult[]
  lastRun: VaultSyncRunRow | null
  lastSuccessfulRun: VaultSyncRunRow | null
  coverage: { notesLive: number; notesOnActiveModel: number; chunksOnActiveModel: number; notesFailedLastRun: number }
  /**
   * Live probe outcome. On failure `reason` is the vault failure class and
   * `upstreamStatus` the Gemini HTTP status (when the provider answered at
   * all), so the cause is machine-readable and not only inside `detail`.
   */
  embedding: {
    reachable: boolean | null
    latencyMs: number | null
    detail: string
    reason?: VaultFailureReason
    upstreamStatus?: number
  }
  /** Lane 2, optional: never affects `healthy`. `reachable` is null unless configured AND probed. */
  smartConnections: { configured: boolean; reachable: boolean | null; latencyMs: number | null; detail: string }
  summary: string
  remediation?: string
  generatedAt: string
}

export interface VaultHealthDeps {
  store: VaultStore
  embed: EmbedFn
  env?: Record<string, string | undefined>
  now?: () => Date
  /** Run the live embedding probe (default true). */
  probeEmbedding?: boolean
  probeTimeoutMs?: number
  tenantId: string
  /** Run the Smart Connections probe when configured (default: same as probeEmbedding). */
  probeSmartConnections?: boolean
  /** Injectable Lane 2 probe (tests); default builds the client from env. Never throws. */
  liveProbe?: () => Promise<SmartConnectionsProbe>
}

/** Bounded like the embedding probe: the health page must answer even when the desktop is asleep. */
async function defaultLiveProbe(env: Record<string, string | undefined>, probeTimeoutMs: number): Promise<SmartConnectionsProbe> {
  const configuredTimeout = readSmartConnectionsConfig(env).timeoutMs
  const client = createSmartConnectionsClientFromEnv(env, { timeoutMs: Math.min(configuredTimeout, probeTimeoutMs) })
  if (!client) return { reachable: false, latencyMs: 0, detail: 'not configured' }
  return client.probe()
}

const STUCK_RUN_MS = 60 * 60 * 1000

/**
 * The one concrete next action for a failed embedding probe, by failure class.
 * An `auth` failure (401/403, or a 400 the provider attributes to the API key)
 * is CREDENTIAL-SIDE: the request shape and model id are pinned by
 * tests/vector-store-embed-contract.test.ts, so no code change can clear it —
 * say so, and point at the secret and the model rather than at the code.
 */
const GENERIC_EMBEDDING_REMEDIATION = 'Check GEMINI_API_KEY and the vault-embeddings circuit (it resets after 60s)'

export function embeddingRemediation(err: unknown, probeTimeoutMs: number): string {
  if (!isVaultUnavailable(err)) return GENERIC_EMBEDDING_REMEDIATION
  const failure: VaultUnavailableError = err
  const code = failure.status ? `HTTP ${failure.status}` : 'no HTTP status'
  switch (failure.reason) {
    case 'unconfigured':
      return 'Bind GEMINI_API_KEY (Secret Manager hub-gemini-api-key) — the embedding path has no key'
    case 'auth':
      return `The Gemini API rejected GEMINI_API_KEY for ${EMBEDDING_MODEL} (${code}). Credential-side, not code: check the key value in hub-gemini-api-key, its API/application restrictions, and that its project may call the Generative Language API`
    case 'not_found':
      return `The Gemini API does not serve ${EMBEDDING_MODEL} for embedContent (${code}) — set EMBEDDING_MODEL to a listed embedding model; a model change requires re-embedding`
    case 'breaker_open':
      return 'The vault-embeddings circuit is open after repeated failures — wait 60s and probe again; the earlier failure detail names the cause'
    case 'timeout':
      return `The probe did not answer within ${probeTimeoutMs} ms — the Gemini API is slow or unreachable from this instance`
    case 'network':
      return 'The Gemini API could not be reached (DNS/TLS/socket) — check egress from the Cloud Run instance'
    default:
      return failure.status
        ? `The Gemini API answered ${code} for ${EMBEDDING_MODEL} — read the detail: a 400 here is a billing/location precondition, 429 is quota, 5xx is an upstream outage`
        : GENERIC_EMBEDDING_REMEDIATION
  }
}

export async function checkVaultSearchHealth(deps: VaultHealthDeps): Promise<VaultHealthReport> {
  const env = deps.env ?? process.env
  const now = deps.now ?? (() => new Date())
  const scope = readVaultScope(env)
  const readiness = getVaultReadiness(env)
  const repo = getVaultRepo(env)
  const stages: VaultStageResult[] = []

  const config = {
    githubTokenConfigured: isVaultTokenConfigured(env),
    scopeConfigured: scope.include.length > 0,
    includeGlobs: scope.include.length,
    excludeGlobs: scope.exclude.length,
    syncKeyConfigured: isSyncKeyConfigured(env),
    searchKeys: describeSearchKeys(env),
    embeddingModel: EMBEDDING_MODEL,
  }

  let remediation: string | undefined
  if (!config.githubTokenConfigured) {
    stages.push({ stage: 'config', status: 'fail', detail: 'VAULT_GITHUB_TOKEN is not set — the feature is disabled' })
    remediation = 'Bind the read-only vault PAT as hub-vault-github-token (VAULT_GITHUB_TOKEN); see docs/runbooks/vault-search.md'
  } else if (!config.scopeConfigured) {
    stages.push({ stage: 'config', status: 'fail', detail: 'VAULT_INCLUDE_GLOBS is empty — nothing is in scope (deny by default)' })
    remediation = 'Set VAULT_INCLUDE_GLOBS (and VAULT_EXCLUDE_GLOBS) to the folders to index'
  } else if (!config.syncKeyConfigured) {
    stages.push({ stage: 'config', status: 'fail', detail: 'VAULT_SYNC_API_KEY is not set (or shorter than 16 chars) — the sync route refuses every call' })
    remediation = 'Bind hub-vault-sync-key (VAULT_SYNC_API_KEY) so the scheduler can trigger syncs'
  } else {
    const keys = config.searchKeys
    const note = keys.malformed
      ? ' VAULT_SEARCH_KEYS is not valid JSON — the harness API is dark.'
      : keys.configured
        ? ` ${keys.count} search key(s) bound${keys.rejected ? `, ${keys.rejected} rejected as malformed/weak` : ''}.`
        : ' VAULT_SEARCH_KEYS is unset — only the signed-in Hub UI can search.'
    stages.push({ stage: 'config', status: 'ok', detail: `token + scope + sync key configured (${config.includeGlobs} include, ${config.excludeGlobs} exclude glob(s)).${note}` })
  }

  let lastRun: VaultSyncRunRow | null = null
  let lastSuccessfulRun: VaultSyncRunRow | null = null
  const coverage = { notesLive: 0, notesOnActiveModel: 0, chunksOnActiveModel: 0, notesFailedLastRun: 0 }
  try {
    const status = await deps.store.getSyncStatus(deps.tenantId, VAULT_CORPUS, EMBEDDING_MODEL)
    lastRun = status.lastRun
    lastSuccessfulRun = status.lastSuccessfulRun
    coverage.notesLive = status.notesLive
    coverage.notesOnActiveModel = status.notesOnActiveModel
    coverage.chunksOnActiveModel = status.chunksOnActiveModel
    coverage.notesFailedLastRun = status.lastRun?.notesFailed ?? 0
    stages.push({ stage: 'db', status: 'ok', detail: `ledger readable: ${coverage.notesLive} live note(s), ${coverage.chunksOnActiveModel} chunk(s) on ${EMBEDDING_MODEL}` })
  } catch (err) {
    stages.push({ stage: 'db', status: 'fail', detail: `sync ledger unreadable: ${describeError(err, 200)}` })
    remediation ??= 'Check DATABASE_URL / pgvector: the vault tables are created by drizzle/migrate.mjs at container start'
  }

  const embedding: VaultHealthReport['embedding'] = { reachable: null, latencyMs: null, detail: 'probe skipped' }
  if (deps.probeEmbedding ?? true) {
    const probeTimeoutMs = deps.probeTimeoutMs ?? 5_000
    const t0 = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), probeTimeoutMs)
    let probeRemediation: string | null = null
    try {
      const vector = await deps.embed('vault search health probe', { signal: controller.signal })
      embedding.reachable = Array.isArray(vector) && vector.length > 0
      embedding.latencyMs = Date.now() - t0
      embedding.detail = embedding.reachable ? `${EMBEDDING_MODEL} answered (${vector.length} dims)` : 'embedding call returned an empty vector'
      if (!embedding.reachable) probeRemediation = embeddingRemediation(null, probeTimeoutMs)
    } catch (err) {
      embedding.reachable = false
      embedding.latencyMs = Date.now() - t0
      // The classifier (lib/vault/embeddings.ts) puts the provider's HTTP status
      // and reason code at the FRONT of the message, so this bound keeps them.
      embedding.detail = describeError(err, 200)
      if (isVaultUnavailable(err)) {
        embedding.reason = err.reason
        if (typeof err.status === 'number') embedding.upstreamStatus = err.status
      }
      probeRemediation = embeddingRemediation(err, probeTimeoutMs)
    } finally {
      clearTimeout(timer)
    }
    stages.push({ stage: 'embedding', status: embedding.reachable ? 'ok' : 'fail', detail: embedding.detail })
    if (probeRemediation) remediation ??= probeRemediation
  } else {
    stages.push({ stage: 'embedding', status: 'skipped', detail: 'probe skipped (probe=0)' })
  }

  // Lane 2 — its own section, never a stage (optional by design).
  const sc = readSmartConnectionsConfig(env)
  const smartConnections: VaultHealthReport['smartConnections'] = {
    configured: sc.configured,
    reachable: null,
    latencyMs: null,
    detail: sc.configured ? `configured (${sc.host}); probe skipped` : `${sc.detail ?? 'not configured'} — optional live lane; does not affect readiness`,
  }
  if (sc.configured && (deps.probeSmartConnections ?? deps.probeEmbedding ?? true)) {
    try {
      const probe = await (deps.liveProbe ?? (() => defaultLiveProbe(env, deps.probeTimeoutMs ?? 5_000)))()
      smartConnections.reachable = probe.reachable
      smartConnections.latencyMs = probe.latencyMs
      smartConnections.detail = `${sc.host}: ${probe.detail}`
    } catch (err) {
      smartConnections.reachable = false
      smartConnections.detail = `${sc.host}: ${describeError(err, 200)}`
    }
  }

  if (!lastRun) {
    stages.push({ stage: 'sync', status: 'fail', detail: 'no sync run recorded yet' })
    remediation ??= 'Trigger POST /api/knowledge/antigravityhq/sync with the sync bearer key'
  } else if (lastRun.status === 'failed') {
    stages.push({ stage: 'sync', status: 'fail', detail: `last run failed: ${lastRun.error ?? 'no error recorded'}` })
    remediation ??= 'Read the failing stage from vault_sync_runs.error and the runbook failure table'
  } else if (lastRun.status === 'running' && now().getTime() - lastRun.startedAt.getTime() > STUCK_RUN_MS) {
    stages.push({ stage: 'sync', status: 'fail', detail: `a run started ${lastRun.startedAt.toISOString()} never finished (instance died mid-run?)` })
  } else {
    const failures = lastRun.notesFailed > 0 ? `, ${lastRun.notesFailed} note(s) failed` : ''
    stages.push({ stage: 'sync', status: 'ok', detail: `last run ${lastRun.status} at ${(lastRun.finishedAt ?? lastRun.startedAt).toISOString()} → ${lastRun.toCommit ? lastRun.toCommit.slice(0, 12) : 'no commit'}${failures}` })
  }

  const healthy = stages.every((s) => s.status === 'ok' || s.status === 'skipped')
  const firstFail = stages.find((s) => s.status === 'fail')
  const summary = healthy
    ? `vault search ready — ${coverage.notesOnActiveModel} note(s) searchable on ${EMBEDDING_MODEL}`
    : `vault search not ready — ${firstFail?.stage}: ${firstFail?.detail}`

  return {
    healthy,
    readiness,
    corpus: VAULT_CORPUS,
    repo: { slug: repo.slug, ref: repo.ref },
    config,
    stages,
    lastRun,
    lastSuccessfulRun,
    coverage,
    embedding,
    smartConnections,
    summary,
    remediation: healthy ? undefined : remediation,
    generatedAt: now().toISOString(),
  }
}
