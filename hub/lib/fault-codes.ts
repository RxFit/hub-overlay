/**
 * The closed fault taxonomy (ERROR_REPORTING_2026-08-24.md §4.3).
 *
 * TWO RULES, permanent:
 *  1. A shipped code is a public contract. Support macros, alert rules,
 *     runbooks and client branches key on it — renaming one is a breaking
 *     change even when the HTTP status is unchanged. ADD, NEVER REPURPOSE.
 *  2. Exhaustiveness is compiler-enforced. `statusForCode` and
 *     `classifyCode` end in a `never` default, so a new code nobody mapped
 *     fails `tsc --noEmit` rather than silently 500-ing in production. This
 *     is the entire reason the taxonomy is a closed union rather than a
 *     family of unrelated Error subclasses.
 *
 * `code` is the ONLY field allowed as a metric/alert/dashboard dimension —
 * low-cardinality by construction (OTel `error.type` semantics).
 */

/** Which mechanism caught the fault. Decides what the record can know. */
export type FaultLayer =
  | 'client' | 'edge' | 'route' | 'action' | 'lib'
  | 'stream' | 'job' | 'cron' | 'process' | 'invariant'

/** OTel severity semantics (21/17/13/5). Assigned from expected IMPACT. */
export type FaultSeverity = 'fatal' | 'error' | 'degraded' | 'expected'

/** A 4xx SERVED is the caller's problem; the identical 4xx RECEIVED is ours. */
export type FaultBlame = 'client' | 'server' | 'upstream' | 'timeout' | 'cancelled'

export type FaultCode =
  // transport / upstream
  | 'upstream_5xx' | 'upstream_4xx' | 'upstream_unavailable' | 'upstream_breaker_open'
  | 'timeout_connect' | 'timeout_idle' | 'rate_limited'
  // AI
  | 'ai_provider_error' | 'ai_context_length' | 'ai_content_filter' | 'ai_truncated'
  | 'ai_empty_billed' | 'tool_args_invalid_schema' | 'tool_args_truncated' | 'tool_unknown_name'
  // data / platform
  | 'db_error' | 'db_table_missing' | 'db_constraint' | 'vector_store_error'
  // auth
  | 'auth_unauthenticated' | 'auth_forbidden' | 'auth_reauth_required'
  | 'google_scope_missing' | 'google_api_not_enabled'
  // request
  | 'validation_failed' | 'not_found' | 'conflict' | 'payload_too_large'
  // streaming
  | 'stream_mid_failure' | 'stream_incomplete' | 'stream_stalled'
  // queue / worker
  | 'queue_full' | 'worker_unreachable' | 'worker_timeout' | 'job_orphaned'
  // client
  | 'client_render' | 'client_hydration' | 'client_chunk_load'
  | 'client_unhandled_rejection' | 'client_resource_load'
  | 'client_csp_violation' | 'client_query_error' | 'client_deprecation'
  // webhooks / channels
  | 'webhook_delivery_failed' | 'watch_channel_expired'
  // meta
  | 'contract_violation' | 'invariant_violation' | 'sink_write_failed'
  | 'internal' | 'unmapped'

/** Per-code classification defaults. Derived ONCE here so no caller re-derives
 *  them wrongly; `toFault`'s ctx can override where a boundary knows better. */
export interface CodeClassification {
  severity: FaultSeverity
  blame: FaultBlame
  isExpected: boolean
  /** breaker_open and content_filter are false BY DEFINITION — retrying them
   *  reproduces the identical failure at full cost. */
  isRetryable: boolean
}

/**
 * HTTP status a route returns for each code. Exhaustive by construction: the
 * `never` default only compiles while every member is handled above it.
 */
