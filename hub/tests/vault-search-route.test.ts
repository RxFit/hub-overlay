import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createMemoryVaultStore, type MemoryVaultStore } from '../test/vault-memory-store'
import { createFakeEmbed, vectorFor, type FakeEmbed } from '../test/vault-fake-embed'
import { _resetSearchKeyCacheForTests } from '@/lib/vault/auth'
import { _resetSearchRateLimiterForTests } from '@/lib/vault/rate-limit'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/knowledge/antigravityhq/search — route contract, fully offline.

   Auth denials (missing key, wrong key, unknown harness key, cross-tenant
   body, non-admin session), deny-by-default 503s, zod validation, the
   per-harness rate limit (429 + Retry-After), and the response statuses
   (fresh / stale / partial / unavailable) through the REAL search engine
   against the memory store and fake embedder. Query text never reaches logs.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    store: null as unknown as MemoryVaultStore,
    embed: null as unknown as FakeEmbed,
    logged: [] as Array<Record<string, unknown>>,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: (o: Record<string, unknown>) => { state.logged.push(o) },
    warn: (o: Record<string, unknown>) => { state.logged.push(o) },
    error: (o: Record<string, unknown>) => { state.logged.push(o) },
    debug: (o: Record<string, unknown>) => { state.logged.push(o) },
  }),
}))
vi.mock('@/lib/vault/store', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/vault/store')>()),
  createDrizzleVaultStore: () => state.store,
}))
vi.mock('@/lib/vault/embeddings', () => ({
  embedForVault: (text: string, opts?: { signal?: AbortSignal }) => state.embed.embed(text, opts),
}))

import { POST } from '@/app/api/knowledge/antigravityhq/search/route'
import { EMBEDDING_MODEL } from '@/lib/vector-store'

const KEY_INSTINCT = 'instinct-key-0123456789abcdef'
const KEY_HERMES = 'hermes-key-fedcba9876543210-x'
const SEARCH_KEYS = JSON.stringify({
  [KEY_INSTINCT]: { harness: 'instinct', tenantId: 'rxfit' },
  [KEY_HERMES]: { harness: 'hermes', tenantId: 'other-tenant' },
})
const ADMIN = { user: { email: 'danny@rxfitatx.com', role: 'admin' } }
const STAFF = { user: { email: 'staff@rxfitatx.com', role: 'staff' } }

function req(authHeader: string | null, body: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authHeader !== null) headers.authorization = authHeader
  return new NextRequest('http://localhost/api/knowledge/antigravityhq/search', {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const asInstinct = (body: unknown) => POST(req(`Bearer ${KEY_INSTINCT}`, body))

async function seedNote(path: string, texts: string[], tenantId = 'rxfit') {
  await state.store.promoteNote({
    tenantId,
    corpus: 'antigravityhq',
    vaultPath: path,
    noteTitle: path.replace(/\.md$/, ''),
    frontmatter: {},
    contentSha: `sha-${path}`,
    indexedCommitSha: 'commit-1',
    embeddingModel: EMBEDDING_MODEL,
    sourceModifiedAt: null,
    indexedAt: new Date(),
    chunks: texts.map((t, i) => ({ headingPath: `H${i}`, charStart: 0, charEnd: t.length, content: t, embedding: vectorFor(t) })),
  })
}

async function seedCompletedRun(agoSec: number, tenantId = 'rxfit') {
  const id = await state.store.startRun({ tenantId, corpus: 'antigravityhq', startedAt: new Date(Date.now() - agoSec * 1000 - 1000), fromCommit: null })
  await state.store.finishRun(id, { finishedAt: new Date(Date.now() - agoSec * 1000), status: 'completed', toCommit: 'commit-1', notesScanned: 1, notesIndexed: 1, notesFailed: 0, failedPaths: [], error: null })
}

const ENV_KEYS = ['VAULT_SEARCH_KEYS', 'VAULT_GITHUB_TOKEN', 'VAULT_INCLUDE_GLOBS', 'VAULT_SEARCH_RATE_CAPACITY', 'VAULT_SEARCH_RATE_REFILL_PER_SEC', 'JEV_API_KEY', 'NEXT_PUBLIC_TENANT_ID']

beforeEach(() => {
  state.session = null
  state.store = createMemoryVaultStore()
  state.embed = createFakeEmbed()
  state.logged = []
  process.env.VAULT_SEARCH_KEYS = SEARCH_KEYS
  process.env.VAULT_GITHUB_TOKEN = 'github_pat_TEST_NOT_REAL'
  process.env.VAULT_INCLUDE_GLOBS = 'Projects/**'
  _resetSearchKeyCacheForTests()
  _resetSearchRateLimiterForTests()
})

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  _resetSearchKeyCacheForTests()
  _resetSearchRateLimiterForTests()
  vi.clearAllMocks()
})

