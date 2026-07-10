/**
 * hide-timers — a tiny keyed setTimeout registry used by the optimistic
 * task-completion flow (TasksSection).
 *
 * The bug it fixes: completing a task schedules a 1.5s timer that adds the row
 * to `hiddenIds` (the fade-out). If the write FAILS in under 1.5s, the failure
 * path rolls back `hiddenIds`/`fadingIds` — but the still-pending timer then
 * fires and re-hides the row, defeating the rollback. Capturing the handle here
 * (keyed by task id) lets the failure path `cancel()` the pending timer before
 * it can re-hide a row that was just restored.
 */
export interface HideTimers {
  /** Schedule `fn` after `ms`, keyed by `id`. Replaces any pending timer for `id`. */
  schedule(id: string, fn: () => void, ms: number): void
  /** Cancel a pending timer for `id`. Returns true if one was cancelled. */
  cancel(id: string): boolean
  /** Cancel every pending timer (e.g. when switching task lists / unmounting). */
  clearAll(): void
  /** Whether a timer is currently pending for `id`. */
  has(id: string): boolean
}

export function createHideTimers(): HideTimers {
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  return {
    schedule(id, fn, ms) {
      const existing = timers.get(id)
      if (existing) clearTimeout(existing)
      const handle = setTimeout(() => {
        // Self-evict before firing so `has(id)` is accurate inside `fn`.
        timers.delete(id)
        fn()
      }, ms)
      timers.set(id, handle)
    },
    cancel(id) {
      const handle = timers.get(id)
      if (handle === undefined) return false
      clearTimeout(handle)
      timers.delete(id)
      return true
    },
    clearAll() {
      for (const handle of timers.values()) clearTimeout(handle)
      timers.clear()
    },
    has(id) {
      return timers.has(id)
    },
  }
}
