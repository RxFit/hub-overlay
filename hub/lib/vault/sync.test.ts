import { describe, it, expect, beforeEach, vi } from 'vitest'
import { runVaultSync, frontmatterDate, MAX_CONSECUTIVE_FAILURES, type VaultSyncDeps, type SyncLogger } from './sync'
import { VaultUnavailableError } from './errors'
import { createMemoryVaultStore, type MemoryVaultStore } from '../../test/vault-memory-store'
import { createFakeVault, type FakeVault } from '../../test/vault-fake-github'
import { createFakeEmbed, type FakeEmbed } from '../../test/vault-fake-embed'

/* ════════════════════════════════════════════════════════════════════════════
   Sync engine — offline, against the fixture mini-vault, a fake GitHub with
   real blob SHAs, a fake embedder and the in-memory store. Locks:
     - deny-by-default scope (excludes win)
     - incremental by blob SHA (unchanged = untouched, changed = re-embedded)
     - atomic promotion (embedding fails on chunk 2 of 3 → old version intact)
     - tombstones on rename and delete
     - idempotent no-op run that is still recorded
     - budgets, systemic-failure stop, run-level failures
     - paths-only logging (never note content)
   ════════════════════════════════════════════════════════════════════════════ */

const TENANT = 'rxfit'
const MODEL = 'gemini-embedding-2'
const SCOPE = { include: ['Projects/**', 'Daily/**'], exclude: ['Private/**', 'Templates/**'] }

let store: MemoryVaultStore
let vault: FakeVault
let embed: FakeEmbed
let logged: Array<Record<string, unknown>>
let log: SyncLogger

function deps(overrides: Partial<VaultSyncDeps> = {}): VaultSyncDeps {
  return {
    store,
    github: vault,
    embed: embed.embed,
    scope: SCOPE,
    ref: 'HEAD',
    embeddingModel: MODEL,
    log,
    // Small chunks so the fixture notes produce several chunks each.
    chunkOptions: { targetChars: 300, overlapChars: 60 },
    ...overrides,
  }
}

const sync = (overrides: Partial<VaultSyncDeps> = {}) => runVaultSync({ tenantId: TENANT }, deps(overrides))

beforeEach(() => {
  store = createMemoryVaultStore()
  vault = createFakeVault()
  embed = createFakeEmbed()
  logged = []
  const capture = (obj: Record<string, unknown>) => { logged.push(obj) }
  log = { info: capture, warn: capture, debug: capture }
})

describe('first run', () => {
  it('indexes only the in-scope markdown notes with provenance, frontmatter and the active model', async () => {
    const result = await sync()
    expect(result.status).toBe('completed')
    expect(result.notesScanned).toBe(3)
    expect(result.notesIndexed).toBe(3)
    expect(result.notesFailed).toBe(0)
    expect(result.notesTombstoned).toBe(0)
    expect(result.toCommit).toBe(vault.head())
    expect(result.fromCommit).toBeNull()

    const paths = [...store.notes.values()].map((n) => n.vaultPath).sort()
    expect(paths).toEqual(['Daily/2026-09-20.md', 'Projects/Hub Overlay.md', 'Projects/Roadmap.md'])
    expect(store.note('Private/Secrets.md')).toBeUndefined()
    expect(store.note('Templates/Note Template.md')).toBeUndefined()
    expect(store.note('attachments/diagram.png')).toBeUndefined()

    const hub = store.note('Projects/Hub Overlay.md')!
    expect(hub.noteTitle).toBe('Hub Overlay')
    expect(hub.frontmatter).toMatchObject({ title: 'Hub Overlay', aliases: ['HUB', 'Overlay project'], tags: ['project', 'rxfit/hub'], status: 'active' })
    expect(hub.contentSha).toBe(vault.shaOf('Projects/Hub Overlay.md'))
    expect(hub.indexedCommitSha).toBe(vault.head())
    expect(hub.embeddingModel).toBe(MODEL)
    expect(hub.sourceModifiedAt?.toISOString()).toBe('2026-09-20T14:05:00.000Z') // from frontmatter `modified`

    const chunks = store.chunksFor('Projects/Hub Overlay.md')
    expect(chunks.length).toBeGreaterThan(2)
    expect(chunks.every((c) => c.embeddingModel === MODEL && c.contentSha === hub.contentSha && c.embedding.length === 8)).toBe(true)
    expect(chunks.some((c) => c.headingPath === 'Hub Overlay > Architecture > Data layer')).toBe(true)

    // Embedding input carries the title + heading path prefix, never frontmatter.
    expect(embed.calls.some((t) => t.startsWith('Hub Overlay > Hub Overlay > Architecture'))).toBe(true)
    expect(embed.calls.every((t) => !t.includes('aliases:'))).toBe(true)

    // One run row, finished, with counters.
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ status: 'completed', toCommit: vault.head(), notesScanned: 3, notesIndexed: 3, notesFailed: 0, failedPaths: [] })
    expect(store.runs[0].finishedAt).toBeInstanceOf(Date)
  })

  it('resolves source_modified_at from git history when the frontmatter has no date (best-effort)', async () => {
    vault.commitDates.set('Daily/2026-09-20.md', new Date('2026-09-20T09:30:00Z'))
    await sync()
    expect(store.note('Daily/2026-09-20.md')?.sourceModifiedAt?.toISOString()).toBe('2026-09-20T09:30:00.000Z')
    expect(store.note('Projects/Roadmap.md')?.sourceModifiedAt).toBeNull()
    // Only the notes WITHOUT a frontmatter date cost a history lookup.
    expect(vault.calls.lastCommit).toBe(2)
  })

  it('skips the history lookup when resolveSourceModified is off', async () => {
    await sync({ resolveSourceModified: false })
    expect(vault.calls.lastCommit).toBe(0)
  })
})

