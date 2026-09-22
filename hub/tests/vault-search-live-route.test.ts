import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createMemoryVaultStore, type MemoryVaultStore } from '../test/vault-memory-store'
import { createFakeEmbed, vectorFor, type FakeEmbed } from '../test/vault-fake-embed'
import { createFakeMcp, FAKE_MCP_KEY, FAKE_MCP_URL, type FakeMcp } from '../test/vault-fake-mcp'
import { _resetSearchKeyCacheForTests } from '@/lib/vault/auth'
import { _resetSearchRateLimiterForTests } from '@/lib/vault/rate-limit'
import { _resetSmartConnectionsForTests, SMART_CONNECTIONS_BREAKER_KEY } from '@/lib/vault/smart-connections'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/knowledge/antigravityhq/search — Lane 2 (`includeLive`) through
   the REAL route, search engine, memory store, fake embedder and the fake
   Smart Connections MCP endpoint (global fetch stubbed; nothing real is ever
   dialled).

   Locks: includeLive defaults to false with a Lane 1 byte-identical response;
   disabled-when-unset never fetches; every live failure class leaves the
   canonical hits and status intact; the two deadlines; the circuit; tenant
   binding; scope + pathPrefix filtering; canonical precedence (a live hit on
   the same path never alters canonical hits) with live_confirms /
   possible_conflict warnings; a canonical failure is still Lane 1's 503; and
   logs never carry the key or live note text.
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
vi.mock('@/lib/event-logger', () => ({ recordEvent: vi.fn(async () => {}) }))
vi.mock('@/lib/vault/store', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/vault/store')>()),
  createDrizzleVaultStore: () => state.store,
}))
vi.mock('@/lib/vault/embeddings', () => ({
  embedForVault: (text: string, opts?: { signal?: AbortSignal }) => state.embed.embed(text, opts),
}))

import { POST } from '@/app/api/knowledge/antigravityhq/search/route'
import { breaker } from '@/lib/circuit-breaker'
import { EMBEDDING_MODEL } from '@/lib/vector-store'

const KEY_INSTINCT = 'instinct-key-0123456789abcdef'
const KEY_HERMES = 'hermes-key-fedcba9876543210-x'
const SEARCH_KEYS = JSON.stringify({
  [KEY_INSTINCT]: { harness: 'instinct', tenantId: 'rxfit' },
  [KEY_HERMES]: { harness: 'hermes', tenantId: 'other-tenant' },
})
const CANONICAL_HIT_KEYS = ['charEnd', 'charStart', 'contentSha', 'excerpt', 'headingPath', 'indexedAt', 'indexedCommitSha', 'noteTitle', 'similarity', 'sourceModifiedAt', 'vaultPath'].sort()
const LIVE_HIT_KEYS = [...CANONICAL_HIT_KEYS, 'live', 'source'].sort()
const LANE1_TOP_LEVEL = ['hits', 'queryId', 'status', 'sync', 'warnings'].sort()
const LIVE_TEXT = 'LIVE-ONLY-SECRET-TEXT about deploys via Cloudflare Workers with manual approval and canary rollout'

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
const asInstinctJson = async (body: unknown) => {
  const res = await asInstinct(body)
  return { status: res.status, body: await res.json() }
}

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

/** A snapshot with one note the query matches, so every test has canonical hits to protect. */
async function seedSnapshot() {
  await seedCompletedRun(30)
  await seedNote('Projects/Hub Overlay.md', ['pgvector notes', 'other text'])
}

function configureLive(fake: FakeMcp, extra: Record<string, string> = {}) {
  process.env.SMART_CONNECTIONS_URL = FAKE_MCP_URL
  process.env.SMART_CONNECTIONS_API_KEY = FAKE_MCP_KEY
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
  vi.stubGlobal('fetch', fake.fetch)
}

const ENV_KEYS = [
  'VAULT_SEARCH_KEYS', 'VAULT_GITHUB_TOKEN', 'VAULT_INCLUDE_GLOBS', 'VAULT_EXCLUDE_GLOBS', 'VAULT_SEARCH_RATE_CAPACITY', 'VAULT_SEARCH_RATE_REFILL_PER_SEC', 'JEV_API_KEY', 'NEXT_PUBLIC_TENANT_ID',
  'SMART_CONNECTIONS_URL', 'SMART_CONNECTIONS_API_KEY', 'SMART_CONNECTIONS_TOOL', 'SMART_CONNECTIONS_TIMEOUT_MS',
]

