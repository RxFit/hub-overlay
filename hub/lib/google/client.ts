/**
 * Shared Google REST client — the single fetch path for every Workspace API
 * module under `lib/google/`.
 *
 * `lib/google.ts` (the legacy monolith) has its own private `googleFetch` with
 * no retry. This module is what new per-API code builds on, and it adds the one
 * thing the legacy helper lacks: **retry with truncated exponential backoff and
 * jitter**, honoring `Retry-After`.
 *
 * ── Why retry at all, when quota headroom is ample ──
 * Per-user quotas (Slides/Docs/Sheets writes 60/min, Drive 325k units/min) are
 * far above what a small team generates. The retry is for BURSTS: compiling a
 * deck is 4–6 writes back-to-back, and Drive/Slides answer a burst with 429 or
 * a 403 carrying a rate-limit reason. Failing the user's deck because two
 * batches landed in the same second would be self-inflicted.
 *
 * ── Which failures retry (and the one that must NOT) ──
 *  - 429, 5xx, network/timeout errors → transient, retried.
 *  - 403 → retried ONLY when the body names a rate/quota reason. Google reuses
 *    403 for BOTH quota exhaustion and permission denial, and an
 *    insufficient-scope 403 is permanent: retrying it burns the user's latency
 *    budget and delays the `MISSING_SCOPE` re-consent prompt
 *    (`googleWriteErrorResponse`, lib/google-session.ts). Scope denials must
 *    fail fast.
 *
 * ── Why the delay ceiling is 8s, not the 64s the API guides suggest ──
 * Google's canonical guidance targets batch/back-end jobs. These calls sit
 * inside interactive HTTP routes bounded by the timeout ladder
 * (`lib/timeout-config.ts`): a single Google call is capped at
 * GOOGLE_API_TIMEOUT_MS (10s) and the whole request must finish well inside
 * ROUTE_MAX_DURATION_MS (120s). A 64s sleep would blow the route budget and the
 * user would see a timeout instead of the retry ever helping. Background work
 * (scheduled reports) can opt into a longer ceiling via the `retry` option.
 *
 * Thrown-error text intentionally keeps the legacy `Google API error <status>:
 * <body>` shape — `mapGoogleErrorToStatus` parses the first 3-digit token out of
 * it to pick the HTTP status the Hub returns, so changing the format here would
 * silently break auth-recovery and MISSING_SCOPE detection downstream.
 */

import { GOOGLE_API_TIMEOUT_MS } from '../timeout-config'

/** Tuning for the retry loop. Defaults suit interactive routes. */
export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. Default 3. */
  attempts?: number
  /** First backoff delay; doubles per attempt. Default 400ms. */
  baseDelayMs?: number
  /** Ceiling for any single backoff delay. Default 8_000ms (see file header). */
  maxDelayMs?: number
}

export interface GoogleFetchInit extends RequestInit {
  /** Per-call retry override; omit for the interactive defaults. */
  retry?: RetryPolicy
  /** Per-call timeout override; defaults to GOOGLE_API_TIMEOUT_MS. */
  timeoutMs?: number
}

const DEFAULT_ATTEMPTS = 3
const DEFAULT_BASE_DELAY_MS = 400
const DEFAULT_MAX_DELAY_MS = 8_000

/**
 * A 403 is retryable only when Google names a rate/quota reason. Anything else
 * behind a 403 is a permission problem that re-trying cannot fix.
 */
const RATE_LIMIT_MARKERS =
  /rate ?limit|ratelimitexceeded|userratelimitexceeded|quotaexceeded|quota exceeded|backenderror|resource has been exhausted/i

/** Network-layer failures worth another attempt (DNS blips, resets, timeouts). */
const TRANSIENT_NETWORK_ERROR =
  /\b(timeout|timed out|network|fetch failed|econn|enotfound|socket|aborted|and the operation was aborted)\b/i

/**
 * True when an upstream HTTP status (plus body, for the 403 case) should be
 * retried. Exported for direct unit testing of the policy.
 */
export function isRetryableStatus(status: number, body = ''): boolean {
  if (status === 429) return true
  if (status >= 500 && status <= 599) return true
  if (status === 403) return RATE_LIMIT_MARKERS.test(body)
  return false
}

/**
 * Delay before the next attempt: truncated exponential backoff with full
 * jitter, unless the server sent a `Retry-After` we should obey instead.
 *
 * `attempt` is 0-based (0 = the delay after the first failure). Full jitter
 * (random across the whole window rather than a fixed base plus noise) is what
 * actually de-synchronizes concurrent retries — a deck compile fires several
 * batches at once, and equal-delay retries would collide again in lockstep.
 *
 * A `Retry-After` is honored but still clamped to `maxDelayMs`: an upstream
 * asking for 120s must not park an interactive route past its deadline — better
 * to surface the error and let the caller decide.
 *
 * Pure (except jitter, which is injectable) so the policy is unit-testable.
 */
export function computeBackoffDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  policy: RetryPolicy = {},
  random: () => number = Math.random,
): number {
  const base = policy.baseDelayMs ?? DEFAULT_BASE_DELAY_MS
  const max = policy.maxDelayMs ?? DEFAULT_MAX_DELAY_MS

  const retryAfterMs = parseRetryAfterMs(retryAfterHeader)
  if (retryAfterMs !== null) return Math.min(retryAfterMs, max)

  const window = Math.min(base * 2 ** attempt, max)
  return Math.round(window * random())
}

/**
 * `Retry-After` is either delta-seconds or an HTTP date. Returns null when
 * absent or unparseable (caller falls back to exponential backoff), and never
 * returns a negative delay for a date already in the past.
 */
