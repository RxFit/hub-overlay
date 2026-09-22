import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createMemoryVaultStore, type MemoryVaultStore } from '../test/vault-memory-store'
import { createFakeEmbed, type FakeEmbed } from '../test/vault-fake-embed'
import { _resetSearchKeyCacheForTests } from '@/lib/vault/auth'
import { _resetSmartConnectionsForTests } from '@/lib/vault/smart-connections'
import { createFakeMcp, FAKE_MCP_KEY, FAKE_MCP_URL } from '../test/vault-fake-mcp'

/* ════════════════════════════════════════════════════════════════════════════
   GET /api/admin/vault-search-health — admin gate (401/403), 503 with the
   failing stage while the feature is dark, 200 once configured + synced +
   embedding reachable, and `?probe=0` skipping the live embedding call.
   Presence booleans and counts only.
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    session: null as unknown,
    store: null as unknown as MemoryVaultStore,
    embed: null as unknown as FakeEmbed,
  },
}))

vi.mock('next-auth', () => ({ getServerSession: vi.fn(async () => state.session) }))
vi.mock('@/lib/auth', () => ({ authOptions: {} }))
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/vault/store', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/vault/store')>()),
  createDrizzleVaultStore: () => state.store,
}))
vi.mock('@/lib/vault/embeddings', () => ({
  embedForVault: (text: string, opts?: { signal?: AbortSignal }) => state.embed.embed(text, opts),
}))

import { GET } from '@/app/api/admin/vault-search-health/route'

const ADMIN = { user: { email: 'danny@rxfitatx.com', role: 'superadmin' } }
const request = (path = '/api/admin/vault-search-health') => new NextRequest(`http://localhost:3000${path}`)
const ENV_KEYS = ['VAULT_SYNC_API_KEY', 'VAULT_SEARCH_KEYS', 'VAULT_GITHUB_TOKEN', 'VAULT_INCLUDE_GLOBS', 'VAULT_EXCLUDE_GLOBS', 'SMART_CONNECTIONS_URL', 'SMART_CONNECTIONS_API_KEY']

async function seedRun(status: 'completed' | 'failed', extra: Partial<{ error: string; notesFailed: number }> = {}) {
  const id = await state.store.startRun({ tenantId: 'rxfit', corpus: 'antigravityhq', startedAt: new Date(Date.now() - 5_000), fromCommit: null })
  await state.store.finishRun(id, { finishedAt: new Date(), status, toCommit: status === 'failed' ? null : 'c0ffee'.padEnd(40, '0'), notesScanned: 3, notesIndexed: 3, notesFailed: extra.notesFailed ?? 0, failedPaths: [], error: extra.error ?? null })
}

function configureAll() {
  process.env.VAULT_GITHUB_TOKEN = 'github_pat_TEST_NOT_REAL'
  process.env.VAULT_INCLUDE_GLOBS = 'Projects/**'
  process.env.VAULT_EXCLUDE_GLOBS = 'Private/**'
  process.env.VAULT_SYNC_API_KEY = 'sync-key-0123456789abcdef'
  process.env.VAULT_SEARCH_KEYS = JSON.stringify({ 'instinct-key-0123456789abcdef': { harness: 'instinct', tenantId: 'rxfit' } })
  _resetSearchKeyCacheForTests()
}

beforeEach(() => {
  state.session = ADMIN
  state.store = createMemoryVaultStore()
  state.embed = createFakeEmbed()
})

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  _resetSearchKeyCacheForTests()
  _resetSmartConnectionsForTests()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('GET /api/admin/vault-search-health', () => {
  it('401 without a session, 403 for non-admins — and no probe is spent', async () => {
    state.session = null
    expect((await GET(request())).status).toBe(401)
    state.session = { user: { email: 'staff@rxfitatx.com', role: 'staff' } }
    expect((await GET(request())).status).toBe(403)
    expect(state.embed.calls).toHaveLength(0)
  })

  it('503 disabled with the config stage failing and the owner remediation while the token is unbound', async () => {
    const res = await GET(request())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.healthy).toBe(false)
    expect(body.readiness).toBe('disabled')
    expect(body.config).toMatchObject({ githubTokenConfigured: false, scopeConfigured: false, syncKeyConfigured: false, searchKeys: { configured: false } })
    expect(body.stages.find((s: { stage: string }) => s.stage === 'config')).toMatchObject({ status: 'fail' })
    expect(body.remediation).toContain('hub-vault-github-token')
    expect(body.summary).toContain('not ready')
    // Never a value: the report carries no token/key material.
    expect(JSON.stringify(body)).not.toContain('github_pat')
  })

  it('503 awaiting scope, then 503 with the sync stage failing before any run, then 200 once synced', async () => {
    process.env.VAULT_GITHUB_TOKEN = 'github_pat_TEST_NOT_REAL'
    let body = await (await GET(request())).json()
    expect(body.readiness).toBe('awaiting_scope_config')
    expect(body.remediation).toContain('VAULT_INCLUDE_GLOBS')

    configureAll()
    const res = await GET(request())
    expect(res.status).toBe(503)
    body = await res.json()
    expect(body.readiness).toBe('ready')
    expect(body.stages.find((s: { stage: string }) => s.stage === 'config')).toMatchObject({ status: 'ok' })
    expect(body.stages.find((s: { stage: string }) => s.stage === 'sync')).toMatchObject({ status: 'fail', detail: 'no sync run recorded yet' })
    expect(body.embedding).toMatchObject({ reachable: true })

    await seedRun('completed')
    const ok = await GET(request())
    expect(ok.status).toBe(200)
    body = await ok.json()
    expect(body.healthy).toBe(true)
    expect(body.lastRun).toMatchObject({ status: 'completed', notesScanned: 3 })
    expect(body.lastSuccessfulRun.toCommit).toMatch(/^c0ffee/)
    expect(body.coverage).toEqual({ notesLive: 0, notesOnActiveModel: 0, chunksOnActiveModel: 0, notesFailedLastRun: 0 })
    expect(body.summary).toContain('ready')
  })

  it('503 when the embedding probe fails, and ?probe=0 skips the probe entirely', async () => {
    configureAll()
    await seedRun('completed')
    state.embed.failWhen = () => true
    const failing = await GET(request())
    expect(failing.status).toBe(503)
    expect((await failing.json()).stages.find((s: { stage: string }) => s.stage === 'embedding')).toMatchObject({ status: 'fail' })

    state.embed.calls = []
    const skipped = await GET(request('/api/admin/vault-search-health?probe=0'))
    expect(skipped.status).toBe(200)
    const body = await skipped.json()
    expect(body.embedding).toEqual({ reachable: null, latencyMs: null, detail: 'probe skipped' })
    expect(state.embed.calls).toHaveLength(0)
  })

  it('reports the optional Smart Connections lane in its own section, probed only when configured, never affecting health', async () => {
    configureAll()
    await seedRun('completed')
    let body = await (await GET(request())).json()
    expect(body.healthy).toBe(true)
    expect(body.smartConnections).toEqual({ configured: false, reachable: null, latencyMs: null, detail: expect.stringContaining('not set') })

    const fake = createFakeMcp()
    process.env.SMART_CONNECTIONS_URL = FAKE_MCP_URL
    process.env.SMART_CONNECTIONS_API_KEY = FAKE_MCP_KEY
    vi.stubGlobal('fetch', fake.fetch)
    const ok = await GET(request())
    expect(ok.status).toBe(200)
    body = await ok.json()
    expect(body.smartConnections).toMatchObject({ configured: true, reachable: true })
    expect(body.smartConnections.latencyMs).toBeGreaterThanOrEqual(0)
    expect(body.smartConnections.detail).toContain('desktop.example.test')
    expect(body.smartConnections.detail).toContain('tool "search_notes"')
    expect(fake.methods()).toEqual(['initialize', 'notifications/initialized', 'tools/list']) // never a search
    expect(JSON.stringify(body)).not.toContain(FAKE_MCP_KEY)

    fake.mode = 'auth'
    const rejected = await GET(request())
    expect(rejected.status).toBe(200) // Lane 2 is optional: an unreachable desktop never turns the report red
    body = await rejected.json()
    expect(body.healthy).toBe(true)
    expect(body.smartConnections).toMatchObject({ configured: true, reachable: false, detail: expect.stringContaining('auth:') })
    expect(body.stages.map((s: { stage: string }) => s.stage)).not.toContain('smart_connections')

    fake.calls.length = 0
    body = await (await GET(request('/api/admin/vault-search-health?probe=0'))).json()
    expect(body.smartConnections).toMatchObject({ configured: true, reachable: null, latencyMs: null })
    expect(fake.calls).toHaveLength(0)
  })

  it('503 with the last failed run’s error when the last sync failed', async () => {
    configureAll()
    await seedRun('failed', { error: 'GitHub commit HEAD failed with HTTP 401' })
    const res = await GET(request())
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.stages.find((s: { stage: string }) => s.stage === 'sync').detail).toContain('HTTP 401')
  })
})
