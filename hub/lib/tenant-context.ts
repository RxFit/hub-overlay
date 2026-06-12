/**
 * Server-side tenant resolution — single source of truth.
 *
 * Phase 0 (current): resolves from the `x-tenant-id` request header when
 * present (set by middleware in Phase 1), falling back to the
 * NEXT_PUBLIC_TENANT_ID env var, then 'rxfit'.
 *
 * Phase 1 will make the header the primary path (derived from the request
 * hostname) and cross-check it against the session's tenantId claim.
 *
 * IMPORTANT: server-only. Do not import from client components — client
 * code receives tenant config via TenantProvider props.
 */

import { headers } from 'next/headers'

export const FALLBACK_TENANT_ID = 'rxfit'

/**
 * Resolve the active tenant ID for the current request.
 *
 * Safe to call from route handlers and server components. Outside a request
 * scope (build time, scripts, cron), `headers()` throws — we catch and fall
 * back to the env default.
 */
export function getTenantId(): string {
  try {
    const headerTenant = headers().get('x-tenant-id')
    if (headerTenant) return headerTenant
  } catch {
    // Not in a request scope (build/static generation/script) — use env.
  }
  return process.env.NEXT_PUBLIC_TENANT_ID || FALLBACK_TENANT_ID
}

/**
 * Resolve tenant ID outside of a request scope (cron jobs, scripts,
 * webhook handlers that derive tenant from payload/hostname instead).
 */
export function getDefaultTenantId(): string {
  return process.env.NEXT_PUBLIC_TENANT_ID || FALLBACK_TENANT_ID
}
