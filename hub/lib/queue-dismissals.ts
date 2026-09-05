import { and, eq } from 'drizzle-orm'
import { db } from './db'
import { queueDismissals } from './schema'

/**
 * lib/queue-dismissals.ts — the per-user overlay behind "Dismiss" on the
 * needs-you queue (Phase 4 PR 2).
 *
 * The queue is DERIVED from ledgers that are provenance (ai_runs,
 * ai_action_log, tool_runs, event_log); dismissing an item must not mutate
 * them. So a dismissal is one row keyed by the item's stable key
 * ('run:<id>', 'action:<id>', 'deep:<id>', 'alert:<id>'), scoped to the
 * caller. Undo deletes the row. Keys are validated at the route boundary
 * (ITEM_KEY_RE) so the table can never hold free text.
 */

export const ITEM_KEY_RE = /^(run|action|deep|alert):[A-Za-z0-9-]{1,64}$/

export function isItemKey(v: unknown): v is string {
  return typeof v === 'string' && ITEM_KEY_RE.test(v)
}

function norm(email: string): string {
  return email.toLowerCase().trim()
}

export async function listDismissedKeys(tenantId: string, userEmail: string): Promise<Set<string>> {
  const rows = await db
    .select({ key: queueDismissals.itemKey })
    .from(queueDismissals)
    .where(and(eq(queueDismissals.tenantId, tenantId), eq(queueDismissals.userEmail, norm(userEmail))))
  return new Set(rows.map((r) => r.key))
}

/** Idempotent: dismissing an already-dismissed key is a no-op. */
export async function dismissItem(tenantId: string, userEmail: string, itemKey: string): Promise<void> {
  await db
    .insert(queueDismissals)
    .values({ tenantId, userEmail: norm(userEmail), itemKey })
    .onConflictDoNothing()
}

/** Idempotent: undoing a key that was never dismissed is a no-op. */
export async function undismissItem(tenantId: string, userEmail: string, itemKey: string): Promise<void> {
  await db
    .delete(queueDismissals)
    .where(and(
      eq(queueDismissals.tenantId, tenantId),
      eq(queueDismissals.userEmail, norm(userEmail)),
      eq(queueDismissals.itemKey, itemKey),
    ))
}