function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (!trimmed) return null

  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) * 1000

  const dateMs = Date.parse(trimmed)
  if (Number.isNaN(dateMs)) return null
  return Math.max(0, dateMs - Date.now())
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/**
 * Perform one bounded request. Split out so both the JSON and raw entry points
 * share identical timeout + header handling.
 */
async function attemptFetch(url: string, accessToken: string, init: GoogleFetchInit): Promise<Response> {
  const { retry: _retry, timeoutMs, headers, ...rest } = init
  return fetch(url, {
    signal: AbortSignal.timeout(timeoutMs ?? GOOGLE_API_TIMEOUT_MS),
    ...rest,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...headers,
    },
  })
}

/**
 * Core retry loop shared by every exported helper. Returns the first response
 * that is either successful or non-retryable; throws on exhaustion.
 */
async function fetchWithRetry(
  url: string,
  accessToken: string,
  init: GoogleFetchInit,
): Promise<Response> {
  const policy = init.retry ?? {}
  const attempts = Math.max(1, policy.attempts ?? DEFAULT_ATTEMPTS);

  let lastError: unknown

  for (let attempt = 0; attempt < attempts; attempt++) {
    let res: Response
    try {
      res = await attemptFetch(url, accessToken, init)
    } catch (err) {
      // Network/timeout failure — retry if we have attempts left, else rethrow
      // so the message reaches mapGoogleErrorToStatus as a 502-ish signal.
      lastError = err
      const message = err instanceof Error ? err.message : String(err)
      const isLast = attempt === attempts - 1
      if (isLast || !TRANSIENT_NETWORK_ERROR.test(message)) throw err
      await sleep(computeBackoffDelayMs(attempt, null, policy))
      continue
    }

    if (res.ok) return res

    // Read the body once: it is needed both to decide retryability (403 case)
    // and to build the thrown error message.
    const body = await res.text().catch(() => 'Unknown error')
    const isLast = attempt === attempts - 1
    if (isLast || !isRetryableStatus(res.status, body)) {
      throw new Error(`Google API error ${res.status}: ${body}`)
    }

    await sleep(computeBackoffDelayMs(attempt, res.headers.get('retry-after'), policy))
  }

  // Unreachable: the loop either returns or throws. Kept for exhaustiveness.
  throw lastError instanceof Error ? lastError : new Error('Google API error: retries exhausted')
}

/**
 * JSON request → parsed body. The default for Google REST calls.
 *
 * Sets `Content-Type: application/json` unless the caller overrides it (Drive
 * uploads pass their own multipart content type).
 */
export async function googleFetch<T>(
  url: string,
  accessToken: string,
  init: GoogleFetchInit = {},
): Promise<T> {
  const res = await fetchWithRetry(url, accessToken, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  })
  return res.json() as Promise<T>
}

/**
 * Request with no response body to parse (DELETE/204 endpoints). Google answers
 * these with an empty body, so calling `.json()` would throw on valid success.
 */
export async function googleFetchVoid(
  url: string,
  accessToken: string,
  init: GoogleFetchInit = {},
): Promise<void> {
  await fetchWithRetry(url, accessToken, init)
}

/**
 * Request returning raw bytes (thumbnail/export downloads), with the same retry
 * semantics. The caller owns the Response.
 */
export async function googleFetchRaw(
  url: string,
  accessToken: string,
  init: GoogleFetchInit = {},
): Promise<Response> {
  return fetchWithRetry(url, accessToken, init)
}

/* ══════════════════════════════════════════
   Drive multipart upload
   ══════════════════════════════════════════ */

const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files'

/** Boundary token for multipart/related bodies. */
const MULTIPART_BOUNDARY = 'hub-overlay-boundary-7f3a9c1e'

/**
 * Build a `multipart/related` body pairing file metadata with file content —
 * the shape Drive requires to create a file and its bytes in ONE request.
 *
 * Exported for unit testing: the wire format is picky (CRLF line endings, the
 * closing `--boundary--`), and a malformed body fails as an opaque Drive 400.
 */
export function buildMultipartBody(
  metadata: Record<string, unknown>,
  content: string,
  contentType: string,
): string {
  return [
    `--${MULTIPART_BOUNDARY}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${MULTIPART_BOUNDARY}`,
    `Content-Type: ${contentType}`,
    '',
    content,
    `--${MULTIPART_BOUNDARY}--`,
    '',
  ].join('\r\n')
}

export const MULTIPART_CONTENT_TYPE = `multipart/related; boundary=${MULTIPART_BOUNDARY}`

/**
 * Create a Drive file from metadata + content in a single multipart upload.
 *
 * This is how markdown becomes a real formatted Google Doc: set the metadata
 * `mimeType` to `application/vnd.google-apps.document` and the media content
 * type to `text/markdown`, and Drive performs the conversion server-side
 * (headings, bold, lists, tables, links) — no Docs index math anywhere.
 *
 * `parents` in the metadata places the file directly in the Hub workspace
 * folder at creation time, so the file never briefly appears at Drive root.
 */
export async function driveMultipartUpload<T>(
  accessToken: string,
  metadata: Record<string, unknown>,
  content: string,
  contentType: string,
  opts: { fileId?: string; fields?: string; retry?: RetryPolicy } = {},
): Promise<T> {
  const params = new URLSearchParams({ uploadType: 'multipart' })
  if (opts.fields) params.set('fields', opts.fields)

  // A fileId means "replace this file's content" (PATCH); otherwise create.
  const url = opts.fileId
    ? `${DRIVE_UPLOAD_BASE}/${opts.fileId}?${params}`
    : `${DRIVE_UPLOAD_BASE}?${params}`

  return googleFetch<T>(url, accessToken, {
    method: opts.fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': MULTIPART_CONTENT_TYPE },
    body: buildMultipartBody(metadata, content, contentType),
    retry: opts.retry,
  })
}