export function statusForCode(code: FaultCode): number {
  switch (code) {
    case 'validation_failed':          return 422
    case 'auth_unauthenticated':
    case 'auth_reauth_required':       return 401
    case 'auth_forbidden':
    case 'google_scope_missing':
    case 'google_api_not_enabled':     return 403
    case 'not_found':                  return 404
    case 'conflict':                   return 409
    case 'payload_too_large':          return 413
    case 'rate_limited':               return 429
    case 'upstream_4xx':
    case 'upstream_5xx':
    case 'upstream_unavailable':
    case 'upstream_breaker_open':
    case 'ai_provider_error':          return 502
    case 'timeout_connect':
    case 'timeout_idle':
    case 'stream_stalled':
    case 'worker_timeout':             return 504
    case 'queue_full':
    case 'worker_unreachable':
    case 'db_table_missing':           return 503
    case 'ai_context_length':          return 413
    case 'ai_content_filter':          return 422
    case 'ai_truncated':
    case 'ai_empty_billed':
    case 'tool_args_invalid_schema':
    case 'tool_args_truncated':
    case 'tool_unknown_name':
    case 'stream_mid_failure':
    case 'stream_incomplete':
    case 'db_error':
    case 'db_constraint':
    case 'vector_store_error':
    case 'job_orphaned':
    case 'webhook_delivery_failed':
    case 'watch_channel_expired':
    case 'client_render':
    case 'client_hydration':
    case 'client_chunk_load':
    case 'client_unhandled_rejection':
    case 'client_resource_load':
    case 'client_csp_violation':
    case 'client_query_error':
    case 'client_deprecation':
    case 'contract_violation':
    case 'invariant_violation':
    case 'sink_write_failed':
    case 'internal':
    case 'unmapped':                   return 500
    default: {
      const _never: never = code
      return 500
    }
  }
}

/** Same exhaustive pattern for severity/blame/expected/retryable defaults. */
export function classifyCode(code: FaultCode): CodeClassification {
  switch (code) {
    // ── expected: modeled outcomes, never defects ────────────────────────
    case 'validation_failed':
    case 'not_found':
    case 'conflict':
    case 'payload_too_large':
    case 'auth_unauthenticated':
    case 'auth_forbidden':
      return { severity: 'expected', blame: 'client', isExpected: true, isRetryable: false }
    case 'rate_limited':
      return { severity: 'expected', blame: 'client', isExpected: true, isRetryable: true }
    case 'auth_reauth_required':
    case 'google_scope_missing':
    case 'google_api_not_enabled':
      return { severity: 'expected', blame: 'upstream', isExpected: true, isRetryable: false }
    // ── degraded: handled/partial — the operation still returned ─────────
    case 'upstream_breaker_open':
    case 'queue_full':
      return { severity: 'degraded', blame: 'upstream', isExpected: true, isRetryable: false }
    case 'ai_truncated':
    case 'ai_empty_billed':
    case 'ai_content_filter':
    case 'ai_context_length':
    case 'client_deprecation':
      return { severity: 'degraded', blame: 'upstream', isExpected: true, isRetryable: false }
    case 'watch_channel_expired':
      return { severity: 'degraded', blame: 'server', isExpected: true, isRetryable: true }
    // ── timeouts ─────────────────────────────────────────────────────────
    case 'timeout_connect':
    case 'timeout_idle':
    case 'stream_stalled':
    case 'worker_timeout':
      return { severity: 'error', blame: 'timeout', isExpected: false, isRetryable: true }
    // ── upstream errors ──────────────────────────────────────────────────
    case 'upstream_5xx':
    case 'upstream_unavailable':
    case 'ai_provider_error':
      return { severity: 'error', blame: 'upstream', isExpected: false, isRetryable: true }
    case 'upstream_4xx':
      return { severity: 'error', blame: 'upstream', isExpected: false, isRetryable: false }
    // ── data / platform ──────────────────────────────────────────────────
    case 'db_table_missing':
      // docker-entrypoint.sh is deliberately NON-FATAL on migration failure
      // (the 2026-07-10 outage), so a missing table is a live runtime
      // possibility — and app-wide, hence fatal.
      return { severity: 'fatal', blame: 'server', isExpected: false, isRetryable: false }
    case 'db_error':
    case 'vector_store_error':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: true }
    case 'db_constraint':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: false }
    // ── streaming / queue ────────────────────────────────────────────────
    case 'stream_mid_failure':
    case 'stream_incomplete':
    case 'worker_unreachable':
    case 'job_orphaned':
    case 'webhook_delivery_failed':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: true }
    // ── AI tool-call quality ─────────────────────────────────────────────
    case 'tool_args_invalid_schema':
    case 'tool_unknown_name':
      return { severity: 'error', blame: 'upstream', isExpected: false, isRetryable: true }
    case 'tool_args_truncated':
      return { severity: 'error', blame: 'upstream', isExpected: false, isRetryable: false }
    // ── client ───────────────────────────────────────────────────────────
    case 'client_render':
    case 'client_hydration':
    case 'client_chunk_load':
    case 'client_unhandled_rejection':
    case 'client_query_error':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: false }
    case 'client_resource_load':
    case 'client_csp_violation':
      return { severity: 'degraded', blame: 'server', isExpected: false, isRetryable: false }
    // ── meta ─────────────────────────────────────────────────────────────
    case 'contract_violation':
    case 'invariant_violation':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: false }
    case 'sink_write_failed':
      return { severity: 'fatal', blame: 'server', isExpected: false, isRetryable: true }
    case 'internal':
    case 'unmapped':
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: false }
    default: {
      const _never: never = code
      return { severity: 'error', blame: 'server', isExpected: false, isRetryable: false }
    }
  }
}

