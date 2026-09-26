/**
 * Vertex AI Search (Discovery Engine) document import — the step that turns
 * objects in a bucket into searchable Semantic Brain documents.
 *
 * Writing JSONL into GCS does not by itself change what the engine returns: a
 * Cloud Storage data store indexes what it was told to import, when it was
 * told. Each run therefore starts an INCREMENTAL `documents:import` of the
 * run's manifest (new ids are added, same ids are replaced, nothing else is
 * touched) and records the long-running operation's name. The import finishes
 * asynchronously, so the NEXT run reads that operation back and reports how it
 * ended — an import that failed server-side is otherwise invisible.
 */

import { failFromResponse, fetchWithRetry, type FetchLike } from './http'

const API = 'https://discoveryengine.googleapis.com/v1'

export interface ImportOutcome {
  operation: string
  done: boolean
  /** Present once done. */
  successCount?: number
  failureCount?: number
  /** First few per-document errors, or the operation-level error. */
  errors?: string[]
}

export interface Importer {
  /** Start an import of the manifests into `dataStore`; returns the operation name. */
  start(dataStore: string, manifestUris: string[]): Promise<string>
  check(operation: string): Promise<ImportOutcome>
  /** The data-store ids connected to `engine` (full engine resource path). */
  engineDataStoreIds(engine: string): Promise<string[]>
}

export function createDiscoveryImporter(opts: {
  token: () => Promise<string>
  signal?: AbortSignal
  fetchImpl?: FetchLike
}): Importer {
  const fetchImpl = opts.fetchImpl ?? fetch

  return {
    async start(dataStore, manifestUris) {
      const res = await fetchWithRetry(fetchImpl, `${API}/${dataStore}/branches/default_branch/documents:import`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await opts.token()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          gcsSource: { inputUris: manifestUris, dataSchema: 'document' },
          reconciliationMode: 'INCREMENTAL',
        }),
        signal: opts.signal,
      })
      if (!res.ok) await failFromResponse('import', `documents:import into ${dataStore}`, res)
      const op = (await res.json()) as { name?: string }
      return op.name ?? '(unnamed operation)'
    },

    async check(operation) {
      const res = await fetchWithRetry(fetchImpl, `${API}/${operation}`, {
        headers: { Authorization: `Bearer ${await opts.token()}` },
        signal: opts.signal,
      })
      if (!res.ok) await failFromResponse('import', `read import operation ${operation}`, res)
      return parseOperation(operation, await res.json())
    },

    async engineDataStoreIds(engine) {
      const res = await fetchWithRetry(fetchImpl, `${API}/${engine}`, {
        headers: { Authorization: `Bearer ${await opts.token()}` },
        signal: opts.signal,
      })
      if (!res.ok) await failFromResponse('config', `read engine ${engine}`, res)
      const body = (await res.json()) as { dataStoreIds?: unknown }
      return Array.isArray(body.dataStoreIds) ? body.dataStoreIds.filter((id): id is string => typeof id === 'string') : []
    },
  }
}

/** Exported for tests: normalize a google.longrunning.Operation body. */
export function parseOperation(operation: string, body: unknown): ImportOutcome {
  const op = (body ?? {}) as {
    done?: boolean
    error?: { message?: string }
    metadata?: { successCount?: string | number; failureCount?: string | number }
    response?: { errorSamples?: Array<{ message?: string }> }
  }
  const outcome: ImportOutcome = { operation, done: op.done === true }
  if (!outcome.done) return outcome

  // Int64 fields arrive as strings in Google's JSON mapping.
  outcome.successCount = Number(op.metadata?.successCount ?? 0)
  outcome.failureCount = Number(op.metadata?.failureCount ?? 0)
  const errors = [
    ...(op.error?.message ? [op.error.message] : []),
    ...(op.response?.errorSamples ?? []).map((s) => s.message ?? '').filter(Boolean),
  ].map((m) => m.slice(0, 300))
  if (errors.length) outcome.errors = errors.slice(0, 5)
  return outcome
}