describe('auth denials', () => {
  it('401 with no bearer and no session', async () => {
    const res = await POST(req(null, { query: 'x' }))
    expect(res.status).toBe(401)
    expect(state.embed.calls).toHaveLength(0)
  })

  it('401 for a wrong key of the same length and for a key that is not in the map (unknown harness)', async () => {
    expect((await POST(req(`Bearer ${KEY_INSTINCT.slice(0, -1)}X`, { query: 'x' }))).status).toBe(401)
    expect((await POST(req('Bearer unknown-harness-key-0000000000', { query: 'x' }))).status).toBe(401)
    expect(state.embed.calls).toHaveLength(0)
  })

  it('a bad bearer never falls back to the session, even for a signed-in admin', async () => {
    state.session = ADMIN
    expect((await POST(req('Bearer bad-key-000000000000000', { query: 'x' }))).status).toBe(401)
  })

  it('fails closed when VAULT_SEARCH_KEYS is unset or malformed', async () => {
    delete process.env.VAULT_SEARCH_KEYS
    _resetSearchKeyCacheForTests()
    expect((await asInstinct({ query: 'x' })).status).toBe(401)
    process.env.VAULT_SEARCH_KEYS = '{not json'
    _resetSearchKeyCacheForTests()
    expect((await asInstinct({ query: 'x' })).status).toBe(401)
  })

  it('403 for a cross-tenant attempt: the body tenantId does not match the key’s binding', async () => {
    await seedCompletedRun(10)
    await seedNote('Other.md', ['other tenant secret'], 'other-tenant')
    const res = await asInstinct({ query: 'other tenant secret', tenantId: 'other-tenant' })
    expect(res.status).toBe(403)
    expect(state.embed.calls).toHaveLength(0)
  })

  it('the tenant comes from the key binding, not the body: hermes cannot see rxfit rows', async () => {
    await seedCompletedRun(10)
    await seedNote('Projects/Secret.md', ['rxfit only text'])
    const res = await POST(req(`Bearer ${KEY_HERMES}`, { query: 'rxfit only text' }))
    expect(res.status).toBe(200)
    expect((await res.json()).hits).toEqual([])
  })

  it('session path: admin may inspect, staff/onboarding/no session may not', async () => {
    await seedCompletedRun(10)
    state.session = ADMIN
    const ok = await POST(req(null, { query: 'x' }))
    expect(ok.status).toBe(200)
    state.session = STAFF
    expect((await POST(req(null, { query: 'x' }))).status).toBe(401)
    state.session = { user: { email: 'new@rxfitatx.com', role: 'onboarding' } }
    expect((await POST(req(null, { query: 'x' }))).status).toBe(401)
    state.session = null
    expect((await POST(req(null, { query: 'x' }))).status).toBe(401)
  })

  it('session path: a body tenantId that is not the server-side tenant is a 403', async () => {
    state.session = ADMIN
    expect((await POST(req(null, { query: 'x', tenantId: 'other-tenant' }))).status).toBe(403)
    expect((await POST(req(null, { query: 'x', tenantId: 'rxfit' }))).status).not.toBe(403)
  })
})

describe('readiness — dark until configured, even for a valid key', () => {
  it('503 disabled without VAULT_GITHUB_TOKEN', async () => {
    delete process.env.VAULT_GITHUB_TOKEN
    const res = await asInstinct({ query: 'x' })
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'disabled', corpus: 'antigravityhq', warnings: [], hits: [] })
    expect(state.embed.calls).toHaveLength(0)
  })

  it('503 awaiting_scope_config without include globs', async () => {
    process.env.VAULT_INCLUDE_GLOBS = ''
    const res = await asInstinct({ query: 'x' })
    expect(res.status).toBe(503)
    expect((await res.json()).status).toBe('awaiting_scope_config')
    expect(state.embed.calls).toHaveLength(0)
  })
})

describe('validation', () => {
  it.each([
    ['empty query', { query: '' }],
    ['query too long', { query: 'x'.repeat(2001) }],
    ['topK 0', { query: 'x', topK: 0 }],
    ['topK 21', { query: 'x', topK: 21 }],
    ['maxLatencyMs over the cap', { query: 'x', maxLatencyMs: 10_001 }],
    ['negative freshness', { query: 'x', minFreshnessSeconds: -1 }],
    ['unknown field', { query: 'x', unexpected: 1 }],
    ['not an object', 'just a string'],
    ['invalid JSON', '{nope'],
  ])('400 for %s', async (_label, body) => {
    const res = await asInstinct(body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Invalid body')
    expect(state.embed.calls).toHaveLength(0)
  })
})

describe('rate limit — per harness, per instance', () => {
  it('429 with Retry-After once a harness exhausts its bucket; other harnesses unaffected', async () => {
    process.env.VAULT_SEARCH_RATE_CAPACITY = '2'
    process.env.VAULT_SEARCH_RATE_REFILL_PER_SEC = '0.001'
    _resetSearchRateLimiterForTests()
    await seedCompletedRun(10)
    expect((await asInstinct({ query: 'x' })).status).toBe(200)
    expect((await asInstinct({ query: 'x' })).status).toBe(200)
    const limited = await asInstinct({ query: 'x' })
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await limited.json()).error).toBe('Rate limited')
    expect((await POST(req(`Bearer ${KEY_HERMES}`, { query: 'x' }))).status).toBe(200)
  })

  it('rate limiting happens BEFORE validation and readiness (a runaway loop of bad requests is still throttled)', async () => {
    process.env.VAULT_SEARCH_RATE_CAPACITY = '1'
    process.env.VAULT_SEARCH_RATE_REFILL_PER_SEC = '0.001'
    _resetSearchRateLimiterForTests()
    expect((await asInstinct({ query: '' })).status).toBe(400)
    expect((await asInstinct({ query: '' })).status).toBe(429)
  })
})

