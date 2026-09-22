import { describe, it, expect, beforeEach } from 'vitest'
import { searchVault, buildSyncBlock, hashQuery, MAX_LATENCY_CAP_MS, type VaultSearchDeps } from './search'
import { VaultUnavailableError } from './errors'
import { CircuitOpenError } from '@/lib/circuit-breaker'
import { createMemoryVaultStore, type MemoryVaultStore } from '../../test/vault-memory-store'
import { createFakeEmbed, vectorFor, type FakeEmbed } from '../../test/vault-fake-embed'

/* ════════════════════════════════════════════════════════════════════════════
   Search engine — the unavailable-vs-empty distinction (lib/vertex.ts's
   contract), stale/partial status transitions, the latency cap, active-model
   scoping, tombstone exclusion, path prefix, and paths-only logging. Offline:
   memory store + fake embedder; the deadline is driven by an injected clock.
   ════════════════════════════════════════════════════════════════════════════ */

const TENANT = 'rxfit'
const MODEL = 'gemini-embedding-2'
const PRINCIPAL = { tenantId: TENANT, harness: 'instinct' }

let store: MemoryVaultStore
let embed: FakeEmbed
let logged: Array<Record<string, unknown>>
let clock: number

function deps(overrides: Partial<VaultSearchDeps> = {}): VaultSearchDeps {
  return {
    store,
    embed: embed.embed,
    embeddingModel: MODEL,
    now: () => new Date(clock),
    log: { info: (o) => { logged.push(o) }, debug: (o) => { logged.push(o) } },
    dbExecute: (fn) => fn(),
    ...overrides,
  }
}

async function seedNote(path: string, texts: string[], opts: { model?: string; commit?: string; title?: string } = {}) {
  await store.promoteNote({
    tenantId: TENANT,
    corpus: 'antigravityhq',
    vaultPath: path,
    noteTitle: opts.title ?? path,
    frontmatter: {},
    contentSha: `sha-${path}`,
    indexedCommitSha: opts.commit ?? 'commit-1',
    embeddingModel: opts.model ?? MODEL,
    sourceModifiedAt: new Date('2026-09-19T00:00:00Z'),
    indexedAt: new Date(clock),
    chunks: texts.map((t, i) => ({ headingPath: `H${i}`, charStart: i * 100, charEnd: i * 100 + t.length, content: t, embedding: vectorFor(t) })),
  })
}

async function seedRun(status: 'completed' | 'failed' | 'incomplete' | 'completed_with_failures' | 'noop', finishedAgoSec: number, extra: Partial<{ notesScanned: number; notesFailed: number; error: string }> = {}) {
  const startedAt = new Date(clock - finishedAgoSec * 1000 - 5_000)
  const id = await store.startRun({ tenantId: TENANT, corpus: 'antigravityhq', startedAt, fromCommit: null })
  await store.finishRun(id, {
    finishedAt: new Date(clock - finishedAgoSec * 1000),
    status,
    toCommit: status === 'failed' ? null : 'commit-1',
    notesScanned: extra.notesScanned ?? 3,
    notesIndexed: 3,
    notesFailed: extra.notesFailed ?? 0,
    failedPaths: [],
    error: extra.error ?? null,
  })
}

beforeEach(() => {
  store = createMemoryVaultStore()
  embed = createFakeEmbed()
  logged = []
  clock = Date.parse('2026-09-22T12:00:00Z')
})

