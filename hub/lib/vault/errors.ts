/**
 * Failure contract for the AntigravityHQ vault corpus (Lane 1) and its
 * optional live lane (Lane 2, lib/vault/smart-connections.ts).
 *
 * Same rule as lib/vertex.ts: unavailability THROWS, it never resolves to an
 * empty value. `[]` from a search means the index was queried and matched
 * nothing; a rejected VaultUnavailableError means the answer is unknown. The
 * circuit breaker (lib/circuit-breaker.ts) counts a failure only when the
 * wrapped fn rejects, so this is also what lets the `vault-embeddings` and
 * `vault-db` circuits actually open during an outage.
 *
 * `stage` says WHICH upstream failed (the operator's question); `reason` says
 * HOW (the classification the route maps to a status). Neither ever carries
 * note content, a query string or a credential.
 *
 * Lane 2 uses stage 'smart_connections' with the same reason vocabulary
 * ('network' is the "unreachable" class; 'protocol' is its own). Its failures
 * never reach the route as a rejection — lib/vault/live-evidence.ts folds them
 * into `liveEvidence.status` because the live lane is advisory and must never
 * fail the canonical request.
 */

export type VaultFailureStage = 'config' | 'github' | 'embedding' | 'db' | 'smart_connections'

export type VaultFailureReason =
  | 'unconfigured'   // a required env var is missing
  | 'auth'           // upstream rejected OUR credential: 401/403, or Gemini's 400 API_KEY_* rejection
  | 'not_found'      // upstream says the thing does not exist (404): a ref/tree/blob, or the embedding model id
  | 'http'           // any other non-2xx
  | 'network'        // DNS/TLS/socket/abort
  | 'timeout'        // our own deadline expired
  | 'breaker_open'   // circuit open — upstream not even dialled
  | 'integrity'      // the payload did not verify (blob SHA mismatch, truncated tree)
  | 'protocol'       // the upstream answered, but not in the protocol we speak (Lane 2: bad JSON-RPC, missing tool, unrecognized result)
  | 'internal'       // unexpected local failure (DB driver error, …)

export class VaultUnavailableError extends Error {
  readonly stage: VaultFailureStage
  readonly reason: VaultFailureReason
  readonly status?: number

  constructor(stage: VaultFailureStage, reason: VaultFailureReason, message: string, status?: number) {
    super(message)
    this.name = 'VaultUnavailableError'
    this.stage = stage
    this.reason = reason
    this.status = status
  }
}

export function isVaultUnavailable(err: unknown): err is VaultUnavailableError {
  return err instanceof VaultUnavailableError
}

/**
 * The one HTTP-status → reason rule every upstream shares (GitHub, Gemini):
 * 401/403 is our credential, 404 is a missing thing, anything else is `http`
 * with the status carried on the error. Upstream-specific cases (Gemini's 400
 * API_KEY_* rejections) are layered on top by the caller.
 */
export function classifyHttpStatus(status: number): Extract<VaultFailureReason, 'auth' | 'not_found' | 'http'> {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  return 'http'
}

/** Single-line, bounded, never a stack: safe to store in vault_sync_runs.error. */
export function describeError(err: unknown, max = 300): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}
