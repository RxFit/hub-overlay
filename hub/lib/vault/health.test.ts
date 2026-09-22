import { describe, it, expect, beforeEach } from 'vitest'
import { checkVaultSearchHealth, embeddingRemediation } from './health'
import { VaultUnavailableError } from './errors'
import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { createMemoryVaultStore, type MemoryVaultStore } from '../../test/vault-memory-store'
import { createFakeEmbed, type FakeEmbed } from '../../test/vault-fake-embed'
import { _resetSearchKeyCacheForTests } from './auth'

/* Stage-level branches the route test does not reach: DB outage, a stuck
   `running` run, malformed search keys, missing sync key, probe latency. */

let store: MemoryVaultStore
let embed: FakeEmbed
const FULL_ENV = {
  VAULT_GITHUB_TOKEN: 'github_pat_TEST_NOT_REAL',
  VAULT_INCLUDE_GLOBS: 'Projects/**, Daily/**',
  VAULT_EXCLUDE_GLOBS: 'Private/**',
  VAULT_SYNC_API_KEY: 'sync-key-0123456789abcdef',
  VAULT_SEARCH_KEYS: JSON.stringify({ 'instinct-key-0123456789abcdef': { harness: 'instinct', tenantId: 'rxfit' } }),
}

const check = (env: Record<string, string | undefined>, extra: Partial<Parameters<typeof checkVaultSearchHealth>[0]> = {}) =>
  checkVaultSearchHealth({ store, embed: embed.embed, tenantId: 'rxfit', env, ...extra })

const stage = (r: Awaited<ReturnType<typeof check>>, name: string) => r.stages.find((s) => s.stage === name)!

beforeEach(() => {
  store = createMemoryVaultStore()
  embed = createFakeEmbed()
  _resetSearchKeyCacheForTests()
})

