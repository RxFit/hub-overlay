/**
 * In-session "recently completed" task tracking for the Tasks panel undo affordance.
 *
 * When a user taps a task's checkbox to complete it, the row is optimistically
 * hidden and the fetch (showCompleted=false) drops it from the list — so there is
 * no longer anything to tap to un-complete it. These pure helpers maintain a small,
 * local list of just-completed tasks so the panel can render an "Undo" control that
 * routes back through the existing uncomplete write path.
 *
 * Kept as pure functions (no React) so the list logic is unit-testable.
 */

export interface CompletedTaskEntry {
  id: string
  title: string
  listId: string
}

/** How many recently-completed entries to retain (newest first). */
export const MAX_RECENTLY_COMPLETED = 3

/**
 * Record a task as recently completed. Newest entries go first, any prior entry
 * for the same id is replaced (de-duped), and the list is capped so the undo
 * affordance never grows unbounded within a session.
 */
export function addRecentlyCompleted(
  list: CompletedTaskEntry[],
  entry: CompletedTaskEntry
): CompletedTaskEntry[] {
  const withoutDup = list.filter(e => e.id !== entry.id)
  return [entry, ...withoutDup].slice(0, MAX_RECENTLY_COMPLETED)
}

/** Remove a recently-completed entry by task id (e.g. after undo or timeout). */
export function removeRecentlyCompleted(
  list: CompletedTaskEntry[],
  id: string
): CompletedTaskEntry[] {
  return list.filter(e => e.id !== id)
}
