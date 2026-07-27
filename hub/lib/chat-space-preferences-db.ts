/**
 * Chat space visibility preferences — DB access (SERVER-ONLY).
 *
 * Split out of lib/chat-spaces.ts (which stays pure and client-safe) so
 * importing the classification helpers into a client component never drags the
 * Postgres driver into the browser bundle. Mirrors lib/focus-preferences-db.ts.
 *
 * Reads are FAIL-OPEN: any error — or no DATABASE_URL at all — resolves to
 * EMPTY_CHAT_SPACE_PREFERENCES, so the Chat panel degrades to the default rule
 * (named spaces only) instead of failing the request. Writes DO throw so the
 * PUT route can report an honest failure: a silent "saved" that did not persist
 * is exactly the bug this feature exists to fix.
 */

import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { chatSpacePreferences, tenants } from './schema'
import { getTenantId } from './tenant-context'
import {
  normalizeChatSpacePreferences,
  EMPTY_CHAT_SPACE_PREFERENCES,
  type ChatSpacePreferences,
} from './chat-spaces'

async function ensureTenant(tenantId: string): Promise<void> {
  await db.insert(tenants).values({ id: tenantId, name: 'RxFit Athletics' }).onConflictDoNothing()
}

/**
 * Read a user's chat space preferences. FAIL-OPEN: returns
 * EMPTY_CHAT_SPACE_PREFERENCES on a missing row, a DB error, or no DATABASE_URL.
 */
export async function getChatSpacePreferences(
  email: string,
  tenantId = getTenantId(),
): Promise<ChatSpacePreferences> {
  const normalized = email.toLowerCase().trim()
  try {
    const [row] = await db
      .select()
      .from(chatSpacePreferences)
      .where(and(eq(chatSpacePreferences.tenantId, tenantId), eq(chatSpacePreferences.email, normalized)))
      .limit(1)
    if (!row) return EMPTY_CHAT_SPACE_PREFERENCES
    // Re-normalize on read: a row written before a validation change (or by a
    // future client) can't feed malformed names into the visibility filter.
    return normalizeChatSpacePreferences({ shown: row.shown, hidden: row.hidden })
  } catch (err) {
    console.error('[chat-space-preferences] read failed (fail-open):', err)
    return EMPTY_CHAT_SPACE_PREFERENCES
  }
}

/**
 * Upsert a user's chat space preferences. Throws on a DB error so the PUT route
 * can surface a real failure.
 */
export async function upsertChatSpacePreferences(
  email: string,
  prefs: ChatSpacePreferences,
  tenantId = getTenantId(),
): Promise<ChatSpacePreferences> {
  const normalized = email.toLowerCase().trim()
  const clean = normalizeChatSpacePreferences(prefs)
  await ensureTenant(tenantId)
  await db
    .insert(chatSpacePreferences)
    .values({ tenantId, email: normalized, shown: clean.shown, hidden: clean.hidden })
    .onConflictDoUpdate({
      target: [chatSpacePreferences.tenantId, chatSpacePreferences.email],
      set: { shown: clean.shown, hidden: clean.hidden, updatedAt: new Date() },
    })
  return clean
}
