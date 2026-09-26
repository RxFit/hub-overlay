import { describe, it, expect, vi } from 'vitest'
import { readSourceConfig, type SourceConfig } from './config'
import type { ImportOutcome, Importer } from './discovery-import'
import type { SyncDoc } from './documents'
import type { ObjectStore } from './gcs'
import { SemanticSyncError } from './http'
import type { CollectResult, SyncSource, SyncWindow } from './source'
import { MAX_CATCHUP_HOURS, OVERLAP_MS, computeWindow, runSourceSync, type SyncState } from './run'

const NOW = new Date('2026-09-26T07:17:00Z')
const HOUR = 3_600_000

const config: SourceConfig = readSourceConfig('stripe', {
  GOOGLE_SERVICE_ACCOUNT_KEY: '{}',
  SEMANTIC_SYNC_STRIPE_GCS_URI: 'gs://sb-stripe/hub',
  SEMANTIC_SYNC_STRIPE_DATA_STORE: 'sb-stripe-ds',
  STRIPE_SECRET_KEY: 'rk',
  VERTEX_GCP_PROJECT: 'proj',
})
const DATA_STORE = 'projects/proj/locations/global/collections/default_collection/dataStores/sb-stripe-ds'
const STATE = 'hub/stripe/_state.json'

function memoryStore(initial: Record<string, string> = {}) {
  const objects = new Map(Object.entries(initial))
  const puts: string[] = []
  const store: ObjectStore & { objects: Map<string, string>; puts: string[]; failOn?: RegExp } = {
    objects,
    puts,
    uri: (name) => `gs://sb-stripe/${name}`,
    async put(name, body) {
      if (store.failOn?.test(name)) throw new SemanticSyncError('upload', `GCS write ${name} failed (HTTP 403)`, 403)
      puts.push(name)
      objects.set(name, body)
    },
    async getJson<T>(name: string) {
      const v = objects.get(name)
      return v === undefined ? null : (JSON.parse(v) as T)
    },
  }
  return store
}

function fakeImporter(outcome?: Partial<ImportOutcome>) {
  const importer: Importer & { starts: Array<{ dataStore: string; uris: string[] }> } = {
    starts: [],
    async start(dataStore, uris) {
      importer.starts.push({ dataStore, uris })
      return `${dataStore}/operations/import-${importer.starts.length}`
    },
    async check(operation) {
      return { operation, done: true, successCount: 1, failureCount: 0, ...outcome }
    },
  }
  return importer
}

const doc = (id: string, minute: number): SyncDoc => ({
  id,
  title: `Doc ${id}`,
  updatedAt: new Date(NOW.getTime() - HOUR + minute * 60_000),
  facts: [],
  structData: { source: 'stripe' },
})

function fakeSource(result: (w: SyncWindow) => CollectResult | Promise<CollectResult>) {
  const windows: SyncWindow[] = []
  const source: SyncSource = {
    id: 'stripe',
    async collect(w) {
      windows.push(w)
      return result(w)
    },
  }
  return { source, windows }
}

const readState = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.objects.get(STATE)!) as SyncState

describe('computeWindow', () => {
  it('first run looks back 24h', () => {
    expect(computeWindow(null, NOW).since).toEqual(new Date(NOW.getTime() - 24 * HOUR))
  })

  it('resumes an hour before the cursor after a complete run, 1s before after a truncated one', () => {
    const cursor = '2026-09-25T07:00:00.000Z'
    expect(computeWindow({ version: 1, cursor }, NOW).since).toEqual(new Date(Date.parse(cursor) - OVERLAP_MS))
    expect(computeWindow({ version: 1, cursor, lastRunTruncated: true }, NOW).since).toEqual(new Date(Date.parse(cursor) - 1000))
  })

  it('clamps catch-up to MAX_CATCHUP_HOURS and says so', () => {
    const w = computeWindow({ version: 1, cursor: '2025-01-01T00:00:00Z' }, NOW)
    expect(w.clamped).toBe(true)
    expect(w.since).toEqual(new Date(NOW.getTime() - MAX_CATCHUP_HOURS * HOUR))
  })

  it('continuing a truncated backfill is not clipped to the catch-up ceiling', () => {
    const cursor = new Date(NOW.getTime() - 25 * 24 * HOUR).toISOString()
    const w = computeWindow({ version: 1, cursor, lastRunTruncated: true }, NOW)
    expect(w.clamped).toBe(false)
    expect(w.since).toEqual(new Date(Date.parse(cursor) - 1000))
  })

  it('an explicit lookback ignores the cursor', () => {
    const w = computeWindow({ version: 1, cursor: '2026-09-26T07:00:00Z' }, NOW, 72)
    expect(w).toMatchObject({ since: new Date(NOW.getTime() - 72 * HOUR), clamped: false })
  })
})