describe('deny by default', () => {
  it('indexes nothing with an empty include set and records a noop run', async () => {
    const result = await sync({ scope: { include: [], exclude: [] } })
    expect(result.status).toBe('noop')
    expect(result.notesScanned).toBe(0)
    expect(store.notes.size).toBe(0)
    expect(embed.calls).toHaveLength(0)
    expect(vault.calls.blob).toBe(0)
    expect(store.runs[0].status).toBe('noop')
  })

  it('lets an exclude win over a broad include', async () => {
    await sync({ scope: { include: ['**'], exclude: ['Private/**', 'Templates/**'] } })
    const paths = [...store.notes.values()].map((n) => n.vaultPath).sort()
    expect(paths).toEqual(['Daily/2026-09-20.md', 'Projects/Hub Overlay.md', 'Projects/Roadmap.md', 'README.md'])
  })
})

describe('incremental by blob SHA', () => {
  it('re-running on an unchanged commit is a no-op that still records a run and advances nothing', async () => {
    await sync()
    const embedCalls = embed.calls.length
    const before = store.chunksFor('Projects/Hub Overlay.md').map((c) => c.indexedAt)

    const result = await sync()
    expect(result.status).toBe('noop')
    expect(result.notesIndexed).toBe(0)
    expect(result.notesUnchanged).toBe(3)
    expect(result.toCommit).toBe(vault.head())
    expect(result.fromCommit).toBe(vault.head())
    expect(embed.calls).toHaveLength(embedCalls)
    expect(vault.calls.blob).toBe(3) // no blob fetched on the second run
    expect(store.runs).toHaveLength(2)
    expect(store.runs[1]).toMatchObject({ status: 'noop', toCommit: vault.head(), notesScanned: 3, notesIndexed: 0 })
    expect(store.chunksFor('Projects/Hub Overlay.md').map((c) => c.indexedAt)).toEqual(before)
  })

  it('re-embeds only the changed note; untouched notes keep their rows and chunks', async () => {
    await sync()
    const roadmapBefore = store.chunksFor('Projects/Roadmap.md')
    const hubShaBefore = store.note('Projects/Hub Overlay.md')!.contentSha
    const embedCallsBefore = embed.calls.length

    vault.write('Projects/Hub Overlay.md', '---\ntitle: Hub Overlay\n---\n\n# Hub Overlay\n\nRewritten body.\n')
    const result = await sync()
    expect(result.status).toBe('completed')
    expect(result.notesIndexed).toBe(1)
    expect(result.notesUnchanged).toBe(2)
    expect(result.fromCommit).not.toBe(result.toCommit)

    const hub = store.note('Projects/Hub Overlay.md')!
    expect(hub.contentSha).not.toBe(hubShaBefore)
    expect(hub.contentSha).toBe(vault.shaOf('Projects/Hub Overlay.md'))
    expect(store.chunksFor('Projects/Hub Overlay.md')).toHaveLength(1)
    expect(store.chunksFor('Projects/Hub Overlay.md')[0].content).toContain('Rewritten body.')
    expect(store.chunksFor('Projects/Roadmap.md')).toEqual(roadmapBefore)
    expect(embed.calls.length - embedCallsBefore).toBe(1)
  })

  it('re-embeds a note whose blob is unchanged but whose chunks are on a retired embedding model', async () => {
    await sync({ embeddingModel: 'gemini-embedding-001' })
    expect(store.note('Projects/Roadmap.md')?.embeddingModel).toBe('gemini-embedding-001')

    const result = await sync({ embeddingModel: MODEL })
    expect(result.notesIndexed).toBe(3)
    expect([...store.notes.values()].every((n) => n.embeddingModel === MODEL)).toBe(true)
    expect(store.chunks.every((c) => c.embeddingModel === MODEL)).toBe(true)
  })
})