describe('happy path', () => {
  it('returns ranked hits with full provenance, a fresh status and the sync block', async () => {
    await seedRun('completed', 120)
    await seedNote('Projects/Hub Overlay.md', ['pgvector index notes', 'unrelated cooking text'], { title: 'Hub Overlay' })
    await seedNote('Daily/2026-09-20.md', ['morning standup'], { title: '2026-09-20' })

    const res = await searchVault({ query: 'pgvector index notes', topK: 2 }, PRINCIPAL, deps())
    expect(res.status).toBe('fresh')
    expect(res.warnings).toEqual([])
    expect(res.queryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(res.hits).toHaveLength(2)
    expect(res.hits[0]).toEqual({
      vaultPath: 'Projects/Hub Overlay.md',
      noteTitle: 'Hub Overlay',
      headingPath: 'H0',
      charStart: 0,
      charEnd: 'pgvector index notes'.length,
      excerpt: 'pgvector index notes',
      similarity: 1,
      contentSha: 'sha-Projects/Hub Overlay.md',
      indexedCommitSha: 'commit-1',
      sourceModifiedAt: '2026-09-19T00:00:00.000Z',
      indexedAt: new Date(clock).toISOString(),
    })
    expect(res.hits[1].similarity).toBeLessThan(1)
    expect(res.sync).toEqual({
      indexedCommitSha: 'commit-1',
      indexedAt: new Date(clock - 120_000).toISOString(),
      syncLagSeconds: 120,
      coverage: { notesTotal: 3, notesIndexed: 2, notesFailed: 0 },
    })
  })

  it('an empty index is 200-shaped with hits: [] — never an error', async () => {
    await seedRun('completed', 10)
    const res = await searchVault({ query: 'anything' }, PRINCIPAL, deps())
    expect(res.hits).toEqual([])
    expect(res.status).toBe('fresh')
  })

  it('searches only rows on the ACTIVE embedding model and never a tombstoned note', async () => {
    await seedRun('completed', 10)
    await seedNote('A.md', ['same text'], { model: 'gemini-embedding-001' })
    await seedNote('B.md', ['same text'])
    await seedNote('C.md', ['same text'])
    await store.tombstoneNotes(TENANT, 'antigravityhq', ['C.md'], new Date(clock))
    const res = await searchVault({ query: 'same text', topK: 10 }, PRINCIPAL, deps())
    expect(res.hits.map((h) => h.vaultPath)).toEqual(['B.md'])
  })

  it('honors pathPrefix and clamps topK to the 1..20 range', async () => {
    await seedRun('completed', 10)
    for (let i = 0; i < 25; i++) await seedNote(`${i % 2 ? 'Projects' : 'Daily'}/n${i}.md`, ['text ' + i])
    const all = await searchVault({ query: 'text', topK: 99 }, PRINCIPAL, deps())
    expect(all.hits).toHaveLength(20)
    const scoped = await searchVault({ query: 'text', topK: 50, pathPrefix: 'Projects/' }, PRINCIPAL, deps())
    expect(scoped.hits.every((h) => h.vaultPath.startsWith('Projects/'))).toBe(true)
    expect(scoped.hits).toHaveLength(12)
  })

  it('is tenant-scoped: another tenant’s rows are invisible', async () => {
    await seedRun('completed', 10)
    await seedNote('X.md', ['tenant text'])
    const other = await searchVault({ query: 'tenant text' }, { tenantId: 'other', harness: 'hermes' }, deps())
    expect(other.hits).toEqual([])
  })
})

describe('freshness → stale', () => {
  it('flags stale when the index is older than minFreshnessSeconds, naming the lag, but still returns hits', async () => {
    await seedRun('completed', 3_600)
    await seedNote('A.md', ['alpha'])
    const res = await searchVault({ query: 'alpha', minFreshnessSeconds: 600 }, PRINCIPAL, deps())
    expect(res.status).toBe('stale')
    expect(res.hits).toHaveLength(1)
    expect(res.warnings[0]).toContain('3600s old')
    expect(res.warnings[0]).toContain('minFreshnessSeconds (600)')
    expect(res.sync.syncLagSeconds).toBe(3600)
  })

  it('stays fresh when the lag is within the requested freshness', async () => {
    await seedRun('completed', 300)
    const res = await searchVault({ query: 'x', minFreshnessSeconds: 600 }, PRINCIPAL, deps())
    expect(res.status).toBe('fresh')
  })

  it('is stale with a warning when no sync has ever completed', async () => {
    const res = await searchVault({ query: 'x' }, PRINCIPAL, deps())
    expect(res.status).toBe('stale')
    expect(res.sync).toEqual({ indexedCommitSha: null, indexedAt: null, syncLagSeconds: null, coverage: { notesTotal: 0, notesIndexed: 0, notesFailed: 0 } })
    expect(res.warnings.some((w) => w.includes('no completed sync'))).toBe(true)
  })

  it('adds a warning when the last run failed, stopped early, or left failures', async () => {
    await seedRun('completed', 100)
    await seedRun('failed', 50, { error: 'GitHub HTTP 401' })
    let res = await searchVault({ query: 'x' }, PRINCIPAL, deps())
    expect(res.status).toBe('fresh') // the successful run still anchors the index
    expect(res.sync.indexedCommitSha).toBe('commit-1')
    expect(res.warnings.some((w) => w.includes('last sync run failed') && w.includes('GitHub HTTP 401'))).toBe(true)

    await seedRun('completed_with_failures', 20, { notesFailed: 2 })
    res = await searchVault({ query: 'x' }, PRINCIPAL, deps())
    expect(res.warnings.some((w) => w.includes('2 note(s) failed'))).toBe(true)
    expect(res.sync.coverage.notesFailed).toBe(2)

    await seedRun('incomplete', 5)
    res = await searchVault({ query: 'x' }, PRINCIPAL, deps())
    expect(res.warnings.some((w) => w.includes('stopped before indexing'))).toBe(true)
  })
})

describe('unavailable vs empty', () => {
  it('an embedding outage REJECTS (503 material) instead of resolving to zero hits', async () => {
    await seedRun('completed', 10)
    await seedNote('A.md', ['alpha'])
    embed.failWhen = () => true
    const err = await searchVault({ query: 'alpha' }, PRINCIPAL, deps()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultUnavailableError)
    expect((err as VaultUnavailableError).stage).toBe('embedding')
    const line = logged.find((l) => l.status === 'unavailable')
    expect(line).toMatchObject({ stage: 'embedding', reason: 'http' })
  })

  it('a DB outage (ledger or query) REJECTS with stage db', async () => {
    store.outage = new Error('connection refused')
    const err = await searchVault({ query: 'alpha' }, PRINCIPAL, deps()).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(VaultUnavailableError)
    expect((err as VaultUnavailableError)).toMatchObject({ stage: 'db', reason: 'internal' })
    expect((err as Error).message).toContain('connection refused')
  })

  it('an open DB circuit is reported as breaker_open without touching the store', async () => {
    let touched = 0
    const err = await searchVault({ query: 'alpha' }, PRINCIPAL, deps({
      dbExecute: async () => { touched++; throw new CircuitOpenError('vault-db') },
    })).catch((e: unknown) => e)
    expect(err).toMatchObject({ stage: 'db', reason: 'breaker_open' })
    expect(touched).toBe(1)
  })
})

describe('latency cap → partial', () => {
  it('returns 200-shaped `partial` with a warning when the embedding outlives maxLatencyMs, instead of hanging', async () => {
    await seedRun('completed', 10)
    await seedNote('A.md', ['alpha'])
    const slowEmbed: VaultSearchDeps['embed'] = () => new Promise(() => {}) // never settles
    const res = await searchVault({ query: 'alpha', maxLatencyMs: 30 }, PRINCIPAL, deps({ embed: slowEmbed }))
    expect(res.status).toBe('partial')
    expect(res.hits).toEqual([])
    expect(res.warnings[0]).toContain('maxLatencyMs (30) expired while embedding')
    expect(res.sync.indexedCommitSha).toBe('commit-1') // the ledger read had finished
  })

  it('returns `partial` when the index query is the slow one', async () => {
    await seedRun('completed', 10)
    const slowStore = { ...store, searchChunks: () => new Promise<never>(() => {}) }
    const res = await searchVault({ query: 'alpha', maxLatencyMs: 30 }, PRINCIPAL, deps({ store: slowStore }))
    expect(res.status).toBe('partial')
    expect(res.warnings[0]).toContain('expired during the index query')
  })

  it('returns `partial` with an empty provenance block when even the ledger read is too slow', async () => {
    const slowStore = { ...store, getSyncStatus: () => new Promise<never>(() => {}) }
    const res = await searchVault({ query: 'alpha', maxLatencyMs: 30 }, PRINCIPAL, deps({ store: slowStore }))
    expect(res.status).toBe('partial')
    expect(res.sync.syncLagSeconds).toBeNull()
    expect(res.warnings[0]).toContain('sync ledger')
  })

  it('caps maxLatencyMs at the hard ceiling', async () => {
    await seedRun('completed', 10)
    const res = await searchVault({ query: 'alpha', maxLatencyMs: 999_999 }, PRINCIPAL, deps())
    expect(res.status).toBe('fresh')
    expect(MAX_LATENCY_CAP_MS).toBe(10_000)
  })

  it('partial takes precedence over stale, and both warnings are kept', async () => {
    await seedRun('completed', 9_000)
    const res = await searchVault({ query: 'alpha', maxLatencyMs: 30, minFreshnessSeconds: 60 }, PRINCIPAL, deps({ embed: () => new Promise(() => {}) }))
    expect(res.status).toBe('partial')
    expect(res.warnings.some((w) => w.includes('expired'))).toBe(true)
    // Freshness is only judged on a result we actually produced.
    expect(res.warnings.some((w) => w.includes('older than'))).toBe(false)
  })
})

describe('logging discipline', () => {
  it('logs queryId, harness, tenant, query length and a SHA-256 — never the query text', async () => {
    await seedRun('completed', 10)
    const query = 'super secret plan for Q4 payroll'
    await searchVault({ query }, PRINCIPAL, deps())
    const line = logged.find((l) => l.status === 'fresh')!
    expect(line).toMatchObject({ harness: 'instinct', tenant: TENANT, queryLength: query.length, queryHash: hashQuery(query), hits: 0 })
    expect(typeof line.queryId).toBe('string')
    expect(JSON.stringify(logged)).not.toContain('payroll')
    expect(hashQuery(query)).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('buildSyncBlock', () => {
  it('derives the block from the last successful run and the active-model counts', () => {
    const now = new Date('2026-09-22T12:00:00Z')
    const block = buildSyncBlock({
      lastRun: { id: 'r2', startedAt: now, finishedAt: now, status: 'failed', fromCommit: null, toCommit: null, notesScanned: 0, notesIndexed: 0, notesFailed: 1, failedPaths: [], error: 'x' },
      lastSuccessfulRun: { id: 'r1', startedAt: new Date(now.getTime() - 70_000), finishedAt: new Date(now.getTime() - 60_000), status: 'completed', fromCommit: null, toCommit: 'abc', notesScanned: 12, notesIndexed: 12, notesFailed: 0, failedPaths: [], error: null },
      notesLive: 12,
      notesOnActiveModel: 11,
      chunksOnActiveModel: 40,
    }, now)
    expect(block).toEqual({ indexedCommitSha: 'abc', indexedAt: new Date(now.getTime() - 60_000).toISOString(), syncLagSeconds: 60, coverage: { notesTotal: 12, notesIndexed: 11, notesFailed: 1 } })
  })
})
