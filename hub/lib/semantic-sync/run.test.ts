import { describe, it, expect, vi } from 'vitest'
import { readSourceConfig, type SourceConfig } from './config'
import type { ImportOutcome, Importer } from './discovery-import'
import type { SyncDoc } from './documents'
import type { ObjectStore } from './gcs'
import { SemanticSyncError } from './http'
import type { CollectResult, SyncSource, SyncWindow } from './source'
import {
  MAX_CATCHUP_HOURS,
  MAX_CHECK_FAILURES,
  OVERLAP_MS,
  computeWindow,
  isConnectedToEngine,
  runSourceSync,
  type QueuedImport,
  type SourceRunDeps,
  type SyncState,
} from './run'

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
const CHAT_ENGINE = 'projects/proj/locations/global/collections/default_collection/engines/semanticbrain_1'
const STATE = 'hub/stripe/_state.json'
const NEW_MANIFEST = 'gs://sb-stripe/hub/stripe/manifests/2026-09-26T07-17-00-000Z.jsonl'

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

/** Outcomes by operation name; unknown operations read as succeeded. */
function fakeImporter(outcomes: Record<string, Partial<ImportOutcome> | Error> = {}, chatStores: string[] = ['sb-drive', 'sb-vault']) {
  const importer: Importer & { starts: Array<{ dataStore: string; uris: string[] }>; checks: string[] } = {
    starts: [],
    checks: [],
    async start(dataStore, uris) {
      importer.starts.push({ dataStore, uris })
      return `op-new-${importer.starts.length}`
    },
    async check(operation) {
      importer.checks.push(operation)
      const o = outcomes[operation]
      if (o instanceof Error) throw o
      return { operation, done: true, successCount: 1, failureCount: 0, ...o }
    },
    async engineDataStoreIds() {
      return chatStores
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

const withDocs = (...ids: string[]) => fakeSource((w) => ({ docs: ids.map((id, i) => doc(id, i)), scanned: ids.length, truncated: false, cursor: w.until }))

function deps(over: Partial<SourceRunDeps> & Pick<SourceRunDeps, 'store'>): SourceRunDeps {
  return {
    config,
    source: withDocs().source,
    importer: fakeImporter(),
    chatEngine: CHAT_ENGINE,
    now: () => NOW,
    ...over,
  }
}

const readState = (store: ReturnType<typeof memoryStore>) => JSON.parse(store.objects.get(STATE)!) as SyncState
const stateWith = (s: Omit<SyncState, 'version'>) => ({ [STATE]: JSON.stringify({ version: 1, cursor: NOW.toISOString(), ...s }) })
const queued = (operation: string, uri: string, attempts = 1): QueuedImport => ({
  operation,
  manifests: [{ uri, attempts }],
  startedAt: '2026-09-25T07:17:00.000Z',
})

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

describe('exposure guard — never import into the engine the Hub chat searches', () => {
  it('isConnectedToEngine matches id AND project', () => {
    expect(isConnectedToEngine(DATA_STORE, CHAT_ENGINE, ['sb-stripe-ds'])).toBe(true)
    expect(isConnectedToEngine(DATA_STORE, CHAT_ENGINE, ['other'])).toBe(false)
    const elsewhere = DATA_STORE.replace('projects/proj/', 'projects/other-proj/')
    expect(isConnectedToEngine(elsewhere, CHAT_ENGINE, ['sb-stripe-ds'])).toBe(false)
  })

  it('refuses to run — before collecting or writing anything — when the data store is connected to the chat engine', async () => {
    const store = memoryStore()
    const importer = fakeImporter({}, ['sb-drive', 'sb-stripe-ds'])
    const collect = vi.fn()
    const r = await runSourceSync(deps({ store, importer, source: { id: 'stripe', collect } }))
    expect(r).toMatchObject({
      status: 'failed',
      failure: { stage: 'config', detail: expect.stringContaining('connected to the Hub chat engine') },
    })
    expect(collect).not.toHaveBeenCalled()
    expect(store.puts).toEqual([])
    expect(importer.starts).toEqual([])
  })

  it('fails CLOSED when the chat engine cannot be read', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    importer.engineDataStoreIds = async () => {
      throw new SemanticSyncError('config', 'read engine failed (HTTP 403): PERMISSION_DENIED', 403)
    }
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'config', httpStatus: 403, detail: expect.stringContaining('refusing to import') } })
    expect(store.puts).toEqual([])
  })

  it('applies to dry runs too', async () => {
    const r = await runSourceSync(deps({ store: memoryStore(), importer: fakeImporter({}, ['sb-stripe-ds']) }), { dryRun: true })
    expect(r.status).toBe('failed')
  })

  it('does not apply without a data store (GCS only, nothing reaches any engine)', async () => {
    const importer = fakeImporter({}, ['sb-stripe-ds'])
    importer.engineDataStoreIds = vi.fn()
    const r = await runSourceSync(deps({ store: memoryStore(), importer, config: { ...config, dataStore: undefined }, source: withDocs('stripe-a').source }))
    expect(r.status).toBe('synced')
    expect(importer.engineDataStoreIds).not.toHaveBeenCalled()
  })
})

