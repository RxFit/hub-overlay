import { describe, it, expect, beforeEach, vi } from 'vitest'
import { checkVaultSearchHealth } from './health'
import { EMBEDDING_MODEL } from '@/lib/vector-store'
import { createMemoryVaultStore, type MemoryVaultStore } from '../../test/vault-memory-store'
import { createFakeEmbed, type FakeEmbed } from '../../test/vault-fake-embed'
import { _resetSearchKeyCacheForTests } from './auth'
import { FAKE_MCP_KEY, FAKE_MCP_URL } from '../../test/vault-fake-mcp'

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
    expect(r.embedding).toMatchObject({ reachable: false, detail: expect.stringContaining('simulated embedding failure') })
    expect(r.remediation).toContain('GEMINI_API_KEY')
  })
})

describe('smartConnections section (Lane 2) — optional, never a stage', () => {
  const LIVE_ENV = { ...FULL_ENV, SMART_CONNECTIONS_URL: FAKE_MCP_URL, SMART_CONNECTIONS_API_KEY: FAKE_MCP_KEY }
  const seedCompleted = async () => {
    const id = await store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(), fromCommit: null })
    await store.finishRun(id, { finishedAt: new Date(), status: 'completed', toCommit: 'abc', notesScanned: 1, notesIndexed: 1, notesFailed: 0, failedPaths: [], error: null })
  }

  it('unconfigured → configured:false, nothing probed, health and stages untouched', async () => {
    await seedCompleted()
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1, detail: 'never' }))
    const r = await check(FULL_ENV, { liveProbe: probe })
    expect(r.healthy).toBe(true)
    expect(r.smartConnections).toEqual({ configured: false, reachable: null, latencyMs: null, detail: expect.stringContaining('SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set') })
    expect(r.smartConnections.detail).toContain('does not affect readiness')
    expect(r.stages.map((s) => s.stage)).toEqual(['config', 'db', 'embedding', 'sync'])
    expect(probe).not.toHaveBeenCalled()
  })

  it('configured → probed with the host in the detail; a failing or throwing probe never changes healthy, stages, summary or remediation', async () => {
    await seedCompleted()
    const ok = await check(LIVE_ENV, { liveProbe: async () => ({ reachable: true, latencyMs: 12, detail: 'fake answered; tool "search_notes"' }) })
    expect(ok.smartConnections).toEqual({ configured: true, reachable: true, latencyMs: 12, detail: 'desktop.example.test: fake answered; tool "search_notes"' })
    expect(ok.healthy).toBe(true)

    const down = await check(LIVE_ENV, { liveProbe: async () => ({ reachable: false, latencyMs: 4000, detail: 'timeout: desktop asleep' }) })
    expect(down.smartConnections).toMatchObject({ configured: true, reachable: false, latencyMs: 4000, detail: expect.stringContaining('timeout: desktop asleep') })
    expect(down.healthy).toBe(true)
    expect(down.stages.map((s) => s.stage)).toEqual(['config', 'db', 'embedding', 'sync'])
    expect(down.summary).toContain('ready')
    expect(down.remediation).toBeUndefined()

    const thrown = await check(LIVE_ENV, { liveProbe: async () => { throw new Error('probe exploded') } })
    expect(thrown.smartConnections).toMatchObject({ configured: true, reachable: false, detail: expect.stringContaining('probe exploded') })
    expect(thrown.healthy).toBe(true)
    expect(JSON.stringify(thrown)).not.toContain(FAKE_MCP_KEY)
  })

  it('probe=0 (probeEmbedding false) skips the live probe too; probeSmartConnections overrides it either way', async () => {
    await seedCompleted()
    const probe = vi.fn(async () => ({ reachable: true, latencyMs: 1, detail: 'x' }))
    let r = await check(LIVE_ENV, { probeEmbedding: false, liveProbe: probe })
    expect(r.smartConnections).toEqual({ configured: true, reachable: null, latencyMs: null, detail: 'configured (desktop.example.test); probe skipped' })
    r = await check(LIVE_ENV, { probeSmartConnections: false, liveProbe: probe })
    expect(r.smartConnections.reachable).toBeNull()
    expect(probe).not.toHaveBeenCalled()
    r = await check(LIVE_ENV, { probeEmbedding: false, probeSmartConnections: true, liveProbe: probe })
    expect(r.smartConnections.reachable).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })
})
