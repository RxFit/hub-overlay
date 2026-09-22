import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { NextRequest } from 'next/server'
import { createMemoryVaultStore, type MemoryVaultStore } from '../test/vault-memory-store'
import { createFakeVault, type FakeVault } from '../test/vault-fake-github'
import { createFakeEmbed, type FakeEmbed } from '../test/vault-fake-embed'
import { VaultUnavailableError } from '@/lib/vault/errors'

/* ════════════════════════════════════════════════════════════════════════════
   POST /api/knowledge/antigravityhq/sync — route contract, fully offline.

   Locks the deny-by-default posture: constant-time bearer that fails closed,
   503 `disabled` without VAULT_GITHUB_TOKEN, 503 `awaiting_scope_config`
   without include globs (and in BOTH states nothing is fetched, embedded or
   written), tenant validation, and the happy path through the REAL sync
   engine against the fixture vault (fake GitHub + fake embedder + memory
   store — no network, no Postgres).
   ════════════════════════════════════════════════════════════════════════════ */

const { state } = vi.hoisted(() => ({
  state: {
    tenantRows: [{ id: 'rxfit' }] as { id: string }[],
    store: null as unknown as MemoryVaultStore,
    vault: null as unknown as FakeVault,
    embed: null as unknown as FakeEmbed,
    githubClientCalls: 0,
  },
}))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('@/lib/db', () => ({
  db: {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => state.tenantRows }) }) }),
  },
}))
vi.mock('@/lib/vault/store', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/vault/store')>()),
  createDrizzleVaultStore: () => state.store,
}))
vi.mock('@/lib/vault/github', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/vault/github')>()),
  createGitHubClient: () => {
    state.githubClientCalls++
    return state.vault
  },
}))
vi.mock('@/lib/vault/embeddings', () => ({
  embedForVault: (text: string, opts?: { signal?: AbortSignal }) => state.embed.embed(text, opts),
}))

import { POST } from '@/app/api/knowledge/antigravityhq/sync/route'

const SYNC_KEY = 'sync-key-0123456789abcdef-TEST'

function req(authHeader: string | null, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (authHeader !== null) headers.authorization = authHeader
  return new NextRequest('http://localhost/api/knowledge/antigravityhq/sync', {
    method: 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

const ENV_KEYS = ['VAULT_SYNC_API_KEY', 'VAULT_GITHUB_TOKEN', 'VAULT_INCLUDE_GLOBS', 'VAULT_EXCLUDE_GLOBS', 'VAULT_REPO', 'VAULT_REPO_REF']

beforeEach(() => {
  state.tenantRows = [{ id: 'rxfit' }]
  state.store = createMemoryVaultStore()
  state.vault = createFakeVault()
  state.embed = createFakeEmbed()
  state.githubClientCalls = 0
  process.env.VAULT_SYNC_API_KEY = SYNC_KEY
  process.env.VAULT_GITHUB_TOKEN = 'github_pat_TEST_NOT_REAL'
  process.env.VAULT_INCLUDE_GLOBS = 'Projects/**, Daily/**'
  process.env.VAULT_EXCLUDE_GLOBS = 'Private/**, Templates/**'
})

afterEach(() => {
  for (const k of ENV_KEYS) delete process.env[k]
  vi.clearAllMocks()
})

function expectNothingHappened() {
  expect(state.githubClientCalls).toBe(0)
  expect(state.vault.calls.head).toBe(0)
  expect(state.embed.calls).toHaveLength(0)
  expect(state.store.notes.size).toBe(0)
  expect(state.store.runs).toHaveLength(0)
}

describe('auth — constant-time bearer, fails closed', () => {
  it('rejects a missing header, a wrong key of the same length, and a wrong key of another length (401)', async () => {
    expect((await POST(req(null, {}))).status).toBe(401)
    expect((await POST(req(`Bearer ${SYNC_KEY.slice(0, -1)}X`, {}))).status).toBe(401)
    expect((await POST(req('Bearer nope', {}))).status).toBe(401)
    expectNothingHappened()
  })

  it('fails closed when VAULT_SYNC_API_KEY is unset — even "Bearer " is a 401', async () => {
    delete process.env.VAULT_SYNC_API_KEY
    expect((await POST(req('Bearer ', {}))).status).toBe(401)
    expect((await POST(req(`Bearer ${SYNC_KEY}`, {}))).status).toBe(401)
    expectNothingHappened()
  })
})

describe('readiness — dark until configured', () => {
  it('503 disabled without VAULT_GITHUB_TOKEN, and nothing is fetched or indexed', async () => {
    delete process.env.VAULT_GITHUB_TOKEN
    const res = await POST(req(`Bearer ${SYNC_KEY}`, {}))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'disabled', corpus: 'antigravityhq' })
    expectNothingHappened()
  })

  it('503 awaiting_scope_config with a token but no include globs (an exclude alone is not scope)', async () => {
    process.env.VAULT_INCLUDE_GLOBS = ''
    const res = await POST(req(`Bearer ${SYNC_KEY}`, {}))
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ status: 'awaiting_scope_config', corpus: 'antigravityhq' })
    expectNothingHappened()
  })
})

