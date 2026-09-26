/**
 * Semantic sync configuration — which sources feed which GCS location and
 * which Vertex AI Search data store. Pure: reads an env object, never the
 * network.
 *
 * DENY BY DEFAULT. A source whose required variables are unset is reported
 * `not_configured` and nothing is fetched or written for it. The buckets, data
 * stores and the Workspace domain-wide-delegation grant are owner steps
 * (hub/docs/runbooks/semantic-sync.md); this module only reads the result.
 */

export const SYNC_SOURCES = ['stripe', 'gmail'] as const

export type SyncSourceId = (typeof SYNC_SOURCES)[number]

export interface GcsLocation {
  bucket: string
  /** Object-name prefix without leading/trailing slash; '' for the bucket root. */
  prefix: string
}

export interface SourceConfig {
  source: SyncSourceId
  /** True when every required variable is present and valid. */
  ready: boolean
  /** Env var names that are missing or invalid — the operator's to-do list. */
  missing: string[]
  location?: GcsLocation
  /**
   * Full Discovery Engine data-store resource path to import into, or
   * undefined when unset (objects are still written; the import is skipped
   * and the response says so).
   */
  dataStore?: string
  /** gmail only: the Workspace mailbox impersonated via domain-wide delegation. */
  subject?: string
  /** gmail only: Gmail search filter ANDed onto the time window. */
  query?: string
}

/** Env var names, in one place so the runbook, the example file and the code agree. */
export const ENV = {
  serviceAccountKey: 'GOOGLE_SERVICE_ACCOUNT_KEY',
  stripeKey: 'STRIPE_SECRET_KEY',
  stripeGcsUri: 'SEMANTIC_SYNC_STRIPE_GCS_URI',
  stripeDataStore: 'SEMANTIC_SYNC_STRIPE_DATA_STORE',
  gmailGcsUri: 'SEMANTIC_SYNC_GMAIL_GCS_URI',
  gmailDataStore: 'SEMANTIC_SYNC_GMAIL_DATA_STORE',
  gmailSubject: 'SEMANTIC_SYNC_GMAIL_SUBJECT',
  gmailQuery: 'SEMANTIC_SYNC_GMAIL_QUERY',
} as const

/**
 * Newsletters and social notifications are high-volume, low-signal noise for
 * a business brain. Overridable (set SEMANTIC_SYNC_GMAIL_QUERY to '' to index
 * everything the window matches).
 */
export const DEFAULT_GMAIL_QUERY = '-category:promotions -category:social'

// GCS bucket naming rules (lowercase, digits, dash, underscore, dot; 3–222).
const BUCKET_RE = /^[a-z0-9][a-z0-9._-]{1,220}[a-z0-9]$/
// Discovery Engine resource ids: letters, digits, dash, underscore.
const DATA_STORE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/
const DATA_STORE_PATH_RE =
  /^projects\/[^/]+\/locations\/[^/]+\/collections\/[^/]+\/dataStores\/[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** `gs://bucket/some/prefix/` → { bucket, prefix: 'some/prefix' }, or null. */
export function parseGcsUri(uri: string | undefined): GcsLocation | null {
  const m = uri?.trim().match(/^gs:\/\/([^/]+)(?:\/(.*))?$/)
  if (!m || !BUCKET_RE.test(m[1])) return null
  const prefix = (m[2] ?? '').replace(/^\/+|\/+$/g, '')
  if (prefix.split('/').some((seg) => seg === '.' || seg === '..')) return null
  return { bucket: m[1], prefix }
}

/**
 * Expand a bare data-store id to its full resource path under the Semantic
 * Brain project (same convention as lib/vertex.ts buildSearchBody); a full
 * path passes through. Null when the value is neither.
 */
export function resolveDataStore(
  value: string | undefined,
  project: string,
): string | null {
  const v = value?.trim()
  if (!v) return null
  if (v.includes('/')) return DATA_STORE_PATH_RE.test(v) ? v : null
  if (!DATA_STORE_ID_RE.test(v)) return null
  return `projects/${project}/locations/global/collections/default_collection/dataStores/${v}`
}

type Env = Record<string, string | undefined>

/**
 * The engine the Hub chat searches (same env + defaults as lib/vertex.ts).
 * The sync refuses to import into any data store connected to it.
 */
export function chatEnginePath(env: Env = process.env): string {
  const project = env.VERTEX_GCP_PROJECT || 'semantic-brain-desktop'
  const engine = env.VERTEX_ENGINE_ID || 'semanticbrain_1779229063037'
  return `projects/${project}/locations/global/collections/default_collection/engines/${engine}`
}

export function readSourceConfig(source: SyncSourceId, env: Env = process.env): SourceConfig {
  const missing: string[] = []
  const project = env.VERTEX_GCP_PROJECT || 'semantic-brain-desktop'

  if (!env[ENV.serviceAccountKey]) missing.push(ENV.serviceAccountKey)

  const uriVar = source === 'stripe' ? ENV.stripeGcsUri : ENV.gmailGcsUri
  const location = parseGcsUri(env[uriVar])
  if (!location) missing.push(uriVar)

  // The data store is optional, but a value that is SET and malformed is a
  // mistake to surface, not to silently skip.
  const dsVar = source === 'stripe' ? ENV.stripeDataStore : ENV.gmailDataStore
  const dataStore = resolveDataStore(env[dsVar], project)
  if (env[dsVar]?.trim() && !dataStore) missing.push(dsVar)

  const config: SourceConfig = {
    source,
    ready: false,
    missing,
    location: location ?? undefined,
    dataStore: dataStore ?? undefined,
  }

  if (source === 'stripe') {
    if (!env[ENV.stripeKey]) missing.push(ENV.stripeKey)
  } else {
    const subject = env[ENV.gmailSubject]?.trim()
    if (!subject || !EMAIL_RE.test(subject)) missing.push(ENV.gmailSubject)
    else config.subject = subject
    config.query = env[ENV.gmailQuery] ?? DEFAULT_GMAIL_QUERY
  }

  config.ready = missing.length === 0
  return config
}
