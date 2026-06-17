/**
 * Paperclip proxy authorization table (P0-1).
 *
 * Role gating previously lived ONLY client-side (page.tsx `hasPermission`) and
 * in the proxy's DELETE handler. A scoped `staff` user could therefore call
 * PATCH/POST directly to perform admin-tier actions (reassign issues,
 * restart/create agents). This module is the server-side source of truth and
 * mirrors INTENT_PERMISSIONS / ROLE_HIERARCHY in lib/interview.ts.
 *
 * Kept separate from the route module so it can be unit-tested without spinning
 * up the Next.js request pipeline.
 */

/** Role hierarchy ranks (mirrors ROLE_HIERARCHY in lib/interview.ts). */
export const ROLE_RANK: Record<string, number> = {
  onboarding: 0,
  staff: 1,
  admin: 2,
  superadmin: 3,
}

/**
 * Minimum role rank required for a mutation against `apiPath`.
 *
 * Reads (GET/HEAD) return 0 — they are governed by company-scope checks, not
 * role tier. Any write not otherwise listed requires at least `staff`, so
 * onboarding users cannot mutate anything.
 */
export function requiredWriteRank(method: string, apiPath: string): number {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return 0

  const isAgentResource = /^\/api\/agents\/[a-f0-9-]+$/.test(apiPath)
  const isCompanyResource = /^\/api\/companies\/[a-f0-9-]+$/.test(apiPath)
  const isIssueResource = /^\/api\/issues\/[a-f0-9-]+$/.test(apiPath)
  const isAgentCreate =
    m === 'POST' &&
    (apiPath === '/api/agents' || /^\/api\/companies\/[a-f0-9-]+\/agents$/.test(apiPath))
  const isCompanyCreate = m === 'POST' && apiPath === '/api/companies'

  // delete_agent → superadmin (intent map). Tightened from the prior admin-level
  // gate, which contradicted INTENT_PERMISSIONS.delete_agent (audit P1-6).
  if (m === 'DELETE' && isAgentResource) return ROLE_RANK.superadmin
  // delete_workspace → admin
  if (m === 'DELETE' && isCompanyResource) return ROLE_RANK.admin
  // issue deletion → admin (no staff-tier delete-issue intent exists)
  if (m === 'DELETE' && isIssueResource) return ROLE_RANK.admin
  // assign_issue / update_issue_state → admin
  if (m === 'PATCH' && isIssueResource) return ROLE_RANK.admin
  // restart_agent → admin
  if (m === 'PATCH' && isAgentResource) return ROLE_RANK.admin
  // create_agent → admin
  if (isAgentCreate) return ROLE_RANK.admin
  // workspace/company creation via proxy → admin
  if (isCompanyCreate) return ROLE_RANK.admin

  // All other writes (notably POST /api/issues = create_paperclip_issue /
  // send_communication) → staff. POST /api/issues is additionally gated by the
  // server-side quality-gate token.
  return ROLE_RANK.staff
}

/** True when a user with `role` may perform `method` on `apiPath`. */
export function canWrite(role: string, method: string, apiPath: string): boolean {
  const required = requiredWriteRank(method, apiPath)
  return (ROLE_RANK[role] ?? 0) >= required
}