/**
 * The ONLY text a client ever sees, fixed per code (VError's WError design:
 * preserve the chain for logging, hide the lower-level message from the top).
 * Exhaustive by type: a new code without an entry fails tsc.
 */
export const USER_MESSAGES: Record<FaultCode, string> = {
  upstream_5xx: 'An upstream service failed. Please try again.',
  upstream_4xx: 'An upstream service rejected the request.',
  upstream_unavailable: 'An upstream service is unreachable. Please try again shortly.',
  upstream_breaker_open: 'A dependency is temporarily paused after repeated failures. Please try again shortly.',
  timeout_connect: 'The request timed out before a connection was made. Please try again.',
  timeout_idle: 'The request timed out waiting for a response. Please try again.',
  rate_limited: 'Too many requests — please slow down.',
  ai_provider_error: 'The AI provider returned an error. Please try again.',
  ai_context_length: 'This conversation is too long for the model. Start a new chat or trim the context.',
  ai_content_filter: 'The AI provider declined to answer this request.',
  ai_truncated: 'The AI response was cut short.',
  ai_empty_billed: 'The AI provider returned an empty response.',
  tool_args_invalid_schema: 'A tool call could not be completed.',
  tool_args_truncated: 'A tool call was interrupted before it completed.',
  tool_unknown_name: 'A tool call could not be completed.',
  db_error: 'A database operation failed. Please try again.',
  db_table_missing: 'The service is missing a required database table. An operator has been notified.',
  db_constraint: 'The change conflicts with existing data.',
  vector_store_error: 'The knowledge index is unavailable. Please try again.',
  auth_unauthenticated: 'Unauthorized',
  auth_forbidden: 'Forbidden',
  auth_reauth_required: 'Your Google session expired — please sign in again.',
  google_scope_missing: 'This feature needs a Google permission your account has not granted yet.',
  google_api_not_enabled: 'A Google API this feature needs is not enabled for this project.',
  validation_failed: 'The request was invalid.',
  not_found: 'Not found.',
  conflict: 'The request conflicts with the current state.',
  payload_too_large: 'The request is too large.',
  stream_mid_failure: 'The response failed part-way through. Please try again.',
  stream_incomplete: 'The response ended unexpectedly. Please try again.',
  stream_stalled: 'The response stalled. Please try again.',
  queue_full: 'The work queue is full. Please try again shortly.',
  worker_unreachable: 'The background worker is offline. Please try again later.',
  worker_timeout: 'The background job ran out of time.',
  job_orphaned: 'A background job was left in an inconsistent state. An operator has been notified.',
  client_render: 'Something went wrong displaying this page.',
  client_hydration: 'Something went wrong loading this page.',
  client_chunk_load: 'Part of the app failed to load. Refresh the page.',
  client_unhandled_rejection: 'Something went wrong.',
  client_resource_load: 'A resource failed to load.',
  client_csp_violation: 'A resource was blocked by security policy.',
  client_query_error: 'Loading data failed. Please try again.',
  client_deprecation: 'A deprecated browser feature was used.',
  webhook_delivery_failed: 'A webhook delivery failed.',
  watch_channel_expired: 'A change-notification channel expired.',
  contract_violation: 'The service returned an inconsistent response. An operator has been notified.',
  invariant_violation: 'The service detected an inconsistent state. An operator has been notified.',
  sink_write_failed: 'Telemetry could not be recorded.',
  internal: 'Something went wrong. Please try again.',
  unmapped: 'Something went wrong. Please try again.',
}
