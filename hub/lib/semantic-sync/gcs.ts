/**
 * Minimal Cloud Storage client over the JSON API — the two operations the
 * sync needs (write an object, read a small JSON object) and nothing else.
 *
 * Plain fetch, same as every other Google call in the Hub (lib/vertex.ts,
 * lib/google-auth.ts): no @google-cloud/storage dependency and no reliance on
 * the Cloud Run runtime identity. It authenticates as the service account in
 * GOOGLE_SERVICE_ACCOUNT_KEY — the same identity that already queries the
 * Semantic Brain — so one IAM principal owns read, write and import.
 */

import { SemanticSyncError, failFromResponse, fetchWithRetry, type FetchLike, type SyncStage } from './http'

export interface ObjectStore {
  /** gs:// URI of an object name in this bucket. */
  uri(name: string): string
  put(name: string, body: string, contentType: string): Promise<void>
  /** Parsed JSON, or null when the object does not exist. */
  getJson<T>(name: string): Promise<T | null>
}

export function createGcsStore(opts: {
  bucket: string
  token: () => Promise<string>
  signal?: AbortSignal
  fetchImpl?: FetchLike
}): ObjectStore {
  const fetchImpl = opts.fetchImpl ?? fetch
  const bucket = encodeURIComponent(opts.bucket)

  return {
    uri: (name) => `gs://${opts.bucket}/${name}`,

    async put(name, body, contentType) {
      const url = `https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${encodeURIComponent(name)}`
      const res = await fetchWithRetry(fetchImpl, url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await opts.token()}`,
          'Content-Type': contentType,
        },
        body,
        signal: opts.signal,
      })
      if (!res.ok) await failFromResponse(stageFor(name), `GCS write gs://${opts.bucket}/${name}`, res)
      await res.text().catch(() => '')
    },

    async getJson<T>(name: string): Promise<T | null> {
      const url = `https://storage.googleapis.com/storage/v1/b/${bucket}/o/${encodeURIComponent(name)}?alt=media`
      const res = await fetchWithRetry(fetchImpl, url, {
        headers: { Authorization: `Bearer ${await opts.token()}` },
        signal: opts.signal,
      })
      if (res.status === 404) return null
      if (!res.ok) await failFromResponse('state', `GCS read gs://${opts.bucket}/${name}`, res)
      try {
        return (await res.json()) as T
      } catch {
        throw new SemanticSyncError('state', `gs://${opts.bucket}/${name} is not valid JSON`)
      }
    },
  }
}

function stageFor(name: string): SyncStage {
  return name.endsWith('_state.json') ? 'state' : 'upload'
}