beforeEach(() => {
  state.session = null
  state.store = createMemoryVaultStore()
  state.embed = createFakeEmbed()
  state.logged = []
  process.env.VAULT_SEARCH_KEYS = SEARCH_KEYS
  process.env.VAULT_GITHUB_TOKEN = 'github_pat_TEST_NOT_REAL'
  process.env.VAULT_INCLUDE_GLOBS = 'Projects/**'
  process.env.VAULT_EXCLUDE_GLOBS = 'Private/**'
  _resetSearchKeyCacheForTests()
  _resetSearchRateLimiterForTests()
  _resetSmartConnectionsForTests()
  breaker.reset(SMART_CONNECTIONS_BREAKER_KEY)
})

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  vi.unstubAllGlobals()
  _resetSearchKeyCacheForTests()
  _resetSearchRateLimiterForTests()
  _resetSmartConnectionsForTests()
  breaker.reset(SMART_CONNECTIONS_BREAKER_KEY)
  vi.clearAllMocks()
})

describe('includeLive defaults to false — Lane 1 parity', () => {
  it('omitting includeLive and includeLive:false give the Lane 1 shape with no liveEvidence, and never dial the endpoint even when configured', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md', text: LIVE_TEXT }] })
    configureLive(fake)
    const omitted = await asInstinctJson({ query: 'pgvector notes', topK: 1 })
    const explicit = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: false })
    for (const r of [omitted, explicit]) {
      expect(r.status).toBe(200)
      expect(Object.keys(r.body).sort()).toEqual(LANE1_TOP_LEVEL)
      expect(r.body).not.toHaveProperty('liveEvidence')
      expect(r.body.status).toBe('fresh')
      expect(r.body.warnings).toEqual([])
      expect(r.body.hits).toHaveLength(1)
      expect(Object.keys(r.body.hits[0]).sort()).toEqual(CANONICAL_HIT_KEYS)
    }
    expect(omitted.body.hits).toEqual(explicit.body.hits)
    expect(fake.calls).toHaveLength(0)
  })

  it('400 when includeLive is not a boolean', async () => {
    const res = await asInstinct({ query: 'x', includeLive: 'yes' })
    expect(res.status).toBe(400)
    expect((await res.json()).issues[0]).toContain('includeLive')
  })
})

