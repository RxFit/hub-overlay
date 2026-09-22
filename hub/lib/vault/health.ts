import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { describeSearchKeys, isSyncKeyConfigured } from './auth'
import { getVaultReadiness, getVaultRepo, isVaultTokenConfigured, readVaultScope, VAULT_CORPUS, type VaultReadiness } from './config'
import { describeError } from './errors'
import type { EmbedFn } from './embeddings'
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
 * SECURITY: reports presence booleans and counts only — never a token, a key,
 * a glob's matches, note content, or a query.
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
  embedding: { reachable: boolean | null; latencyMs: number | null; detail: string }
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
}

const STUCK_RUN_MS = 60 * 60 * 1000

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
    const t0 = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), deps.probeTimeoutMs ?? 5_000)
    try {
      const vector = await deps.embed('vault search health probe', { signal: controller.signal })
      embedding.reachable = Array.isArray(vector) && vector.length > 0
      embedding.latencyMs = Date.now() - t0
      embedding.detail = embedding.reachable ? `${EMBEDDING_MODEL} answered (${vector.length} dims)` : 'embedding call returned an empty vector'
    } catch (err) {
      embedding.reachable = false
      embedding.latencyMs = Date.now() - t0
      embedding.detail = describeError(err, 200)
    } finally {
      clearTimeout(timer)
    }
    stages.push({ stage: 'embedding', status: embedding.reachable ? 'ok' : 'fail', detail: embedding.detail })
    if (!embedding.reachable) remediation ??= 'Check GEMINI_API_KEY and the vault-embeddings circuit (it resets after 60s)'
  } else {
    stages.push({ stage: 'embedding', status: 'skipped', detail: 'probe skipped (probe=0)' })
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
    summary,
    remediation: healthy ? undefined : remediation,
    generatedAt: now().toISOString(),
  }
}