describe('runSourceSync', () => {
  it('not configured → touches nothing', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    importer.engineDataStoreIds = vi.fn()
    const r = await runSourceSync(deps({ store, importer, config: readSourceConfig('stripe', {}) }))
    expect(r).toMatchObject({ status: 'not_configured', missing: expect.arrayContaining(['STRIPE_SECRET_KEY']) })
    expect(store.puts).toEqual([])
    expect(importer.engineDataStoreIds).not.toHaveBeenCalled()
  })

  it('happy path: content, then manifest, then import, then cursor + queued import', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a', 'stripe-b').source }))

    const manifest = 'hub/stripe/manifests/2026-09-26T07-17-00-000Z.jsonl'
    expect(store.puts.slice(-2)).toEqual([manifest, STATE])
    expect(store.puts.slice(0, 2).sort()).toEqual(['hub/stripe/docs/stripe-a.html', 'hub/stripe/docs/stripe-b.html'])
    const lines = store.objects.get(manifest)!.trim().split('\n').map((l) => JSON.parse(l))
    expect(lines.map((l) => l.content.uri)).toEqual([
      'gs://sb-stripe/hub/stripe/docs/stripe-a.html',
      'gs://sb-stripe/hub/stripe/docs/stripe-b.html',
    ])
    expect(importer.starts).toEqual([{ dataStore: DATA_STORE, uris: [NEW_MANIFEST] }])

    expect(r).toMatchObject({ status: 'synced', documents: 2, import: { status: 'started', operation: 'op-new-1', manifests: 1 } })
    expect(readState(store)).toMatchObject({
      cursor: NOW.toISOString(),
      lastRunTruncated: false,
      imports: [{ operation: 'op-new-1', manifests: [{ uri: NEW_MANIFEST, attempts: 1 }] }],
    })
  })

  it('resumes from the stored cursor', async () => {
    const store = memoryStore({ [STATE]: JSON.stringify({ version: 1, cursor: '2026-09-25T07:00:00.000Z' }) })
    const { source, windows } = withDocs()
    const r = await runSourceSync(deps({ store, source }))
    expect(windows[0].since).toEqual(new Date(Date.parse('2026-09-25T07:00:00Z') - OVERLAP_MS))
    expect(r).toMatchObject({ status: 'noop', import: { status: 'skipped' } })
    expect(readState(store).cursor).toBe(NOW.toISOString())
  })

  it('a failed upload leaves the cursor untouched, so the next run re-covers the window', async () => {
    const before = JSON.stringify({ version: 1, cursor: '2026-09-25T07:00:00.000Z' })
    const store = memoryStore({ [STATE]: before })
    store.failOn = /stripe-b/
    const importer = fakeImporter()
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a', 'stripe-b').source }))
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
    const r = await runSourceSync(deps({ store, source: withDocs('stripe-a').source, signal: controller.signal }))
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'upload', detail: expect.stringContaining('run deadline reached during upload') } })
    expect(store.objects.has(STATE)).toBe(false)
  })

  it('a failed import start also keeps the cursor (import stage)', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    importer.start = async () => {
      throw new SemanticSyncError('import', 'documents:import failed (HTTP 403): PERMISSION_DENIED', 403)
    }
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))
    expect(r).toMatchObject({ status: 'failed', failure: { stage: 'import' } })
    expect(store.objects.has(STATE)).toBe(false)
  })

  it('without a data store: writes objects, skips the import, and says why', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const r = await runSourceSync(deps({ store, importer, config: { ...config, dataStore: undefined }, source: withDocs('stripe-a').source }))
    expect(r.status).toBe('synced')
    expect(r.import).toMatchObject({ status: 'skipped', detail: expect.stringContaining('SEMANTIC_SYNC_STRIPE_DATA_STORE') })
    expect(importer.starts).toEqual([])
  })

  it('a truncated run stores its partial cursor and flags the next resume', async () => {
    const store = memoryStore()
    const partial = new Date(NOW.getTime() - 30 * 60_000)
    const { source } = fakeSource(() => ({ docs: [doc('stripe-a', 1)], scanned: 900, truncated: true, cursor: partial }))
    const r = await runSourceSync(deps({ store, source }), { maxItems: 1 })
    expect(r).toMatchObject({ status: 'synced', truncated: true, cursor: partial.toISOString() })
    expect(readState(store)).toMatchObject({ cursor: partial.toISOString(), lastRunTruncated: true })
  })

  it('dry run lists and renders but writes and imports nothing', async () => {
    const store = memoryStore()
    const importer = fakeImporter()
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }), { dryRun: true })
    expect(r).toMatchObject({ status: 'dry_run', documents: 1, sampleIds: ['stripe-a'] })
    expect(store.puts).toEqual([])
    expect(importer.starts).toEqual([])
  })
})