describe('tombstones', () => {
  it('tombstones a deleted note: row kept with deleted_at, chunks gone, invisible to search', async () => {
    await sync()
    vault.delete('Projects/Roadmap.md')
    const result = await sync()
    expect(result.status).toBe('completed')
    expect(result.notesTombstoned).toBe(1)
    expect(result.notesScanned).toBe(2)

    const roadmap = store.note('Projects/Roadmap.md')!
    expect(roadmap.deletedAt).toBeInstanceOf(Date)
    expect(store.chunksFor('Projects/Roadmap.md')).toEqual([])
    const status = await store.getSyncStatus(TENANT, 'antigravityhq', MODEL)
    expect(status.notesLive).toBe(2)
    const hits = await store.searchChunks({ tenantId: TENANT, corpus: 'antigravityhq', embeddingModel: MODEL, queryEmbedding: new Array(8).fill(0.3), topK: 50 })
    expect(hits.some((h) => h.vaultPath === 'Projects/Roadmap.md')).toBe(false)
  })

  it('treats a rename as tombstone + fresh index, and a path that comes back clears its tombstone', async () => {
    await sync()
    vault.rename('Projects/Roadmap.md', 'Projects/Roadmap 2026.md')
    const renamed = await sync()
    expect(renamed.notesTombstoned).toBe(1)
    expect(renamed.notesIndexed).toBe(1)
    expect(store.note('Projects/Roadmap.md')?.deletedAt).toBeInstanceOf(Date)
    expect(store.note('Projects/Roadmap 2026.md')?.deletedAt).toBeNull()
    expect(store.chunksFor('Projects/Roadmap 2026.md').length).toBeGreaterThan(0)

    vault.rename('Projects/Roadmap 2026.md', 'Projects/Roadmap.md')
    const back = await sync()
    expect(back.notesTombstoned).toBe(1)
    expect(back.notesIndexed).toBe(1)
    expect(store.note('Projects/Roadmap.md')?.deletedAt).toBeNull()
    expect(store.note('Projects/Roadmap 2026.md')?.deletedAt).toBeInstanceOf(Date)
  })

  it('a note that moves OUT of scope is tombstoned too', async () => {
    await sync()
    const result = await sync({ scope: { include: ['Projects/**'], exclude: [] } })
    expect(result.notesTombstoned).toBe(1)
    expect(store.note('Daily/2026-09-20.md')?.deletedAt).toBeInstanceOf(Date)
  })
})