describe('includeLive: true — deny by default', () => {
  it('disabled with no fetch when the lane is unconfigured; snapshot hits intact; one warning', async () => {
    await seedSnapshot()
    const fake = createFakeMcp()
    vi.stubGlobal('fetch', fake.fetch) // configured? no — env unset
    const { status, body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(status).toBe(200)
    expect(body.status).toBe('fresh')
    expect(body.hits).toHaveLength(1)
    expect(body.liveEvidence).toEqual({ status: 'disabled', latencyMs: 0, hits: [], reason: 'unconfigured', detail: 'SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set', dropped: 0 })
    expect(body.warnings).toEqual(['live evidence disabled: SMART_CONNECTIONS_URL and SMART_CONNECTIONS_API_KEY are not set; canonical snapshot hits are unaffected'])
    expect(fake.calls).toHaveLength(0)
  })

  it('disabled with only one of the two variables set (fail closed)', async () => {
    await seedSnapshot()
    const fake = createFakeMcp()
    process.env.SMART_CONNECTIONS_URL = FAKE_MCP_URL
    vi.stubGlobal('fetch', fake.fetch)
    const { body } = await asInstinctJson({ query: 'pgvector notes', includeLive: true })
    expect(body.liveEvidence).toMatchObject({ status: 'disabled', detail: 'SMART_CONNECTIONS_API_KEY is not set' })
    expect(fake.calls).toHaveLength(0)
  })

  it('a key bound to another tenant gets disabled (the lane serves only the Hub tenant) and never dials', async () => {
    await seedCompletedRun(10)
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md', text: LIVE_TEXT }] })
    configureLive(fake)
    const res = await POST(req(`Bearer ${KEY_HERMES}`, { query: 'pgvector notes', includeLive: true }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.hits).toEqual([])
    expect(body.liveEvidence).toMatchObject({ status: 'disabled', reason: 'unconfigured', hits: [] })
    expect(body.liveEvidence.detail).toContain('bound to another tenant')
    expect(fake.calls).toHaveLength(0)
  })

  it('does not run at all while Lane 1 is dark (503 disabled, no fetch)', async () => {
    delete process.env.VAULT_GITHUB_TOKEN
    const fake = createFakeMcp()
    configureLive(fake)
    const { status, body } = await asInstinctJson({ query: 'x', includeLive: true })
    expect(status).toBe(503)
    expect(body).toEqual({ status: 'disabled', corpus: 'antigravityhq', warnings: [], hits: [] })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('includeLive: true — canonical precedence is absolute', () => {
  it('live ok: hits land in liveEvidence with the live shape; canonical hits are identical to a run without includeLive', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({
      results: [
        { key: 'Projects/Hub Overlay.md#Notes', score: 0.91, text: 'pgvector notes' },
        { key: 'Projects/Brand New.md', score: 0.4, text: LIVE_TEXT },
      ],
    })
    configureLive(fake)
    const without = await asInstinctJson({ query: 'pgvector notes', topK: 5 })
    const withLive = await asInstinctJson({ query: 'pgvector notes', topK: 5, includeLive: true })
    expect(withLive.status).toBe(200)
    expect(withLive.body.status).toBe('fresh')
    expect(withLive.body.hits).toEqual(without.body.hits) // never re-ranked, filtered, merged or de-duplicated
    expect(withLive.body.hits.map((h: { vaultPath: string }) => h.vaultPath)).toEqual(['Projects/Hub Overlay.md', 'Projects/Hub Overlay.md'])

    const live = withLive.body.liveEvidence
    expect(live).toMatchObject({ status: 'ok', reason: null, detail: null, dropped: 0 })
    expect(live.latencyMs).toBeGreaterThanOrEqual(0)
    expect(live.hits).toHaveLength(2)
    expect(Object.keys(live.hits[0]).sort()).toEqual(LIVE_HIT_KEYS)
    expect(live.hits[0]).toEqual({
      vaultPath: 'Projects/Hub Overlay.md',
      noteTitle: 'Hub Overlay',
      headingPath: 'Notes',
      charStart: null,
      charEnd: null,
      excerpt: 'pgvector notes',
      similarity: 0.91,
      contentSha: null,
      indexedCommitSha: null,
      sourceModifiedAt: null,
      indexedAt: null,
      source: 'smart_connections_live',
      live: true,
    })
    expect(live.hits[1].vaultPath).toBe('Projects/Brand New.md')
    // The live-only note never leaks into the canonical list.
    expect(withLive.body.hits.some((h: { vaultPath: string }) => h.vaultPath === 'Projects/Brand New.md')).toBe(false)
    expect(withLive.body.warnings).toEqual(['live_confirms:Projects/Hub Overlay.md'])
    expect(fake.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
    expect(fake.calls[3].params).toMatchObject({ name: 'search_notes', arguments: { query: 'pgvector notes', limit: 5 } })
  })

  it('possible_conflict when the live excerpt for a canonical path clearly differs — canonical excerpt still the indexed one', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md', text: LIVE_TEXT }] })
    configureLive(fake)
    const { body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(body.warnings).toEqual([
      'live_confirms:Projects/Hub Overlay.md',
      'possible_conflict:Projects/Hub Overlay.md — live desktop content differs from the indexed snapshot; the canonical snapshot remains authoritative until the next sync',
    ])
    expect(body.hits[0].excerpt).toBe('pgvector notes')
    expect(body.hits[0].contentSha).toBe('sha-Projects/Hub Overlay.md')
    expect(body.liveEvidence.hits[0].excerpt).toBe(LIVE_TEXT)
  })

  it('live hits outside the canonical scope or the pathPrefix are dropped and counted, never returned', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({
      results: [
        { key: 'Private/Secrets.md', text: 'never returned' },
        { key: 'Projects/Other/Thing.md', text: 'outside the prefix' },
        { key: 'Projects/Hub Overlay.md', text: 'pgvector notes' },
        { text: 'no path at all' },
      ],
    })
    configureLive(fake)
    const { body } = await asInstinctJson({ query: 'pgvector notes', topK: 3, pathPrefix: 'Projects/Hub', includeLive: true })
    expect(body.liveEvidence.status).toBe('ok')
    expect(body.liveEvidence.hits.map((h: { vaultPath: string }) => h.vaultPath)).toEqual(['Projects/Hub Overlay.md'])
    expect(body.liveEvidence.dropped).toBe(3)
    expect(JSON.stringify(body)).not.toContain('Secrets')
  })

  it('a canonical failure is still Lane 1’s 503 body — live evidence is never returned in its place', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md', text: LIVE_TEXT }] })
    configureLive(fake)
    state.embed.failWhen = () => true
    const { status, body } = await asInstinctJson({ query: 'pgvector notes', includeLive: true })
    expect(status).toBe(503)
    expect(Object.keys(body).sort()).toEqual(['corpus', 'hits', 'reason', 'stage', 'status', 'warnings'].sort())
    expect(body).toMatchObject({ status: 'unavailable', stage: 'embedding', hits: [] })
    expect(JSON.stringify(body)).not.toContain('LIVE-ONLY')
  })
})

describe('includeLive: true — live failures never fail the request', () => {
  const expectIntact = (body: { status: string; hits: unknown[]; liveEvidence: { hits: unknown[] } }) => {
    expect(body.status).toBe('fresh')
    expect(body.hits).toHaveLength(1)
    expect(body.liveEvidence.hits).toEqual([])
  }

  it('auth failure → unavailable/auth with a warning; the response and logs never carry the key', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ mode: 'auth' })
    configureLive(fake)
    const { status, body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(status).toBe(200)
    expectIntact(body)
    expect(body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'auth' })
    expect(body.liveEvidence.detail).toContain('HTTP 401')
    expect(body.warnings[0]).toMatch(/^live evidence unavailable \(auth\): .*canonical snapshot hits are unaffected$/)
    const text = JSON.stringify(body) + JSON.stringify(state.logged)
    expect(text).not.toContain(FAKE_MCP_KEY)
  })

  it('unreachable host → unavailable/network', async () => {
    await seedSnapshot()
    configureLive(createFakeMcp({ mode: 'unreachable' }))
    const { body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expectIntact(body)
    expect(body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'network' })
  })

  it('garbage (HTML) → unavailable/protocol; a tool error and a JSON-RPC error likewise', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ mode: 'garbage' })
    configureLive(fake)
    let r = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expectIntact(r.body)
    expect(r.body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'protocol' })
    fake.mode = 'tool_error'
    r = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(r.body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'protocol', detail: expect.stringContaining('model unavailable') })
    fake.mode = 'rpc_error'
    r = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(r.body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'protocol' })
  })

  it('a hung desktop → liveEvidence.status timeout after the lane budget, snapshot hits intact, the call aborted', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ mode: 'hang' })
    configureLive(fake, { SMART_CONNECTIONS_TIMEOUT_MS: '100' })
    const t0 = Date.now()
    const { status, body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expect(status).toBe(200)
    expect(Date.now() - t0).toBeLessThan(3_000)
    expectIntact(body)
    expect(body.liveEvidence).toMatchObject({ status: 'timeout', reason: 'timeout' })
    expect(body.liveEvidence.detail).toContain('live timeout (100ms) expired')
    expect(body.warnings[0]).toContain('live evidence timed out')
    expect(fake.hung[0].aborted).toBe(true)
  })

  it('a tight maxLatencyMs abandons the live call (request deadline) while the snapshot answers normally', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ mode: 'hang' })
    configureLive(fake) // default 4000ms lane budget — the request deadline is the tighter one
    const { status, body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, maxLatencyMs: 150, includeLive: true })
    expect(status).toBe(200)
    expectIntact(body)
    expect(body.liveEvidence.status).toBe('timeout')
    expect(body.liveEvidence.detail).toMatch(/request maxLatencyMs deadline \(\d+ms remaining\) expired/)
    expect(fake.hung[0].aborted).toBe(true)
  })

  it('the vault-smart-connections circuit opens after repeated failures and then fails fast without dialling', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ mode: 'http_500' })
    configureLive(fake)
    for (let i = 0; i < 3; i++) {
      const { body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
      expectIntact(body)
      expect(body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'http' })
    }
    expect(breaker.getState(SMART_CONNECTIONS_BREAKER_KEY)).toBe('open')
    const dialled = fake.calls.length
    const { body } = await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    expectIntact(body)
    expect(body.liveEvidence).toMatchObject({ status: 'unavailable', reason: 'breaker_open' })
    expect(body.warnings[0]).toContain('breaker_open')
    expect(fake.calls).toHaveLength(dialled)
  })
})

describe('includeLive: true — logging discipline', () => {
  it('logs the outcome with the endpoint host and counts — never live note text, never the key, never the query', async () => {
    await seedSnapshot()
    const fake = createFakeMcp({ results: [{ key: 'Projects/Hub Overlay.md', text: LIVE_TEXT }] })
    configureLive(fake)
    await asInstinctJson({ query: 'pgvector notes', topK: 1, includeLive: true })
    const line = state.logged.find((l) => l.live && typeof l.live === 'object')
    expect(line).toBeDefined()
    expect(line!.live).toEqual({ status: 'ok', reason: null, latencyMs: expect.any(Number), hits: 1, dropped: 0, host: 'desktop.example.test' })
    expect(line).toMatchObject({ harness: 'instinct', tenant: 'rxfit' })
    const text = JSON.stringify(state.logged)
    expect(text).not.toContain('LIVE-ONLY')
    expect(text).not.toContain(FAKE_MCP_KEY)
    expect(text).not.toContain('pgvector notes')
  })
})