describe('the import queue — no started import is ever forgotten', () => {
  it('RUNNING + new docs: the running operation stays queued next to the new one', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] }))
    const importer = fakeImporter({ 'op-a': { done: false } })
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))

    expect(r.previousImports).toEqual([{ operation: 'op-a', status: 'running' }])
    expect(importer.starts[0].uris).toEqual([NEW_MANIFEST]) // not re-imported while running
    expect(readState(store).imports?.map((i) => i.operation)).toEqual(['op-a', 'op-new-1'])

    // …and it is checked again on the following run, where its failure is retried.
    const next = fakeImporter({ 'op-a': { successCount: 0, failureCount: 4 } })
    const r2 = await runSourceSync(deps({ store, importer: next, now: () => new Date(NOW.getTime() + 24 * HOUR) }))
    expect(next.checks).toEqual(['op-a', 'op-new-1'])
    expect(r2.previousImports).toMatchObject([
      { operation: 'op-a', status: 'retrying', failureCount: 4 },
      { operation: 'op-new-1', status: 'succeeded' },
    ])
    expect(next.starts[0].uris).toEqual(['gs://m/a.jsonl'])
    expect(readState(store).imports).toEqual([
      expect.objectContaining({ operation: 'op-new-1', manifests: [{ uri: 'gs://m/a.jsonl', attempts: 2 }] }),
    ])
  })

  it('PARTIAL completion is retried (not merely reported), riding the new import', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] }))
    const importer = fakeImporter({ 'op-a': { successCount: 10, failureCount: 2, errors: ['doc 7: bad field'] } })
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))

    expect(r.status).toBe('synced')
    expect(r.previousImports).toEqual([
      { operation: 'op-a', status: 'retrying', successCount: 10, failureCount: 2, errors: ['doc 7: bad field'] },
    ])
    expect(importer.starts[0].uris).toEqual(['gs://m/a.jsonl', NEW_MANIFEST])
    expect(readState(store).imports).toEqual([
      expect.objectContaining({
        operation: 'op-new-1',
        manifests: [
          { uri: 'gs://m/a.jsonl', attempts: 2 },
          { uri: NEW_MANIFEST, attempts: 1 },
        ],
      }),
    ])
  })

  it('a failed import is retried even when this run has nothing new', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] }))
    const importer = fakeImporter({ 'op-a': { successCount: 0, failureCount: 1 } })
    const r = await runSourceSync(deps({ store, importer }))
    expect(r.status).toBe('noop')
    expect(importer.starts).toEqual([{ dataStore: DATA_STORE, uris: ['gs://m/a.jsonl'] }])
  })

  it('succeeded operations leave the queue', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] }))
    const r = await runSourceSync(deps({ store, importer: fakeImporter() }))
    expect(r.previousImports).toEqual([{ operation: 'op-a', status: 'succeeded', successCount: 1, failureCount: 0 }])
    expect(readState(store).imports).toBeUndefined()
  })

  it('a manifest out of attempts is ABANDONED: recorded, and the run is fatal — after its own work landed', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl', 3)] }))
    const importer = fakeImporter({ 'op-a': { successCount: 5, failureCount: 1 } })
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))

    expect(r).toMatchObject({
      status: 'failed',
      failure: { stage: 'import', detail: expect.stringContaining('abandoned') },
      abandonedManifests: ['gs://m/a.jsonl'],
      previousImports: [{ operation: 'op-a', status: 'abandoned' }],
      import: { status: 'started' },
    })
    expect(importer.starts[0].uris).toEqual([NEW_MANIFEST])
    expect(readState(store)).toMatchObject({ cursor: NOW.toISOString(), abandoned: ['gs://m/a.jsonl'] })
  })

  it('an unreadable operation stays queued, then is treated as failed after MAX_CHECK_FAILURES', async () => {
    const store = memoryStore(stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] }))
    for (let i = 1; i < MAX_CHECK_FAILURES; i++) {
      const importer = fakeImporter({ 'op-a': new Error('404 operation not found') })
      const r = await runSourceSync(deps({ store, importer }))
      expect(r.status).toBe('noop')
      expect(r.previousImports).toEqual([{ operation: 'op-a', status: 'unknown', detail: '404 operation not found' }])
      expect(importer.starts).toEqual([])
      expect(readState(store).imports?.[0]).toMatchObject({ operation: 'op-a', checkFailures: i })
    }
    const importer = fakeImporter({ 'op-a': new Error('404 operation not found') })
    const r = await runSourceSync(deps({ store, importer }))
    expect(r.previousImports?.[0]).toMatchObject({ status: 'retrying', detail: expect.stringContaining('unreadable') })
    expect(importer.starts[0].uris).toEqual(['gs://m/a.jsonl'])
  })

  it('a failed import start keeps the queue as it was, so nothing is lost or double-counted', async () => {
    const before = stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] })
    const store = memoryStore(before)
    const importer = fakeImporter({ 'op-a': { successCount: 0, failureCount: 1 } })
    importer.start = async () => {
      throw new SemanticSyncError('import', 'HTTP 503', 503)
    }
    const r = await runSourceSync(deps({ store, importer, source: withDocs('stripe-a').source }))
    expect(r.status).toBe('failed')
    expect(store.objects.get(STATE)).toBe(before[STATE])
  })

  it('dry run reads the queue but changes nothing', async () => {
    const before = stateWith({ imports: [queued('op-a', 'gs://m/a.jsonl')] })
    const store = memoryStore(before)
    const importer = fakeImporter({ 'op-a': { successCount: 0, failureCount: 1 } })
    const r = await runSourceSync(deps({ store, importer }), { dryRun: true })
    expect(r.previousImports?.[0].status).toBe('retrying')
    expect(importer.starts).toEqual([])
    expect(store.puts).toEqual([])
  })
})
