/**
 * Idempotency guard for POST /api/worker/faults (ERROR_REPORTING §3 Layer 10).
 *
 * Lives outside the route module because Next rejects non-standard exports
 * from a route file, and the test hook has to be reachable.
 *
 * The worker deletes its spool only after a 2xx, so a retried upload — a
 * response lost in flight, a boot that died mid-request — is the EXPECTED
 * case, not an edge one. Without this, each retry would re-report every
 * record in the batch.
 *
 * Bounded and per-instance. Cloud Run runs 1-3 instances, so a retry routed
 * to a different instance can still double-report; the durable guard is the
 * spool's own commit-on-success, and this bounds the common case cheaply
 * rather than pretending to be exact.
 */
const SEEN_LIMIT = 500
const seen = new Set<string>()

/** True when this faultId has not been reported by this instance yet. */
export function claimFaultId(id: string): boolean {
  if (seen.has(id)) return false
  seen.add(id)
  if (seen.size > SEEN_LIMIT) {
    // Set preserves insertion order, so this evicts the oldest.
    const oldest = seen.values().next().value
    if (oldest !== undefined) seen.delete(oldest)
  }
  return true
}

/** Test hook — the set deliberately outlives a single request. */
export function _resetWorkerFaultDedupeForTests(): void {
  seen.clear()
}
