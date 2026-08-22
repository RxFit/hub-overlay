/**
 * Hub-owned storage for operator-managed third-party credentials.
 *
 * Replaces the Paperclip Secrets API proxy that /api/settings/keys used to be
 * (Phase 3 PR 1). The security contract carried over from that route:
 *
 *   - admin / superadmin: full CRUD within their assigned workspaces
 *   - staff:              key NAMES and metadata only, never values
 *   - onboarding:         no access
 *   - secret VALUES are never returned to the browser, by any path
 *
 * This module deliberately lives outside app/api/settings/keys/route.ts. A
 * `route.ts` may export only HTTP method handlers plus Next's config
 * allowlist; exporting a testable helper from there passes `tsc` and `vitest`
 * and then fails `next build` (see the Build step in .github/workflows/ci.yml).
 * Keeping the logic here is what makes it testable at all.
 */
import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { hubSecrets } from './schema'
import { getTenantId } from './tenant-context'
import { encryptSecret, decryptSecret, encryptionConfigured } from './secret-crypto'

/** Postgres "relation does not exist" — the migration has not run yet. */
export function isMissingTableError(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '42P01'
}

/** Unique-violation on (tenant, company, name). */
function isUniqueViolation(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === '23505'
}

/**
 * Key names the Hub refuses to manage: rotating one of these through the
 * settings UI would compromise the Hub itself rather than a third party.
 * Carried over verbatim from the Paperclip-era route.
 */
export const BLOCKED_KEY_NAMES: readonly string[] = [
  'RAILWAY_TOKEN',
  'VERCEL_TOKEN',
  'NEXTAUTH_SECRET',
  'PAPERCLIP_MASTER_KEY',
  // Added with Hub-owned storage: naming the at-rest key here would let an
  // operator overwrite the key that seals every other row.
  'SECRET_ENCRYPTION_KEY',
  'SECRET_ENCRYPTION_KEYS_PREVIOUS',
  'DATABASE_URL',
]

export const KEY_NAME_RE = /^[A-Z][A-Z0-9_]*$/

export interface SessionLike {
  role?: string
  assignedProjects?: string[]
}

/**
 * Which workspace this request may act on, or null when it may not.
 *
 * DELIBERATE CONTRACT CHANGE from the Paperclip route (route.ts:25-52). That
 * version, when a non-superadmin asked for a workspace they were not assigned,
 * silently fell back to `assignedProjects[0]` and returned 200. Against a
 * remote store that merely mis-filed the write; against Hub-owned storage it
 * is worse — the row lands under the wrong workspace, the UI re-queries by the
 * workspace the operator actually selected, sees nothing, and they save again.
 * Duplicates accumulate under a workspace nobody is looking at.
 *
 * An unauthorized workspace is now refused instead of quietly redirected.
 */
export function resolveWorkspaceId(
  session: SessionLike,
  requestedId?: string,
): string | null {
  const role = session.role ?? ''
  const projects = session.assignedProjects ?? []
  const fallback = process.env.DEFAULT_PAPERCLIP_COMPANY_ID || ''

  if (role === 'superadmin') return requestedId || fallback || null

  const wildcard = projects.includes('*')
  if (requestedId) {
    if (wildcard || projects.includes(requestedId)) return requestedId
    return null // asked for something they do not hold — refuse, never redirect
  }

  if (wildcard) return fallback || null
  // `||` not `??`: DEFAULT_PAPERCLIP_COMPANY_ID defaults to '' when unset, and
  // an empty workspace id must read as "none", not as a workspace.
  return projects[0] || fallback || null
}

/** Metadata safe to return to a browser. Contains no secret material. */
export interface SecretMeta {
  id: string
  name: string
  key: string
  provider: string | null
  status: string
  latestVersion: number
  lastRotatedAt: string | null
  createdAt: string
  maskedHint: string
}

function toMeta(row: typeof hubSecrets.$inferSelect): SecretMeta {
  return {
    id: row.id,
    // `name` and `key` were distinct fields in Paperclip's payload; the UI
    // matches on `name`. Both are populated so the contract is unchanged.
    name: row.name,
    key: row.name,
    provider: row.provider ?? null,
    status: 'active',
    latestVersion: 1,
    lastRotatedAt: row.updatedAt?.toISOString() ?? null,
    createdAt: row.createdAt?.toISOString() ?? new Date().toISOString(),
    maskedHint: '••••',
  }
}

