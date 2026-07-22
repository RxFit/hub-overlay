/**
 * Focus Preferences — DB access (SERVER-ONLY).
 *
 * Split out of lib/focus-preferences.ts (which stays pure and client-safe) so
 * importing the constants/types into a client component never drags the
 * Postgres driver into the browser bundle.
 *
 * Reads are FAIL-OPEN: any error — or no DATABASE_URL at all — resolves to
 * EMPTY_FOCUS_PREFERENCES, so the Focus ranker degrades to its pre-feature
 * behavior instead of failing the request. Writes DO throw so the PUT route can
 * report an honest failure.
 */

import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { focusPreferences, tenants } from './schema'
import { getTenantId } from './tenant-context'
import {
  normalizeFocusPreferences,
  EMPTY_FOCUS_PREFERENCES,
  type FocusPreferences,
} from './focus-preferences'

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: 'RxFit Athletics' }).onConflictDoNothing()
}

/**
 * Read a user's Focus preferences. FAIL-OPEN: returns EMPTY_FOCUS_PREFERENCES
 * on a missing row, a DB error, or no DATABASE_URL.
 */
export async function getFocusPreferences(
  email: string,
  tenantId = getTenantId(),
): Promise<FocusPreferences> {
  const normalized = email.toLowerCase().trim()
  try {
    const [row] = await db
      .select()
      .from(focusPreferences)
      .where(and(eq(focusPreferences.tenantId, tenantId), eq(focusPreferences.email, normalized)))
      .limit(1)
    if (!row) return EMPTY_FOCUS_PREFERENCES
    // Re-normalize on read: a row written before a validation change (or by a
    // future client) can't feed malformed data into the prompt/heuristic.
    return normalizeFocusPreferences({ vips: row.vips, goals: row.goals })
  } catch (err) {
    console.error('[focus-preferences] getFocusPreferences failed (fail-open):', err)
    return EMPTY_FOCUS_PREFERENCES
  }
}

/**
 * Upsert a user's Focus preferences. Throws on a DB error so the PUT route can
 * surface a real failure — a silent "saved" that didn't persist is worse.
 */
export async function upsertFocusPreferences(
  email: string,
  prefs: FocusPreferences,
  tenantId = getTenantId(),
): Promise<FocusPreferences> {
  const normalized = email.toLowerCase().trim()
  const clean = normalizeFocusPreferences(prefs)
  await ensureTenant(tenantId)
  await db
    .insert(focusPreferences)
    .values({ tenantId, email: normalized, vips: clean.vips, goals: clean.goals })
    .onConflictDoUpdate({
      target: [focusPreferences.tenantId, focusPreferences.email],
      set: { vips: clean.vips, goals: clean.goals, updatedAt: new Date() },
    })
  return clean
}