describe('atomic promotion per note', () => {
  it('embedding fails on chunk 2 of 3 → the previous version stays fully queryable and the note is marked failed', async () => {
    await sync()
    const hubBefore = store.note('Projects/Hub Overlay.md')!
    const chunksBefore = store.chunksFor('Projects/Hub Overlay.md')
    expect(chunksBefore.length).toBeGreaterThanOrEqual(3)

    // A changed note with ≥3 chunks; the second embedding call of THIS run blows up.
    const body = ['# Hub Overlay', '', 'Section one ' + 'alpha '.repeat(40), '', '## Two', '', 'Section two ' + 'beta '.repeat(40), '', '## Three', '', 'Section three ' + 'gamma '.repeat(40), ''].join('\n')
    vault.write('Projects/Hub Overlay.md', body)
    embed.calls = [] // count this run's calls only
    embed.failOnCall = 2

    const result = await sync()
    expect(result.status).toBe('completed_with_failures')
    expect(result.notesIndexed).toBe(0)
    expect(result.notesFailed).toBe(1)
    expect(result.failedPaths).toEqual([{ path: 'Projects/Hub Overlay.md', message: expect.stringContaining('simulated embedding failure') }])
    expect(embed.calls.length).toBe(2) // stopped at the failing chunk; chunk 3 never attempted

    const hubAfter = store.note('Projects/Hub Overlay.md')!
    expect(hubAfter.contentSha).toBe(hubBefore.contentSha) // old version, not the new blob
    expect(hubAfter.deletedAt).toBeNull()
    expect(store.chunksFor('Projects/Hub Overlay.md')).toEqual(chunksBefore) // byte-for-byte the previous chunk set
    expect(store.runs[1]).toMatchObject({ status: 'completed_with_failures', notesFailed: 1, failedPaths: result.failedPaths })

    // The failure is not sticky: the next run (embedding healthy) promotes the new version.
    embed.failOnCall = null
    const retry = await sync()
    expect(retry.notesIndexed).toBe(1)
    expect(store.note('Projects/Hub Overlay.md')!.contentSha).toBe(vault.shaOf('Projects/Hub Overlay.md'))
    expect(store.chunksFor('Projects/Hub Overlay.md')).toHaveLength(3)
  })

  it('a failure inside the promotion transaction itself also leaves the previous version intact', async () => {
    await sync()
    const before = store.chunksFor('Projects/Roadmap.md')
    vault.write('Projects/Roadmap.md', '# Roadmap 2026\n\nChanged.\n')
    store.failPromoteFor.add('Projects/Roadmap.md')

    const result = await sync()
    expect(result.status).toBe('completed_with_failures')
    expect(result.failedPaths[0]).toMatchObject({ path: 'Projects/Roadmap.md', message: expect.stringContaining('simulated transaction failure') })
    expect(store.chunksFor('Projects/Roadmap.md')).toEqual(before)
    expect(store.note('Projects/Roadmap.md')!.contentSha).not.toBe(vault.shaOf('Projects/Roadmap.md'))
  })

  it('a blob that fails integrity verification is a per-note failure, not a run failure', async () => {
    vault.tamper.set(vault.shaOf('Daily/2026-09-20.md'), Buffer.from('tampered'))
    const result = await sync()
    expect(result.status).toBe('completed_with_failures')
    expect(result.notesIndexed).toBe(2)
    expect(result.failedPaths).toEqual([{ path: 'Daily/2026-09-20.md', message: expect.stringContaining('did not verify') }])
    expect(store.note('Daily/2026-09-20.md')).toBeUndefined()
  })
})

