/**
 * Server-side tenant resolution — single source of truth.
 *
 * Phase 0 (current): single-tenant. Resolves from the NEXT_PUBLIC_TENANT_ID
 * env var, then 'rxfit'. It deliberately does NOT read a client-supplied
 * `x-tenant-id` request header (see getTenantId below).
 *
 * IMPORTANT: server-only. Do not import from client components — client
 * code receives tenant config via TenantProvider props.
 */

export const FALLBACK_TENANT_ID = 'rxfit'


/**
 * Resolve the active tenant ID for the current request.
 *
 * SECURITY: this intentionally does NOT trust the `x-tenant-id` request header.
 * That header is client-controllable on any request, and middleware — which
 * strips it — does not cover every route (e.g. /api/chat, /api/webhooks are
 * excluded from the matcher). Trusting it would let a caller spoof a tenant and
 * cross tenant-isolation boundaries. Since nothing server-side legitimately
 * sets the header today, ignoring it is behavior-neutral: the app is
 * single-tenant and always resolves to the default tenant (rxfit).
 *
 * Phase 2 (multi-tenancy) will replace the return below with server-side
 * resolution derived from the authenticated session's tenantId claim and/or the
 * request hostname — NOT from an inbound client header.
 */
export function getTenantId(): string {
  return process.env.NEXT_PUBLIC_TENANT_ID || FALLBACK_TENANT_ID
}

/**
 * Resolve tenant ID outside of a request scope (cron jobs, scripts,
 * webhook handlers that derive tenant from payload/hostname instead).
 *
 * @deprecated Phase 2 multi-tenancy: callers should accept an explicit
 * `tenantId` parameter instead of relying on this env-var default.
 * The fallback to 'rxfit' is only correct for single-tenant deploys.
 */
export function getDefaultTenantId(): string {
  return process.env.NEXT_PUBLIC_TENANT_ID || FALLBACK_TENANT_ID
}
