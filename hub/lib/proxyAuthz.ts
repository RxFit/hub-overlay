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
 * role tier. The ONLY staff-tier write is issue creation (POST /api/issues);
 * every other, unrecognized write fails CLOSED at `admin` so onboarding — and
 * even staff — cannot mutate anything the table does not explicitly permit.
 *
 * SECURITY (P0): the resource path is matched case-INSENSITIVELY. Postgres
 * compares UUIDs case-insensitively, so `/api/companies/<UPPERCASE-UUID>`
 * resolves the very same row upstream as its lowercase form. When these matchers
 * were case-sensitive (`[a-f0-9-]`), an uppercase-UUID mutation matched NONE of
 * the specific rules below and fell through to the old `staff` default —
 * a live privilege escalation (a scoped staff user could DELETE a workspace).
 * We canonicalize to lowercase before matching AND fail closed on the fallthrough.
 */
export function requiredWriteRank(method: string, apiPath: string): number {
  const m = method.toUpperCase()
  if (m === 'GET' || m === 'HEAD') return 0

  // Canonicalize for authz matching only — the caller forwards the original path.
  const path = apiPath.toLowerCase()

  const isAgentResource = /^\/api\/agents\/[a-f0-9-]+$/.test(path)
  const isCompanyResource = /^\/api\/companies\/[a-f0-9-]+$/.test(path)
  const isIssueResource = /^\/api\/issues\/[a-f0-9-]+$/.test(path)
  const isAgentCreate =
    m === 'POST' &&
    (path === '/api/agents' || /^\/api\/companies\/[a-f0-9-]+\/agents$/.test(path))
  const isCompanyCreate = m === 'POST' && path === '/api/companies'

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

  // Sole staff-tier write: issue creation (create_paperclip_issue /
  // send_communication). POST /api/issues is additionally gated by the
  // server-side quality-gate token. Matched EXPLICITLY so the fallthrough below
  // can fail closed instead of blanket-allowing every unlisted write to staff.
  if (m === 'POST' && path === '/api/issues') return ROLE_RANK.staff

  // Fail closed: any other (unrecognized) write requires admin. Previously this
  // defaulted to `staff`, which — combined with the case-sensitive matchers
  // above — let an uppercase-UUID DELETE/PATCH escalate to a staff-allowed write.
  return ROLE_RANK.admin
}

/** True when a user with `role` may perform `method` on `apiPath`. */
export function canWrite(role: string, method: string, apiPath: string): boolean {
  const required = requiredWriteRank(method, apiPath)
  return (ROLE_RANK[role] ?? 0) >= required
}