describe('runSourceSync', () => {
  it('not configured → touches nothing', async () => {
    const store = memoryStore()
    const r = await runSourceSync({ config: readSourceConfig('stripe', {}), source: fakeSource(() => { throw new Error('no') }).source, store, importer: fakeImporter() })
    expect(r).toMatchObject({ status: 'not_configured', missing: expect.arrayContaining(['STRIPE_SECRET_KEY']) })
    expect(store.puts).toEqual([])
  })

  it('happy path: content, then manifest, then import, then cursor', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1), doc('stripe-b', 2)], scanned: 5, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })

    const manifest = 'hub/stripe/manifests/2026-09-26T07-17-00-000Z.jsonl'
    expect(store.puts.slice(-2)).toEqual([manifest, STATE])
    expect(store.puts.slice(0, 2).sort()).toEqual(['hub/stripe/docs/stripe-a.html', 'hub/stripe/docs/stripe-b.html'])
    const lines = store.objects.get(manifest)!.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.content.uri)).toEqual([
      'gs://sb-stripe/hub/stripe/docs/stripe-a.html',
      'gs://sb-stripe/hub/stripe/docs/stripe-b.html',
    ])
    expect(importer.starts).toEqual([{ dataStore: DATA_STORE, uris: [`gs://sb-stripe/${manifest}`] }])

    expect(r).toMatchObject({ status: 'synced', documents: 2, scanned: 5, import: { status: 'started' } })
    expect(readState(store)).toMatchObject({
      cursor: NOW.toISOString(),
      lastRunTruncated: false,
      lastImport: { operation: `${DATA_STORE}/operations/import-1`, attempts: 1 },
    })
  })

  it('resumes from the stored cursor', async () => {
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, cursor: '2026-09-25T07:00:00.000Z' }) })
    const { source, windows } = fakeSource((w) => ({ docs: [], scanned: 0, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer: fakeImporter(), now: () => NOW })
    expect(windows[0].since).toEqual(new Date(Date.parse('2026-09-25T07:00:00Z') - OVERLAP_MS))
    expect(r).toMatchObject({ status: 'noop', import: { status: 'skipped' } })
    expect(readState(store).cursor).toBe(NOW.toISOString())
  })

  it('a failed upload leaves the cursor untouched, so the next run re-covers the window', async () => {
    const before = JSON.stringify({ version: 1, cursor: '2026-09-25T07:00:00.000Z' })
    const store = memoryStore({ [STATE]: before })
    store.failOn = /stripe-b/
    const importer = fakeImporter()
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1), doc('stripe-b', 2)], scanned: 2, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'upload', httpStatus: 403 } })
    expect(store.objects.get(STATE)).toBe(before)
    expect(importer.starts).toEqual([])
  })

  it('an abort at the run deadline names the stage in progress and keeps the cursor', async () => {
    const store = memoryStore()
    const controller = new AbortController()
    store.put = async () => {
      controller.abort()
      throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
    }
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1)], scanned: 1, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer: fakeImporter(), now: () => NOW, signal: controller.signal })
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'upload', detail: expect.stringContaining('run deadline reached during upload') } })
    expect(store.objects.has(STATE)).toBe(false)
  })

  it('a failed import start also keeps the cursor (import stage)', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    importer.start = async () => {
      throw new SemanticSyncError('import', 'documents:import failed (HTTP 403): PERMISSION_DENIED', 403)
    }
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1)], scanned: 1, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'import' } })
    expect(store.objects.has(STATE)).toBe(false)
  })

  it('without a data store: writes objects, skips the import, and says why', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1)], scanned: 1, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config: { ...config, dataStore: undefined }, source, store, importer, now: () => NOW })
    expect(r.status).toBe('synced')
    expect(r.import).toMatchObject({ status: 'skipped', detail: expect.stringContaining('SEMANTIC_SYNC_STRIPE_DATA_STORE') })
    expect(importer.starts).toEqual([])
  })

  it('a truncated run stores its partial cursor and flags the next resume', async () => {
    const store = memoryStore()
    const partial = new Date(NOW.getTime() - 30 * 60_000)
    const { source } = fakeSource(() => ({ docs: [doc('stripe-a', 1)], scanned: 900, truncated: true, cursor: partial }))
    const r = await runSourceSync({ config, source, store, importer: fakeImporter(), now: () => NOW }, { maxItems: 1 })
    expect(r).toMatchObject({ status: 'synced', truncated: true, cursor: partial.toISOString() })
    expect(readState(store)).toMatchObject({ cursor: partial.toISOString(), lastRunTruncated: true })
  })

  it('re-imports the previous manifests when their import failed outright', async () => {
    const prev = { operation: 'op-prev', manifests: ['gs://sb-stripe/hub/stripe/manifests/old.jsonl'], attempts: 1, startedAt: 'x' }
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, cursor: NOW.toISOString(), lastImport: prev }) })
    const importer = fakeImporter({ successCount: 0, failureCount: 3, errors: ['bad schema'] })
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1)], scanned: 1, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })

    expect(r.previousImport).toMatchObject({ status: 'failed', failureCount: 3, errors: ['bad schema'] })
    expect(r.import?.status).toBe('retrying_previous')
    expect(importer.starts[0].uris).toEqual([prev.manifests[0], expect.stringContaining('/manifests/2026-09-26')])
    expect(readState(store).lastImport?.attempts).toBe(2)
  })

  it('gives up re-importing after three attempts, loudly', async () => {
    const prev = { operation: 'op-prev', manifests: ['gs://m/old.jsonl'], attempts: 3, startedAt: 'x' }
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, cursor: NOW.toISOString(), lastImport: prev }) })
    const importer = fakeImporter({ successCount: 0, failureCount: 1 })
    const { source } = fakeSource((w) => ({ docs: [], scanned: 0, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })
    expect(r.previousImport?.status).toBe('abandoned')
    expect(importer.starts).toEqual([])
  })

  it('reports a still-running previous import without re-importing it', async () => {
    const prev = { operation: 'op-prev', manifests: ['gs://m/old.jsonl'], attempts: 1, startedAt: 'x' }
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, cursor: NOW.toISOString(), lastImport: prev }) })
    const importer = fakeImporter({ done: false })
    const { source } = fakeSource((w) => ({ docs: [], scanned: 0, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })
    expect(r.previousImport?.status).toBe('running')
    expect(importer.starts).toEqual([])
  })

  it('an unreadable previous operation is diagnostics, not a failed run', async () => {
    const prev = { operation: 'op-prev', manifests: [], attempts: 1, startedAt: 'x' }
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, lastImport: prev }) })
    const importer = fakeImporter()
    importer.check = vi.fn(async () => {
      throw new Error('404 operation not found')
    })
    const { source } = fakeSource((w) => ({ docs: [], scanned: 0, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW })
    expect(r.status).toBe('noop')
    expect(r.previousImport).toMatchObject({ status: 'unknown', detail: '404 operation not found' })
  })

  it('dry run lists and renders but writes and imports nothing', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const { source } = fakeSource((w) => ({ docs: [doc('stripe-a', 1)], scanned: 1, truncated: false, cursor: w.until }))
    const r = await runSourceSync({ config, source, store, importer, now: () => NOW }, { dryRun: true })
    expect(r).toMatchObject({ status: 'dry_run', documents: 1, sampleIds: ['stripe-a'] })
    expect(store.puts).toEqual([])
    expect(importer.starts).toEqual([])
  })
})
