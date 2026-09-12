/**
 * Vertex AI Search client for the Semantic Brain.
 *
 * Queries the Vertex AI Search engine to retrieve semantically relevant
 * content from indexed data stores (Google Drive, Gmail, Chat, etc.).
 *
 * Project: semantic-brain-desktop
 * Engine:  semanticbrain_1779229063037
 *
 * Authentication: Uses a GCP service account key stored in the
 * GOOGLE_SERVICE_ACCOUNT_KEY environment variable (JSON string).
 *
 * ── Failure contract: searchSemanticBrain THROWS ──
 * Every failure mode here — unconfigured key, non-2xx, network/abort — used to
 * `return null`, and callers wrapped the call in `breaker.execute('vertex-ai', …)`.
 * CircuitBreaker counts a failure only when the wrapped fn REJECTS, and resets
 * `failures = 0` on any resolved value (lib/circuit-breaker.ts:62,77). A `null`
 * return is a resolved value, so every Vertex failure was scored as a SUCCESS and
 * reset the counter: the `vertex-ai` circuit could never open, and the
 * CircuitOpenError handlers in app/api/chat/route.ts were unreachable. During a
 * real outage every turn then paid the full search timeout with no protection.
 *
 * This is the same defect lib/exa.ts:37-43 already fixed for searchWeb ("the
 * circuit breaker wrapped around this function never saw a failure (so it could
 * never trip)"); it was never back-ported here. Now: unavailability REJECTS with
 * VertexUnavailableError, and `[]` means the search genuinely ran and matched
 * nothing. Callers must keep those two cases distinct — reporting unavailability
 * as "zero matches" is what made the model tell users their documents don't exist.
 */

import { swallow } from '@/lib/swallow'
import { VERTEX_SEARCH_MS } from '@/lib/timeout-config'

const GCP_PROJECT = process.env.VERTEX_GCP_PROJECT ?? 'semantic-brain-desktop'
const ENGINE_ID = process.env.VERTEX_ENGINE_ID ?? 'semanticbrain_1779229063037'
const LOCATION = 'global'

/**
 * Why the Semantic Brain could not answer. `unconfigured` is a deployment gap
 * (no service-account key mounted); the rest are live upstream failures. All of
 * them are genuine unavailability and must never be presented as "no results".
 */
export type VertexFailureReason = 'unconfigured' | 'auth' | 'http' | 'network'

/** Thrown when Vertex is unavailable, so the circuit breaker actually sees it. */
export class VertexUnavailableError extends Error {
  readonly reason: VertexFailureReason
  readonly status?: number

  constructor(reason: VertexFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'VertexUnavailableError'
    this.reason = reason
    this.status = status
  }
}

export interface VertexSearchResult {
  title: string
  snippet: string
  uri?: string
  source?: string
}

/* ── GCP Access Token via Service Account ── */

interface ServiceAccountKey {
  client_email: string
  private_key: string
  token_uri: string
}

let cachedToken: { token: string; expiresAt: number } | null = null