/** True when credential storage is usable at all (encryption key present). */
export function storageConfigured(): boolean {
  return encryptionConfigured()
}

/** List a workspace's credentials as METADATA ONLY. Never returns values. */
export async function listSecrets(companyId: string): Promise<SecretMeta[]> {
  const tenantId = getTenantId()
  try {
    const rows = await db
      .select()
      .from(hubSecrets)
      .where(and(eq(hubSecrets.tenantId, tenantId), eq(hubSecrets.companyId, companyId)))
    return rows.map(toMeta)
  } catch (err) {
    // Migration has not run yet: an empty list is honest and keeps the
    // settings page rendering, rather than 500ing behind a generic banner.
    if (isMissingTableError(err)) return []
    throw err
  }
}

export type CreateOutcome =
  | { ok: true; secret: SecretMeta }
  | { ok: false; reason: 'invalid_name' | 'blocked' | 'duplicate' | 'not_configured' }

/** Store (or re-seal) one credential. The plaintext never leaves this call. */
export async function putSecret(input: {
  companyId: string
  name: string
  value: string
  provider?: string | null
  createdBy?: string | null
}): Promise<CreateOutcome> {
  const name = input.name.trim()
  if (!KEY_NAME_RE.test(name)) return { ok: false, reason: 'invalid_name' }
  if (BLOCKED_KEY_NAMES.includes(name)) return { ok: false, reason: 'blocked' }
  if (!encryptionConfigured()) return { ok: false, reason: 'not_configured' }

  const { envelope, keyId } = encryptSecret(input.value)
  const tenantId = getTenantId()

  try {
    const [row] = await db
      .insert(hubSecrets)
      .values({
        tenantId,
        companyId: input.companyId,
        name,
        ciphertext: envelope,
        keyId,
        provider: input.provider ?? null,
        createdBy: input.createdBy ?? null,
      })
      // Re-entering a key is a rotation, not an error: overwrite in place and
      // re-stamp key_id so the row reflects the key it is actually sealed under.
      .onConflictDoUpdate({
        target: [hubSecrets.tenantId, hubSecrets.companyId, hubSecrets.name],
        set: { ciphertext: envelope, keyId, updatedAt: new Date() },
      })
      .returning()
    return { ok: true, secret: toMeta(row) }
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: 'duplicate' }
    throw err
  }
}

/**
 * Delete by id, scoped to the caller's workspace in the same statement.
 *
 * The Paperclip route did this as a read-then-delete: list the workspace's
 * secrets, check the id appears, then delete. Scoping the DELETE itself is
 * both cheaper and not racy — an id belonging to another workspace matches
 * zero rows and reports not-found, so ids remain non-enumerable.
 */
export async function deleteSecret(id: string, companyId: string): Promise<boolean> {
  const tenantId = getTenantId()
  try {
    const deleted = await db
      .delete(hubSecrets)
      .where(
        and(
          eq(hubSecrets.id, id),
          eq(hubSecrets.tenantId, tenantId),
          eq(hubSecrets.companyId, companyId),
        ),
      )
      .returning({ id: hubSecrets.id })
    return deleted.length > 0
  } catch (err) {
    if (isMissingTableError(err)) return false
    throw err
  }
}

/**
 * Decrypt one credential for SERVER-SIDE use.
 *
 * No API route calls this and none should — the browser contract is
 * write-only. It exists so the stored value is actually usable by a future
 * server-side consumer (Phase 4 tooling briefing an `agy` run), and so the
 * encryption is round-trip testable rather than write-only by construction.
 */
export async function getSecretValue(name: string, companyId: string): Promise<string | null> {
  const tenantId = getTenantId()
  const [row] = await db
    .select()
    .from(hubSecrets)
    .where(
      and(
        eq(hubSecrets.tenantId, tenantId),
        eq(hubSecrets.companyId, companyId),
        eq(hubSecrets.name, name),
      ),
    )
    .limit(1)
  if (!row) return null
  return decryptSecret(row.ciphertext)
}
