/**
 * The request-id contract (ERROR_REPORTING_2026-08-24.md Layer 0) — PURE and
 * dependency-free on purpose: middleware runs on the Edge runtime where
 * `node:crypto` cannot be imported, so this module leans on the global Web
 * Crypto `randomUUID()` that both runtimes ship.
 *
 * An inbound `x-hub-request-id` is trusted ONLY when it is exactly a UUID.
 * On middleware-excluded paths (api/chat, api/worker, api/cron/, api/healthz,
 * api/embeddings, api/webhooks) an external caller supplies the header
 * unvalidated — correlation poisoning plus unbounded log cardinality — the
 * same injection class middleware already defends against by deleting a
 * client-supplied x-tenant-id.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A header-supplied id is accepted only if it is EXACTLY a UUID; else mint. */
export function safeRequestId(header: string | null): string {
  return header && UUID_RE.test(header) ? header.toLowerCase() : crypto.randomUUID()
}
