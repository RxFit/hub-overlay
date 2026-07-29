/**
 * Semantic Brain (Vertex AI Search) connection diagnostics — SERVER-ONLY.
 *
 * WHY THIS EXISTS
 * ---------------
 * `searchSemanticBrain()` is deliberately fail-soft: every failure mode —
 * missing service-account key, malformed JSON, a rejected JWT exchange, a 403
 * on the engine, a wrong engine ID — returns `null` or `[]`. The chat route
 * then renders the SAME "[No matching documents found…]" note for "the index
 * has nothing about Nuvita" and for "this deployment has never been able to
 * reach Vertex at all".
 *
 * That is the right behavior for a user-facing chat turn and useless for
 * operating the thing. You cannot tell a working-but-empty Semantic Brain from
 * a dead one, which is precisely the question "is the semantic-brain-desktop
 * connection up?" needs answered.
 *
 * So this module walks the SAME auth and query path and reports exactly which
 * stage fails, with the HTTP status and Google's own error message. It is a
 * diagnostic, not a code path the chat flow depends on.
 *
 * SECURITY: never returns or logs the service-account private key, the derived
 * access token, or document contents. Only stage outcomes, HTTP statuses,
 * Google's error text, the (non-secret) project/engine IDs, and the service
 * account's client_email — the same class of identifier already printed by the
 * startup OAuth diagnostic in lib/auth.ts.
 */

import { buildSearchBody } from './vertex'

export type VertexHealthStage =
  | 'config'      // env vars present and parseable
  | 'auth'        // service-account JWT → access token
  | 'query'       // engine reachable and serving

export type VertexHealthStatus = 'ok' | 'fail' | 'skipped'

export interface VertexStageResult {
  stage: VertexHealthStage
  status: VertexHealthStatus
  detail: string
  /** Upstream HTTP status, when the stage made a request. */
  httpStatus?: number
}

export interface VertexHealthReport {
  /** True only when every stage reached 'ok'. */
  healthy: boolean
  /** Non-secret identity of what we tried to reach. */
  target: {
    project: string
    engineId: string
    location: string
    dataStoreId?: string
    /** Service-account identity, or null when no key is configured. */
    serviceAccountEmail: string | null
  }
  stages: VertexStageResult[]
  /** Number of documents the probe query matched (undefined if it never ran). */
  resultCount?: number
  /** One-line operator-facing verdict. */
  summary: string
  /** The concrete next action, when unhealthy. */
  remediation?: string
}

const LOCATION = 'global'

function envTarget() {
  return {
    project: process.env.VERTEX_GCP_PROJECT ?? 'semantic-brain-desktop',
    engineId: process.env.VERTEX_ENGINE_ID ?? 'semanticbrain_1779229063037',
    location: LOCATION,
    dataStoreId: process.env.VERTEX_DATA_STORE_ID || undefined,
  }
}

/**
 * Parse the service-account key without leaking it.
 *
 * Mirrors lib/vertex.ts' quote-stripping so the diagnostic agrees with the
 * real code path about whether a given value is usable.
 */
