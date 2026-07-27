/**
 * Durable Google refresh-token store (SERVER-ONLY).
 *
 * WHY THIS EXISTS
 * ---------------
 * The Google refresh token used to live in exactly one place: the NextAuth JWT
 * session cookie. That made offline access as fragile as a cookie —
 * signing out, switching browsers, opening the Hub on a phone, clearing site
 * data or letting the session lapse all destroyed the only copy, and the sole
 * recovery path was a full interactive OAuth consent round-trip. That is the
 * mechanism behind "many forced relogins".
 *
 * Persisting the refresh token server-side breaks that coupling. A fresh
 * sign-in that Google completes SILENTLY (because the grant is already on file,
 * so no `refresh_token` comes back in the token response) can still recover
 * offline access by reading the stored copy.
 *
 * SECURITY
 * --------
 * A refresh token is a long-lived bearer credential for the user's Google
 * account. Accordingly:
 *   - every export here is server-only and is never imported by a client
 *     component or returned from an API route;
 *   - token VALUES are never logged — failures log the operation and the error,
 *     and callers log at most a boolean;
 *   - reads/writes are scoped by (tenant, email), matching every other
 *     per-user table;
 *   - every function is FAIL-SOFT. The JWT remains the primary carrier of the
 *     refresh token, so a DB outage degrades this to exactly the pre-existing
 *     behavior rather than breaking authentication.
 */

import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { googleOauthTokens, tenants } from './schema'
import { getTenantId } from './tenant-context'

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: 'RxFit Athletics' }).onConflictDoNothing()
}

/**
 * Persist a refresh token for a user. No-ops on a falsy token so callers can
 * pass `account.refresh_token` straight through without a guard (Google omits
 * it on silent re-authorization). Never throws: a failed write must not break
 * a sign-in that is otherwise fine.
 *
 * @returns true when a token was actually stored.
 */
export async function storeGoogleRefreshToken(
  email: string,
  refreshToken: string | undefined | null,
  scope?: string | null,
  tenantId = getTenantId(),
): Promise<boolean> {
  const normalized = (email || '').toLowerCase().trim()
  if (!normalized || !refreshToken) return false
  try {
    await ensureTenant(tenantId)
    await db
      .insert(googleOauthTokens)
      .values({ tenantId, email: normalized, refreshToken, scope: scope ?? null })
      .onConflictDoUpdate({
        target: [googleOauthTokens.tenantId, googleOauthTokens.email],
        set: { refreshToken, scope: scope ?? null, updatedAt: new Date() },
      })
    return true
  } catch (err) {
    // Fail-soft: the JWT still carries the token for this session.
    console.error('[google-token-store] store failed (non-fatal):', err)
    return false
  }
}

/**
 * Read the stored refresh token for a user, or null when there is none (or the
 * DB is unreachable). Never throws.
 */
export async function getGoogleRefreshToken(
  email: string,
  tenantId = getTenantId(),
): Promise<string | null> {
  const normalized = (email || '').toLowerCase().trim()
  if (!normalized) return null
  try {
    const [row] = await db
      .select({ refreshToken: googleOauthTokens.refreshToken })
      .from(googleOauthTokens)
      .where(and(eq(googleOauthTokens.tenantId, tenantId), eq(googleOauthTokens.email, normalized)))
      .limit(1)
    return row?.refreshToken ?? null
  } catch (err) {
    console.error('[google-token-store] read failed (fail-open):', err)
    return null
  }
}

/**
 * Delete a user's stored refresh token.
 *
 * Called when Google itself reports the grant is dead (`invalid_grant`), so a
 * revoked/expired token is not handed to the next refresh attempt forever.
 * Never throws.
 */
export async function clearGoogleRefreshToken(
  email: string,
  tenantId = getTenantId(),
): Promise<void> {
  const normalized = (email || '').toLowerCase().trim()
  if (!normalized) return
  try {
    await db
      .delete(googleOauthTokens)
      .where(and(eq(googleOauthTokens.tenantId, tenantId), eq(googleOauthTokens.email, normalized)))
  } catch (err) {
    console.error('[google-token-store] clear failed (non-fatal):', err)
  }
}
