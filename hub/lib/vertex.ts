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
 * Falls back gracefully if not configured.
 */

import { swallow } from '@/lib/swallow'

const GCP_PROJECT = process.env.VERTEX_GCP_PROJECT ?? 'semantic-brain-desktop'
const ENGINE_ID = process.env.VERTEX_ENGINE_ID ?? 'semanticbrain_1779229063037'
const LOCATION = 'global'

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

async function getAccessToken(): Promise<string | null> {
  let keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY
  if (!keyJson) return null

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
    const res = await fetch(key.token_uri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    })

    if (!res.ok) {
      console.error('[vertex] Token exchange failed:', res.status)
      return null
    }

    const data = await res.json() as { access_token: string; expires_in: number }
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    }
    return cachedToken.token
  } catch (err) {
    console.error('[vertex] Service account auth error:', err)
    return null
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
 * @returns Array of search results, or null if Vertex is unavailable
 */
export async function searchSemanticBrain(
  query: string,
  dataStore?: string
): Promise<VertexSearchResult[] | null> {
  const token = await getAccessToken()
  if (!token) {
    console.warn('[vertex] No service account configured — skipping semantic search')
    return null
  }

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
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const errBody = await res.text().catch((err: unknown) => { swallow(err, { module: 'vertex', op: 'readSearchErrorBody' }); return '' })
      console.error(`[vertex] Search failed: ${res.status} ${errBody}`)
      return null
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
    console.error('[vertex] Search error:', err)
    return null
  }
}