async function getAccessToken(signal: AbortSignal): Promise<string> {
  let keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) {
    throw new VertexUnavailableError(
      'unconfigured',
      'GOOGLE_SERVICE_ACCOUNT_KEY is not set — no service account to authenticate the Semantic Brain with',
    )
  }

  // Defensive: strip wrapping single/double quotes (common .env copy-paste error)
  keyJson = keyJson.replace(/^['"]|['"]$/g, '')

  // Return cached token if still valid (with 60s buffer)
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) {
    return cachedToken.token
  }

  try {
    const key: ServiceAccountKey = JSON.parse(keyJson)

    // Build JWT
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const claimSet = {
      iss: key.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: key.token_uri,
      iat: now,
      exp: now + 3600,
    }
    const payload = Buffer.from(JSON.stringify(claimSet)).toString('base64url')

    // Sign with private key
    const crypto = await import('crypto')
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(key.private_key, 'base64url')
    const jwt = `${header}.${payload}.${signature}`

    // Exchange JWT for access token
    // The token exchange previously passed NO signal, making it the one
    // unbounded hop in a branch its caller believed was capped. It now shares
    // the caller's deadline, so auth cannot outlive the search it is for.
    const res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
      signal,
    })

    if (!res.ok) {
      console.error('[vertex] Token exchange failed:', res.status)
      throw new VertexUnavailableError(
        'auth',
        `Service-account token exchange failed with HTTP ${res.status}`,
        res.status,
      )
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
    return cachedToken.token
  } catch (err) {
    // Already classified (bad HTTP from the exchange) — don't re-wrap it.
    if (err instanceof VertexUnavailableError) throw err
    console.error('[vertex] Service account auth error:', err)
    // A malformed key JSON / unparseable private key is an auth fault; an abort
    // or socket error is a network fault. Both are unavailability, not emptiness.
    const network = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    throw new VertexUnavailableError(
      network ? 'network' : 'auth',
      `Service-account authentication failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

/* ── Vertex AI Search Query ── */

/**
 * Build the Discovery Engine `:search` request body (audit P0-4).
 *
 * To restrict a blended/multi-datastore engine to one datastore, the correct
 * mechanism is `dataStoreSpecs` referencing the FULL datastore resource path.
 * The previous code used `filter: dataStore:"<id>"`, but `filter` keys must be
 * document schema fields — `dataStore` is not one, so Vertex returned
 * 400 INVALID_ARGUMENT and the search silently fell back to null (the Semantic
 * Brain was dead for every scoped/attachment query). A bare id is expanded to a
 * full resource path; an already-qualified path is used as-is.
 *
 * Exported for unit testing the request shape (the live call needs GCP creds).
 */
export function buildSearchBody(query: string, dataStore?: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    query,
    pageSize: 5,
    // NOTE: queryExpansionSpec and spellCorrectionSpec are NOT supported
    // on multi-datastore engines (returns 400 INVALID_ARGUMENT)
    contentSearchSpec: {
      snippetSpec: { returnSnippet: true, maxSnippetCount: 3 },
      extractiveContentSpec: {
        maxExtractiveAnswerCount: 2,
        maxExtractiveSegmentCount: 3,
      },
    },
  }

  if (dataStore) {
    const dataStorePath = dataStore.includes('/')
      ? dataStore
      : `projects/${GCP_PROJECT}/locations/${LOCATION}/collections/default_collection/dataStores/${dataStore}`
    body.dataStoreSpecs = [{ dataStore: dataStorePath }]
  }

  return body
}

/**
 * Search the Semantic Brain for relevant content.
 *
 * @param query - Natural language search query
 * @param dataStore - Optional data store filter (e.g. 'rxfit-gdrive')
 * @param signal - Deadline for the whole operation (auth + search). Defaults to
 *   VERTEX_SEARCH_MS. Callers with a TIGHTER outer bound must pass their own, or
 *   the inner abort is unreachable and a given-up request keeps running.
 * @returns Search results. `[]` means the search ran and matched nothing.
 * @throws VertexUnavailableError if Vertex could not be reached or authenticated.
 */
export async function searchSemanticBrain(
  query: string,
  dataStore?: string,
  signal: AbortSignal = AbortSignal.timeout(VERTEX_SEARCH_MS),
): Promise<VertexSearchResult[]> {
  // Auth shares the search's deadline — see getAccessToken.
  const token = await getAccessToken(signal)

  try {
    const servingConfigPath = `projects/${GCP_PROJECT}/locations/${LOCATION}/collections/default_collection/engines/${ENGINE_ID}/servingConfigs/default_serving_config`
    const url = `https://discoveryengine.googleapis.com/v1/${servingConfigPath}:search`

    const body = buildSearchBody(query, dataStore)

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      // Was AbortSignal.timeout(10_000) — LONGER than the 8s bound its chat
      // caller applied, so this abort could never fire first and every timed-out
      // search orphaned a live request. The deadline is now the caller's.
      signal,
    })

    if (!res.ok) {
      const errBody = await res.text().catch((err: unknown) => { swallow(err, { module: 'vertex', op: 'readSearchErrorBody' }); return '' })
      console.error(`[vertex] Search failed: ${res.status} ${errBody}`)
      throw new VertexUnavailableError(
        'http',
        `Discovery Engine search failed with HTTP ${res.status}: ${errBody.slice(0, 300)}`,
        res.status,
      )
    }

    const data = await res.json() as {
      results?: Array<{
        document?: {
          name?: string
          derivedStructData?: {
            title?: string
            link?: string
            snippets?: Array<{ snippet?: string }>
            extractive_answers?: Array<{ content?: string }>
            extractive_segments?: Array<{ content?: string }>
          }
        }
      }>
    }

    if (!data.results?.length) return []

    return data.results.map(r => {
      const doc = r.document?.derivedStructData
      const snippets = doc?.snippets?.map(s => s.snippet).filter(Boolean) ?? []
      const answers = doc?.extractive_answers?.map(a => a.content).filter(Boolean) ?? []
      const segments = doc?.extractive_segments?.map(s => s.content).filter(Boolean) ?? []

      // Prefer extractive answers > segments > snippets
      const bestContent = [...answers, ...segments, ...snippets].join('\n\n')

      return {
        title: doc?.title ?? 'Untitled',
        snippet: bestContent || '[No content extracted]',
        uri: doc?.link,
        source: 'vertex-ai',
      }
    })
  } catch (err) {
    if (err instanceof VertexUnavailableError) throw err
    console.error('[vertex] Search error:', err)
    const aborted = err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')
    throw new VertexUnavailableError(
      'network',
      aborted
        ? `Discovery Engine search aborted after ${VERTEX_SEARCH_MS}ms or by the caller's deadline`
        : `Discovery Engine search failed: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}