describe('budgets and systemic failures', () => {
  it('maxNotesPerRun bounds a run as `incomplete`; the next run picks up the rest', async () => {
    const first = await sync({ maxNotesPerRun: 1 })
    expect(first.status).toBe('incomplete')
    expect(first.notesIndexed).toBe(1)
    expect(first.notesRemaining).toBe(2)
    expect(store.runs[0].status).toBe('incomplete')

    const second = await sync({ maxNotesPerRun: 5 })
    expect(second.status).toBe('completed')
    expect(second.notesIndexed).toBe(2)
    expect(second.notesRemaining).toBe(0)
  })

  it('an expired deadline ends the run early as `incomplete`', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await sync({ signal: controller.signal })
    expect(result.status).toBe('incomplete')
    expect(result.notesIndexed).toBe(0)
    expect(result.notesRemaining).toBe(3)
    expect(result.stoppedEarly).toBe('deadline')
    expect(store.runs[0].error).toContain('deadline')
  })

  it('an open embedding circuit stops the run at the first note instead of failing every note', async () => {
    embed.failWhen = () => true
    embed.error = () => new VaultUnavailableError('embedding', 'breaker_open', 'circuit open')
    const result = await sync()
    expect(result.status).toBe('incomplete')
    expect(result.notesFailed).toBe(1)
    expect(result.notesRemaining).toBe(2)
    expect(result.stoppedEarly).toBe('embedding circuit open')
    expect(embed.calls).toHaveLength(1)
  })

  it('a deterministic embedding failure (rejected key, unknown model, no key) stops the run at the first note and names the cause', async () => {
    embed.failWhen = () => true
    embed.error = () => new VaultUnavailableError('embedding', 'auth', 'Gemini embedContent (gemini-embedding-2) answered HTTP 400 API_KEY_INVALID: API key not valid. Please pass a valid API key.', 400)
    const result = await sync()
    expect(result.status).toBe('incomplete')
    expect(result.notesFailed).toBe(1)
    expect(result.notesRemaining).toBe(2)
    expect(result.stoppedEarly).toMatch(/^embedding auth — Gemini embedContent .*HTTP 400 API_KEY_INVALID/)
    expect(embed.calls).toHaveLength(1)
    expect(result.failedPaths[0].message).toContain('API_KEY_INVALID')
    expect(store.runs[0]).toMatchObject({ status: 'incomplete', error: expect.stringContaining('stopped early: embedding auth') })

    // The same for an unknown model id; a transient `http` failure is NOT deterministic and keeps going.
    embed.calls = []
    embed.error = () => new VaultUnavailableError('embedding', 'not_found', 'HTTP 404', 404)
    expect((await sync()).stoppedEarly).toMatch(/^embedding not_found/)
    embed.calls = []
    embed.error = () => new VaultUnavailableError('embedding', 'http', 'HTTP 503', 503)
    const transient = await sync()
    expect(transient.stoppedEarly).toBeNull()
    expect(transient.notesFailed).toBe(3)
  })

  it(`stops after ${MAX_CONSECUTIVE_FAILURES} consecutive note failures`, async () => {
    for (let i = 0; i < 8; i++) vault.write(`Projects/Gen ${i}.md`, `# Gen ${i}\n\nbody ${i}\n`)
    embed.failWhen = () => true
    const result = await sync()
    expect(result.status).toBe('incomplete')
    expect(result.notesFailed).toBe(MAX_CONSECUTIVE_FAILURES)
    expect(result.notesRemaining).toBe(11 - MAX_CONSECUTIVE_FAILURES)
    expect(result.stoppedEarly).toContain('consecutive')
  })

  it('a run-level failure (GitHub unreachable) is recorded as `failed` and propagates', async () => {
    vault.outage = new VaultUnavailableError('github', 'auth', 'HTTP 401', 401)
    await expect(sync()).rejects.toMatchObject({ stage: 'github', reason: 'auth' })
    expect(store.runs).toHaveLength(1)
    expect(store.runs[0]).toMatchObject({ status: 'failed', error: expect.stringContaining('HTTP 401') })
    expect(store.notes.size).toBe(0)
  })

  it('refuses a truncated tree (it would look like a mass deletion)', async () => {
    await sync()
    vault.truncated = true
    await expect(sync()).rejects.toMatchObject({ reason: 'integrity' })
    expect(store.runs[1].status).toBe('failed')
    expect([...store.notes.values()].every((n) => n.deletedAt === null)).toBe(true)
  })

  it('a run-level failure after some notes were promoted keeps those promotions', async () => {
    // Finishing the ledger row is best-effort: an outage there must not undo work.
    const finishRun = vi.spyOn(store, 'finishRun').mockRejectedValueOnce(new Error('db down'))
    const result = await sync()
    expect(result.status).toBe('completed')
    expect(store.notes.size).toBe(3)
    finishRun.mockRestore()
  })
})

describe('logging discipline', () => {
  it('logs paths and counts only — never note content', async () => {
    await sync()
    const serialized = JSON.stringify(logged)
    expect(serialized).toContain('Projects/Hub Overlay.md')
    expect(serialized).not.toContain('operations shell for RxFit')
    expect(serialized).not.toContain('PLACEHOLDER_NOT_A_SECRET')
    expect(serialized).not.toContain('Ignore previous instructions')
  })
})

describe('frontmatterDate', () => {
  it('reads the first parseable of modified/updated/date/created and ignores garbage', () => {
    expect(frontmatterDate({ modified: '2026-09-20T14:05:00Z' })?.toISOString()).toBe('2026-09-20T14:05:00.000Z')
    expect(frontmatterDate({ updated: 'not a date', date: '2026-01-02' })?.toISOString()).toBe('2026-01-02T00:00:00.000Z')
    expect(frontmatterDate({ modified: ['x'] })).toBeNull()
    expect(frontmatterDate({})).toBeNull()
  })
})