describe('checkVaultSearchHealth', () => {
  it('reports the config stage in the runbook’s order: token → scope → sync key', async () => {
    expect(stage(await check({}), 'config').detail).toContain('VAULT_GITHUB_TOKEN')
    expect(stage(await check({ VAULT_GITHUB_TOKEN: 'x' }), 'config').detail).toContain('VAULT_INCLUDE_GLOBS')
    const noSync = await check({ VAULT_GITHUB_TOKEN: 'x', VAULT_INCLUDE_GLOBS: 'a/**' })
    expect(stage(noSync, 'config').detail).toContain('VAULT_SYNC_API_KEY')
    expect(noSync.remediation).toContain('hub-vault-sync-key')
    expect(noSync.readiness).toBe('ready') // readiness is the route gate; the sync key is a separate config item
  })

  it('notes malformed or missing search keys without failing the config stage', async () => {
    const malformed = await check({ ...FULL_ENV, VAULT_SEARCH_KEYS: '{oops' })
    expect(stage(malformed, 'config').status).toBe('ok')
    expect(stage(malformed, 'config').detail).toContain('not valid JSON')
    _resetSearchKeyCacheForTests()
    const missing = await check({ ...FULL_ENV, VAULT_SEARCH_KEYS: undefined })
    expect(stage(missing, 'config').detail).toContain('only the signed-in Hub UI')
    expect(missing.config.searchKeys).toEqual({ configured: false, count: 0, rejected: 0, malformed: false })
  })

  it('a DB outage fails the db stage with a bounded message and a DATABASE_URL remediation', async () => {
    store.outage = new Error('connection refused')
    const r = await check(FULL_ENV, { probeEmbedding: false })
    expect(r.healthy).toBe(false)
    expect(stage(r, 'db')).toMatchObject({ status: 'fail', detail: expect.stringContaining('connection refused') })
    expect(r.remediation).toContain('DATABASE_URL')
    expect(stage(r, 'sync').detail).toBe('no sync run recorded yet')
  })

  it('flags a run stuck in `running` for over an hour', async () => {
    await store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(Date.now() - 2 * 3600 * 1000), fromCommit: null })
    const r = await check(FULL_ENV, { probeEmbedding: false })
    expect(stage(r, 'sync')).toMatchObject({ status: 'fail', detail: expect.stringContaining('never finished') })
  })

  it('a recent `running` run is not a failure; a completed run with failures stays ok but says so', async () => {
    const id = await store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(), fromCommit: null })
    let r = await check(FULL_ENV, { probeEmbedding: false })
    expect(stage(r, 'sync').status).toBe('ok')
    await store.finishRun(id, { finishedAt: new Date(), status: 'completed_with_failures', toCommit: 'abc', notesScanned: 5, notesIndexed: 4, notesFailed: 1, failedPaths: [{ path: 'x.md', message: 'boom' }], error: null })
    r = await check(FULL_ENV, { probeEmbedding: false })
    expect(stage(r, 'sync')).toMatchObject({ status: 'ok', detail: expect.stringContaining('1 note(s) failed') })
    expect(r.coverage.notesFailedLastRun).toBe(1)
    expect(r.healthy).toBe(true)
    expect(r.remediation).toBeUndefined()
  })

  it('the embedding probe reports latency and the active model, and a failure carries the reason', async () => {
    const id = await store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(), fromCommit: null })
    await store.finishRun(id, { finishedAt: new Date(), status: 'completed', toCommit: 'abc', notesScanned: 1, notesIndexed: 1, notesFailed: 0, failedPaths: [], error: null })
    let r = await check(FULL_ENV)
    expect(r.healthy).toBe(true)
    expect(r.embedding.reachable).toBe(true)
    expect(r.embedding.latencyMs).toBeGreaterThanOrEqual(0)
    expect(r.embedding.detail).toContain(EMBEDDING_MODEL)
    expect(r.config.embeddingModel).toBe(EMBEDDING_MODEL)

    embed.failWhen = () => true
    r = await check(FULL_ENV)
    expect(r.healthy).toBe(false)
    expect(r.embedding).toMatchObject({ reachable: false, reason: 'http', detail: expect.stringContaining('simulated embedding failure') })
    expect(r.embedding.upstreamStatus).toBeUndefined()
    expect(r.remediation).toContain('GEMINI_API_KEY')
  })

  it('an auth-class probe failure keeps the provider’s status and reason in the report and names the credential, not the code', async () => {
    const id = await store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(), fromCommit: null })
    await store.finishRun(id, { finishedAt: new Date(), status: 'completed', toCommit: 'abc', notesScanned: 1, notesIndexed: 1, notesFailed: 0, failedPaths: [], error: null })
    embed.error = () => new VaultUnavailableError('embedding', 'auth', `Gemini embedContent (${EMBEDDING_MODEL}) answered HTTP 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.`, 400)
    embed.failWhen = () => true

    const r = await check(FULL_ENV)
    expect(r.healthy).toBe(false)
    expect(r.embedding).toMatchObject({ reachable: false, reason: 'auth', upstreamStatus: 400 })
    // The whole cause fits the bounded detail — this is the field the finding was read from.
    expect(r.embedding.detail).toContain('HTTP 400 API_KEY_INVALID')
    expect(r.embedding.detail).toContain('API key not valid')
    expect(stage(r, 'embedding')).toMatchObject({ status: 'fail', detail: r.embedding.detail })
    expect(r.summary).toContain('embedding: VaultUnavailableError: Gemini embedContent')
    expect(r.remediation).toContain('hub-gemini-api-key')
    expect(r.remediation).toContain('Credential-side, not code')
    expect(r.remediation).toContain('HTTP 400')
  })

  it('a not_found probe failure points at EMBEDDING_MODEL, and a skipped probe carries no failure fields', async () => {
    embed.error = () => new VaultUnavailableError('embedding', 'not_found', 'Gemini embedContent (x) answered HTTP 404: models/x is not found for API version v1beta', 404)
    embed.failWhen = () => true
    const r = await check(FULL_ENV)
    expect(r.embedding).toMatchObject({ reason: 'not_found', upstreamStatus: 404 })
    expect(r.remediation).toContain('EMBEDDING_MODEL')

    const skipped = await check(FULL_ENV, { probeEmbedding: false })
    expect(skipped.embedding).toEqual({ reachable: null, latencyMs: null, detail: 'probe skipped' })
    expect('reason' in skipped.embedding).toBe(false)
  })

  it('config and db failures keep precedence over the probe’s remediation', async () => {
    embed.error = () => new VaultUnavailableError('embedding', 'auth', 'HTTP 401', 401)
    embed.failWhen = () => true
    const config = await check({ VAULT_GITHUB_TOKEN: 'x', VAULT_INCLUDE_GLOBS: 'a/**' })
    expect(config.embedding.reason).toBe('auth')
    expect(config.remediation).toContain('hub-vault-sync-key')

    store.outage = new Error('connection refused')
    const db = await check(FULL_ENV)
    expect(db.embedding).toMatchObject({ reason: 'auth', upstreamStatus: 401 })
    expect(stage(db, 'db').status).toBe('fail')
    expect(db.remediation).toContain('DATABASE_URL')
  })

  it('embeddingRemediation gives one concrete next action per failure class', () => {
    const at = (reason: ConstructorParameters<typeof VaultUnavailableError>[1], status?: number) =>
      embeddingRemediation(new VaultUnavailableError('embedding', reason, 'm', status), 5_000)
    expect(at('unconfigured')).toContain('hub-gemini-api-key')
    expect(at('auth', 403)).toMatch(/rejected GEMINI_API_KEY .*HTTP 403/)
    expect(at('not_found', 404)).toContain('EMBEDDING_MODEL')
    expect(at('breaker_open')).toContain('wait 60s')
    expect(at('timeout')).toContain('5000 ms')
    expect(at('network')).toContain('egress')
    expect(at('http', 429)).toContain('HTTP 429')
    expect(at('http')).toContain('GEMINI_API_KEY')
    expect(embeddingRemediation(new Error('plain'), 5_000)).toContain('vault-embeddings circuit')
  })
})