describe('body + tenant validation', () => {
  it('403 for an unknown tenantId even with a valid key', async () => {
    state.tenantRows = []
    const res = await POST(req(`Bearer ${SYNC_KEY}`, { tenantId: 'attacker' }))
    expect(res.status).toBe(403)
    expectNothingHappened()
  })

  it('400 for an invalid body (unknown field, out-of-range budget)', async () => {
    expect((await POST(req(`Bearer ${SYNC_KEY}`, { maxNotesPerRun: 0 }))).status).toBe(400)
    expect((await POST(req(`Bearer ${SYNC_KEY}`, { surprise: true }))).status).toBe(400)
    expectNothingHappened()
  })

  it('an empty body is fine (defaults: default tenant, default budget)', async () => {
    const res = await POST(req(`Bearer ${SYNC_KEY}`))
    expect(res.status).toBe(200)
    expect((await res.json()).tenantId).toBe('rxfit')
  })
})

describe('happy path through the real engine', () => {
  it('indexes the in-scope fixture notes and reports the run', async () => {
    const res = await POST(req(`Bearer ${SYNC_KEY}`, { tenantId: 'rxfit', resolveSourceModified: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({
      corpus: 'antigravityhq',
      repo: 'RxFit/antigravityhq-vault',
      ref: 'HEAD',
      tenantId: 'rxfit',
      status: 'completed',
      notesScanned: 3,
      notesIndexed: 3,
      notesFailed: 0,
      notesTombstoned: 0,
      notesRemaining: 0,
      failedPaths: [],
      toCommit: state.vault.head(),
    })
    expect(typeof body.runId).toBe('string')
    expect(state.store.notes.size).toBe(3)
    expect(state.store.note('Private/Secrets.md')).toBeUndefined()
    expect(state.store.runs[0].status).toBe('completed')

    // Re-running on the same commit is a recorded no-op.
    const again = await (await POST(req(`Bearer ${SYNC_KEY}`, { resolveSourceModified: false }))).json()
    expect(again.status).toBe('noop')
    expect(state.store.runs).toHaveLength(2)
  })

  it('respects VAULT_REPO / VAULT_REPO_REF and the per-run budget', async () => {
    process.env.VAULT_REPO = 'Org/some-vault'
    process.env.VAULT_REPO_REF = 'main'
    const body = await (await POST(req(`Bearer ${SYNC_KEY}`, { maxNotesPerRun: 1, resolveSourceModified: false }))).json()
    expect(body.repo).toBe('Org/some-vault')
    expect(body.ref).toBe('main')
    expect(body.status).toBe('incomplete')
    expect(body.notesRemaining).toBe(2)
  })

  it('never returns note content — only paths and counts', async () => {
    const text = await (await POST(req(`Bearer ${SYNC_KEY}`, { resolveSourceModified: false }))).text()
    expect(text).not.toContain('operations shell')
    expect(text).not.toContain('PLACEHOLDER_NOT_A_SECRET')
  })
})

describe('unavailable upstream', () => {
  it('503 unavailable with the failing stage when GitHub rejects, and the run is recorded as failed', async () => {
    state.vault.outage = new VaultUnavailableError('github', 'auth', 'GitHub commit HEAD failed with HTTP 401: Bad credentials', 401)
    const res = await POST(req(`Bearer ${SYNC_KEY}`, {}))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'unavailable', corpus: 'antigravityhq', stage: 'github', reason: 'auth' })
    expect(body.detail).toContain('HTTP 401')
    expect(body.detail).not.toContain('github_pat')
    expect(state.store.runs[0].status).toBe('failed')
    expect(state.store.notes.size).toBe(0)
  })

  it('a per-note embedding failure is NOT a 503 — the run completes with failures', async () => {
    state.embed.failOnCall = 1
    const res = await POST(req(`Bearer ${SYNC_KEY}`, { resolveSourceModified: false }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('completed_with_failures')
    expect(body.notesFailed).toBe(1)
    expect(body.notesIndexed).toBe(2)
  })
})
