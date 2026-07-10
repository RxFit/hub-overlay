/**
 * Protected Paperclip workspaces (companies) — single source of truth.
 *
 * Some Paperclip companies are load-bearing: the app pins their IDs and depends
 * on them for orchestration and issue routing. Deleting one cascades to its
 * agents / issues / runs and is irreversible, so deletion of these workspaces
 * MUST be refused server-side (see the proxy DELETE handler and
 * `deleteCompany` in lib/paperclip.ts). This module collects the protected IDs
 * from every source so the enforcement logic has one list to consult.
 *
 * Sources (all collected LAZILY, at call time, so runtime-injected env works):
 *  - `paperclipConfig`: RXFIT_COMPANY_ID (RxFit Enterprise) and
 *    RXFIT_CEO_COMPANY_ID (the CEO workspace / issue-routing target).
 *  - `process.env.DEFAULT_PAPERCLIP_COMPANY_ID`: the issue-routing fallback
 *    (app/api/paperclip/issues/route.ts). Deleting it breaks issue creation.
 *  - `process.env.PROTECTED_COMPANY_IDS`: an optional, comma-separated list so
 *    ops can pin additional workspaces (e.g. the SEO Agent workspace) WITHOUT
 *    a code change / deploy.
 *
 * IDs are compared case-INSENSITIVELY (normalized to trimmed lowercase):
 * Postgres resolves UUIDs case-insensitively, so `/api/companies/<UPPER-UUID>`
 * targets the same row as its lowercase form — matching case-sensitively would
 * let an uppercase-UUID delete bypass the guard (mirrors the proxy-authz fix).
 */

import { RXFIT_COMPANY_ID, RXFIT_CEO_COMPANY_ID } from '@/lib/paperclipConfig'

/** Normalize a company id for case-insensitive comparison (trim + lowercase). */
export function normalizeCompanyId(id: string | null | undefined): string {
  return (id ?? '').trim().toLowerCase()
}

/**
 * The set of protected (undeletable) company IDs, normalized to trimmed
 * lowercase. Recomputed on every call so runtime-injected env vars are honored.
 * Empty / undefined entries are filtered out, so an unset env var never adds
 * `''` to the set.
 */
export function getProtectedCompanyIds(): Set<string> {
  const raw: Array<string | undefined> = [
    RXFIT_COMPANY_ID,
    RXFIT_CEO_COMPANY_ID,
    process.env.DEFAULT_PAPERCLIP_COMPANY_ID,
    ...(process.env.PROTECTED_COMPANY_IDS ?? '').split(','),
  ]

  const ids = new Set<string>()
  for (const value of raw) {
    const normalized = normalizeCompanyId(value)
    if (normalized) ids.add(normalized)
  }
  return ids
}

/**
 * True when `id` refers to a protected workspace that must never be deleted.
 * Case-insensitive and whitespace-tolerant.
 */
export function isProtectedCompany(id: string | null | undefined): boolean {
  const normalized = normalizeCompanyId(id)
  if (!normalized) return false
  return getProtectedCompanyIds().has(normalized)
}