describe('response contract', () => {
  it('200 with the full provenance shape on a hit, status fresh, sync block populated', async () => {
    await seedCompletedRun(30)
    await seedNote('Projects/Hub Overlay.md', ['pgvector notes', 'other text'])
    const res = await asInstinct({ query: 'pgvector notes', topK: 1 })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('fresh')
    expect(body.warnings).toEqual([])
    expect(body.queryId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.sync).toMatchObject({ indexedCommitSha: 'commit-1', coverage: { notesTotal: 1, notesIndexed: 1, notesFailed: 0 } })
    expect(body.sync.syncLagSeconds).toBeGreaterThanOrEqual(29)
    expect(body.hits).toHaveLength(1)
    expect(Object.keys(body.hits[0]).sort()).toEqual(
      ['charEnd', 'charStart', 'contentSha', 'excerpt', 'headingPath', 'indexedAt', 'indexedCommitSha', 'noteTitle', 'similarity', 'sourceModifiedAt', 'vaultPath'].sort(),
    )
    expect(body.hits[0]).toMatchObject({ vaultPath: 'Projects/Hub Overlay.md', noteTitle: 'Projects/Hub Overlay', excerpt: 'pgvector notes', contentSha: 'sha-Projects/Hub Overlay.md', indexedCommitSha: 'commit-1' })
  })

  it('an empty index is 200 with hits: [] (stale, since nothing has synced)', async () => {
    const res = await asInstinct({ query: 'anything' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hits).toEqual([])
    expect(body.status).toBe('stale')
    expect(body.warnings[0]).toContain('no completed sync')
  })

  it('stale when older than minFreshnessSeconds; partial when maxLatencyMs expires', async () => {
    await seedCompletedRun(600)
    const stale = await (await asInstinct({ query: 'x', minFreshnessSeconds: 60 })).json()
    expect(stale.status).toBe('stale')
    expect(stale.warnings[0]).toMatch(/older than the requested minFreshnessSeconds \(60\)/)

    state.embed.embed = () => new Promise(() => {})
    const partial = await asInstinct({ query: 'x', maxLatencyMs: 25 })
    expect(partial.status).toBe(200)
    const pb = await partial.json()
    expect(pb.status).toBe('partial')
    expect(pb.hits).toEqual([])
    expect(pb.warnings[0]).toContain('maxLatencyMs (25) expired')
  })

  it('503 unavailable (never an empty 200) when the embedding upstream fails', async () => {
    await seedCompletedRun(10)
    await seedNote('Projects/A.md', ['alpha'])
    state.embed.failWhen = () => true
    const res = await asInstinct({ query: 'alpha' })
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'unavailable', corpus: 'antigravityhq', stage: 'embedding', hits: [] })
    expect(body.warnings[0]).toContain('simulated embedding failure')
  })

  it('503 unavailable when the index store is down', async () => {
    state.store.outage = new Error('connection refused')
    const res = await asInstinct({ query: 'alpha' })
    expect(res.status).toBe(503)
    expect((await res.json()).stage).toBe('db')
  })

  it('logs the query hash and length, never the query text or excerpts', async () => {
    await seedCompletedRun(10)
    await seedNote('Projects/A.md', ['confidential payroll figures'])
    await asInstinct({ query: 'confidential payroll figures' })
    const text = JSON.stringify(state.logged)
    expect(text).toContain('"harness":"instinct"')
    expect(text).toMatch(/"queryHash":"[0-9a-f]{64}"/)
    expect(text).not.toContain('payroll')
  })

  it('the JEV seam never changes the response, key or no key', async () => {
    await seedCompletedRun(10)
    await seedNote('Projects/A.md', ['alpha'])
    const off = await (await asInstinct({ query: 'alpha' })).json()
    process.env.JEV_API_KEY = 'not-a-real-key'
    const on = await (await asInstinct({ query: 'alpha' })).json()
    expect(on.hits).toEqual(off.hits)
    expect(on.status).toBe(off.status)
    expect(on).not.toHaveProperty('evaluation')
  })
})