function parseServiceAccount(raw: string | undefined): {
  ok: boolean
  clientEmail?: string
  tokenUri?: string
  privateKey?: string
  detail: string
} {
  if (!raw) {
    return { ok: false, detail: 'GOOGLE_SERVICE_ACCOUNT_KEY is not set' }
  }
  const cleaned = raw.replace(/^['"]|['"]$/g, '')
  if (cleaned === 'REPLACE_ME_WITH_MINIFIED_JSON') {
    return { ok: false, detail: 'GOOGLE_SERVICE_ACCOUNT_KEY still holds the .env.local.example placeholder' }
  }
  let key: { client_email?: string; private_key?: string; token_uri?: string }
  try {
    key = JSON.parse(cleaned)
  } catch {
    // Length is safe to report and is the single most useful clue for the
    // classic failure (a truncated or shell-mangled secret).
    return { ok: false, detail: `GOOGLE_SERVICE_ACCOUNT_KEY is not valid JSON (${cleaned.length} chars)` }
  }
  if (!key.client_email || !key.private_key || !key.token_uri) {
    const missing = [
      !key.client_email && 'client_email',
      !key.private_key && 'private_key',
      !key.token_uri && 'token_uri',
    ].filter(Boolean).join(', ')
    return { ok: false, detail: `service-account JSON is missing: ${missing}` }
  }
  return {
    ok: true,
    clientEmail: key.client_email,
    tokenUri: key.token_uri,
    privateKey: key.private_key,
    detail: `service account ${key.client_email}`,
  }
}

/** Mint an access token, returning Google's error text on failure. */
async function mintAccessToken(
  clientEmail: string,
  privateKey: string,
  tokenUri: string,
): Promise<{ token?: string; httpStatus?: number; detail: string }> {
  try {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
    const now = Math.floor(Date.now() / 1000)
    const payload = Buffer.from(JSON.stringify({
      iss: clientEmail,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: tokenUri,
      iat: now,
      exp: now + 3600,
    })).toString('base64url')

    const crypto = await import('crypto')
    const signer = crypto.createSign('RSA-SHA256')
    signer.update(`${header}.${payload}`)
    const signature = signer.sign(privateKey, 'base64url')

    const res = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: `${header}.${payload}.${signature}`,
      }),
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      return {
        httpStatus: res.status,
        detail: `token exchange rejected: ${res.status} ${summarizeGoogleError(body)}`,
      }
    }
    const data = await res.json() as { access_token?: string }
    if (!data.access_token) {
      return { httpStatus: res.status, detail: 'token exchange returned no access_token' }
    }
    return { token: data.access_token, httpStatus: res.status, detail: 'access token minted' }
  } catch (err) {
    // A bad private key throws here rather than returning an HTTP error.
    const msg = err instanceof Error ? err.message : String(err)
    return { detail: `token exchange failed before any response: ${msg}` }
  }
}

/**
 * Condense a Google error body to its message.
 *
 * Google's error payloads can be large and echo the request; keep the useful
 * sentence and bound the length so a diagnostic can't dump a wall of JSON into
 * an operator's terminal or a log line.
 */
export function summarizeGoogleError(body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; status?: string } }
    const message = parsed.error?.message
    const status = parsed.error?.status
    if (message) return status ? `${status}: ${message.slice(0, 300)}` : message.slice(0, 300)
  } catch {
    // not JSON — fall through
  }
  return body.replace(/\s+/g, ' ').trim().slice(0, 300) || '(empty error body)'
}

/**
 * Classify a query-stage HTTP failure into an actionable remediation.
 *
 * These are the failures that actually happen with Discovery Engine, and each
 * has a genuinely different fix — which is the whole point of not collapsing
 * them into `null`.
 */
export function remediationFor(httpStatus: number | undefined, detail: string): string {
  const lower = detail.toLowerCase()
  if (httpStatus === 403) {
    // Google phrases the disabled-API 403 as "Discovery Engine API has not been
    // used in project X before or it is disabled" — with spaces in the product
    // name — and elsewhere as the bare service host. Match either, or this
    // (very common, and differently-fixed) case gets the IAM advice instead.
    const mentionsApi = lower.includes('discoveryengine') || lower.includes('discovery engine')
    if (mentionsApi && (lower.includes('has not been used') || lower.includes('is disabled') || lower.includes('accessnotconfigured'))) {
      return 'Enable the Discovery Engine API on the project: gcloud services enable discoveryengine.googleapis.com --project=<project>'
    }
    return 'Grant the service account the Discovery Engine Viewer role on the project (roles/discoveryengine.viewer). A 403 here is an IAM problem, not a wrong ID.'
  }
  if (httpStatus === 404) {
    return 'The engine ID or project does not resolve. Confirm VERTEX_ENGINE_ID against the AI Applications console (it is the App ID, not the datastore ID) and that VERTEX_GCP_PROJECT matches the project that owns it.'
  }
  if (httpStatus === 400) {
    return 'The request shape was rejected. buildSearchBody omits queryExpansionSpec/spellCorrectionSpec because multi-datastore engines reject them — if VERTEX_DATA_STORE_ID is set, verify it is a real datastore in this engine.'
  }
  if (httpStatus === 401) {
    return 'The access token was rejected. Re-check that the service-account key is current and has not been disabled or rotated.'
  }
  if (httpStatus && httpStatus >= 500) {
    return 'Vertex AI returned a server error. This is upstream and usually transient — retry before changing configuration.'
  }
  return 'Check the project, engine ID and service-account IAM against the AI Applications console.'
}

/**
 * Probe the Semantic Brain end to end and report which stage fails.
 *
 * @param probeQuery Harmless query used to prove the engine serves. The default
 *   is deliberately generic — a term with no results still proves connectivity,
 *   so an empty result set is reported as HEALTHY with resultCount 0 rather
 *   than as a failure.
 */
export async function checkSemanticBrainHealth(
  probeQuery = 'company overview',
): Promise<VertexHealthReport> {
  const target = envTarget()
  const stages: VertexStageResult[] = []

  /* ── Stage 1: config ── */
  const sa = parseServiceAccount(process.env.GOOGLE_SERVICE_ACCOUNT_KEY)
  stages.push({
    stage: 'config',
    status: sa.ok ? 'ok' : 'fail',
    detail: sa.detail,
  })

  if (!sa.ok) {
    stages.push({ stage: 'auth', status: 'skipped', detail: 'no usable service-account key' })
    stages.push({ stage: 'query', status: 'skipped', detail: 'no access token' })
    return {
      healthy: false,
      target: { ...target, serviceAccountEmail: null },
      stages,
      summary: 'Semantic Brain is NOT connected — no usable service-account credential.',
      remediation:
        'Set GOOGLE_SERVICE_ACCOUNT_KEY on the Cloud Run service to the minified JSON key of a service account holding roles/discoveryengine.viewer on the Vertex project. Until then every semantic search silently returns no results.',
    }
  }

  const serviceAccountEmail = sa.clientEmail ?? null

  /* ── Stage 2: auth ── */
  const auth = await mintAccessToken(sa.clientEmail!, sa.privateKey!, sa.tokenUri!)
  stages.push({
    stage: 'auth',
    status: auth.token ? 'ok' : 'fail',
    detail: auth.detail,
    httpStatus: auth.httpStatus,
  })

  if (!auth.token) {
    stages.push({ stage: 'query', status: 'skipped', detail: 'no access token' })
    return {
      healthy: false,
      target: { ...target, serviceAccountEmail },
      stages,
      summary: 'Semantic Brain is NOT connected — the service account could not obtain an access token.',
      remediation:
        'The key parsed but Google rejected it. Confirm the key has not been deleted or disabled in IAM, and that private_key survived env-var escaping intact (literal \\n sequences must be real newlines in the JSON string).',
    }
  }

  /* ── Stage 3: query ── */
  const servingConfig = `projects/${target.project}/locations/${target.location}/collections/default_collection/engines/${target.engineId}/servingConfigs/default_serving_config`
  const url = `https://discoveryengine.googleapis.com/v1/${servingConfig}:search`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${auth.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildSearchBody(probeQuery, target.dataStoreId)),
      signal: AbortSignal.timeout(15_000),
    })

    if (!res.ok) {
      const detail = summarizeGoogleError(await res.text().catch(() => ''))
      stages.push({ stage: 'query', status: 'fail', detail, httpStatus: res.status })
      return {
        healthy: false,
        target: { ...target, serviceAccountEmail },
        stages,
        summary: `Semantic Brain is NOT serving — the engine returned ${res.status}.`,
        remediation: remediationFor(res.status, detail),
      }
    }

    const data = await res.json() as { results?: unknown[]; totalSize?: number }
    const resultCount = data.results?.length ?? 0
    stages.push({
      stage: 'query',
      status: 'ok',
      detail: `engine served the probe query ("${probeQuery}") with ${resultCount} result(s)`,
      httpStatus: res.status,
    })

    return {
      healthy: true,
      target: { ...target, serviceAccountEmail },
      stages,
      resultCount,
      // An empty result set still proves the connection. Say so explicitly —
      // conflating "connected but nothing indexed" with "not connected" is the
      // confusion this module exists to end.
      summary: resultCount > 0
        ? `Semantic Brain is connected and returning results (${resultCount} for the probe query).`
        : 'Semantic Brain is CONNECTED but the probe query matched nothing — auth and the engine are fine; the index may be empty or may not cover this term.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    stages.push({ stage: 'query', status: 'fail', detail: `request failed: ${msg}` })
    return {
      healthy: false,
      target: { ...target, serviceAccountEmail },
      stages,
      summary: 'Semantic Brain is NOT reachable — the search request never completed.',
      remediation:
        'A timeout or network error, not a configuration error. Confirm the Cloud Run service has egress to discoveryengine.googleapis.com, then retry.',
    }
  }
}
